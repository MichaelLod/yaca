#!/usr/bin/env node
/**
 * YACA daemon — v0.1.0
 *
 * Single Baileys connection, fanout to N Claude Code sessions via Unix socket.
 * Solves WhatsApp's 4-linked-device cap when running multiple Claude terminals.
 *
 * Architecture:
 *   Phone  ↔  Baileys  ↔  src/daemon.cjs  ↔  /tmp/yaca.sock  ↔  N x src/mcp-client.cjs  ↔  MCP stdio  ↔  N x Claude Code
 *
 * Connection stability (OpenClaw-derived patterns, tuned for 24/7 operation):
 *   - 515 is a normal restart, reconnect in 2s
 *   - 440 (conflict) / 401 (logout) stop permanently
 *   - Exponential backoff with jitter, reset after healthy period
 *   - Watchdog detects stale connections
 *   - Creds backup/restore
 */

const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn: spawnProcess } = require("child_process");

// Load .env.local from this repo (working directory). Tiny parser — no
// dotenv dep. Existing process.env wins (so launchd/shell can override).
function loadDotEnv(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[m[1]] = val;
  }
}
loadDotEnv(path.join(__dirname, "..", ".env.local"));
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const dailyLog = require("./memory/daily-log.cjs");
const orchestrator = require("./orchestrator.cjs");

// ── Config ──────────────────────────────────────────────────────────

const STATE_DIR = process.env.YACA_STATE_DIR || path.join(os.homedir(), ".yaca");
const ACCESS_FILE = path.join(STATE_DIR, "access.json");
const AUTH_DIR = path.join(STATE_DIR, "auth");
const INBOX_DIR = path.join(STATE_DIR, "inbox");
const LOG_FILE = path.join(STATE_DIR, "daemon.log");
const PID_FILE = path.join(STATE_DIR, "daemon.pid");
const PANIC_FILE = path.join(STATE_DIR, "PANIC");
const SOCKET_PATH = process.env.YACA_SOCKET || "/tmp/yaca.sock";
const WORK_ROOT = process.env.YACA_WORK_ROOT || path.join(os.homedir(), "Work");

fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(INBOX_DIR, { recursive: true });
try { fs.chmodSync(STATE_DIR, 0o700); } catch {}

const logger = pino({ level: "silent" });

const logStream = (() => {
  try { return fs.createWriteStream(LOG_FILE, { flags: "a" }); } catch { return null; }
})();

function log(msg) {
  const line = `${new Date().toISOString()} [daemon] ${msg}\n`;
  if (logStream) logStream.write(line);
  process.stderr.write(line);
}

// Permission-reply spec from claude-cli-internal channelPermissions.ts
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

const RECONNECT = { initialMs: 2000, maxMs: 30000, factor: 1.8, jitter: 0.25 };
const WATCHDOG_INTERVAL = 60 * 1000;
const STALE_TIMEOUT = 30 * 60 * 1000;
const HEALTHY_THRESHOLD = 60 * 1000;

const OUTBOUND_TRACK_TTL = 60 * 60 * 1000;
const PERMISSION_TTL = 10 * 60 * 1000;
const OUTBOUND_RATE_MAX = 20;
const OUTBOUND_RATE_WINDOW = 60 * 1000;

// ── Singleton lock ──────────────────────────────────────────────────

function acquirePidLock() {
  try {
    const existing = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    if (existing && existing !== process.pid) {
      try {
        process.kill(existing, 0);
        log(`daemon already running (pid ${existing}) — exiting`);
        process.exit(0);
      } catch {
        // stale pid, fall through
      }
    }
  } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o644 });
}

// ── Access Control ──────────────────────────────────────────────────

function defaultAccess() {
  return { allowFrom: [], allowGroups: false, allowedGroups: [], requireAllowFromInGroups: false, confirmToken: null };
}

function loadAccess() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8"));
    return { ...defaultAccess(), ...parsed };
  } catch (err) {
    if (err.code === "ENOENT") return defaultAccess();
    try { fs.renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`); } catch {}
    return defaultAccess();
  }
}

function toJid(phone) {
  if (phone.includes("@")) return phone;
  return `${phone.replace(/[^0-9]/g, "")}@s.whatsapp.net`;
}

// Baileys 7 routes 1:1 chats via @lid (privacy) rather than the phone-number
// JID. Baileys persists the mapping as lid-mapping-<lid>_reverse.json → "<phone>".
// Given a JID, return the set of equivalent JIDs we should match against the
// allowlist (phone-number form + LID form).
function resolveJidAliases(jid) {
  const out = new Set([jid]);
  const bare = jid.split("@")[0].split(":")[0];
  if (jid.endsWith("@lid")) {
    try {
      const phone = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, `lid-mapping-${bare}_reverse.json`), "utf8"));
      if (phone) out.add(`${phone}@s.whatsapp.net`);
    } catch {}
  } else if (jid.endsWith("@s.whatsapp.net")) {
    try {
      const lid = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, `lid-mapping-${bare}.json`), "utf8"));
      if (lid) out.add(`${lid}@lid`);
    } catch {}
  }
  return out;
}

function isAllowed(jid, participant) {
  const access = loadAccess();
  const isGroup = jid.endsWith("@g.us");
  if (isGroup) {
    if (!access.allowGroups) return false;
    if (access.allowedGroups.length > 0 && !access.allowedGroups.includes(jid)) return false;
    if (access.requireAllowFromInGroups && participant) {
      const aliases = resolveJidAliases(participant);
      return access.allowFrom.some((a) => aliases.has(toJid(a)) || aliases.has(a));
    }
    return true;
  }
  if (access.allowFrom.length === 0) return true;
  const aliases = resolveJidAliases(jid);
  return access.allowFrom.some((a) => aliases.has(toJid(a)) || aliases.has(a));
}

// ── Path safety for outbound files ──────────────────────────────────

function assertSendable(f) {
  try {
    const real = fs.realpathSync(f);
    const stateReal = fs.realpathSync(STATE_DIR);
    const inbox = path.join(stateReal, "inbox");
    if (real.startsWith(stateReal + path.sep) && !real.startsWith(inbox + path.sep)) {
      throw new Error(`refusing to send channel state: ${f}`);
    }
  } catch (e) {
    if (e.message?.startsWith("refusing")) throw e;
  }
}

// ── Message caches ──────────────────────────────────────────────────

const rawMessages = new Map();
const RAW_MSG_CAP = 1000;
const recentMessages = new Map();
const MAX_RECENT = 100;
const seenMessages = new Map();
const SEEN_TTL = 20 * 60 * 1000;
const SEEN_MAX = 5000;

function isDuplicate(key) {
  if (seenMessages.has(key)) return true;
  seenMessages.set(key, Date.now());
  if (seenMessages.size > SEEN_MAX) {
    const now = Date.now();
    for (const [k, t] of seenMessages) if (now - t > SEEN_TTL) seenMessages.delete(k);
  }
  return false;
}

function storeRaw(msg) {
  const id = msg.key?.id;
  if (!id) return;
  rawMessages.set(id, msg);
  if (rawMessages.size > RAW_MSG_CAP) {
    const first = rawMessages.keys().next().value;
    if (first) rawMessages.delete(first);
  }
}

function storeRecent(chatId, entry) {
  if (!recentMessages.has(chatId)) recentMessages.set(chatId, []);
  const arr = recentMessages.get(chatId);
  arr.push(entry);
  if (arr.length > MAX_RECENT) arr.shift();
}

// ── Outbound msg_id → session mapping for quote-reply routing ───────

const outboundTracking = new Map(); // sent_msg_id → { sessionId, ts }

function trackOutbound(msgId, sessionId) {
  if (!msgId || !sessionId) return;
  outboundTracking.set(msgId, { sessionId, ts: Date.now() });
}

function lookupOutbound(msgId) {
  const entry = outboundTracking.get(msgId);
  if (!entry) return null;
  if (Date.now() - entry.ts > OUTBOUND_TRACK_TTL) { outboundTracking.delete(msgId); return null; }
  return entry.sessionId;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of outboundTracking) {
    if (now - v.ts > OUTBOUND_TRACK_TTL) outboundTracking.delete(k);
  }
}, 5 * 60 * 1000).unref();

// ── Pending permissions: request_id → session_id ────────────────────

const pendingPermissions = new Map(); // request_id → { sessionId, ts }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingPermissions) {
    if (now - v.ts > PERMISSION_TTL) pendingPermissions.delete(k);
  }
}, 60 * 1000).unref();

// ── Creds backup/restore ────────────────────────────────────────────

function maybeRestoreCredsFromBackup() {
  const credsPath = path.join(AUTH_DIR, "creds.json");
  const backupPath = path.join(AUTH_DIR, "creds.json.bak");
  try { JSON.parse(fs.readFileSync(credsPath, "utf8")); return; } catch {}
  try {
    JSON.parse(fs.readFileSync(backupPath, "utf8"));
    fs.copyFileSync(backupPath, credsPath);
    try { fs.chmodSync(credsPath, 0o600); } catch {}
    log("restored creds.json from backup");
  } catch {}
}

let credsSaveQueue = Promise.resolve();
let saveCreds = null;

function enqueueSaveCreds() {
  if (!saveCreds) return;
  credsSaveQueue = credsSaveQueue
    .then(() => {
      const credsPath = path.join(AUTH_DIR, "creds.json");
      const backupPath = path.join(AUTH_DIR, "creds.json.bak");
      try {
        JSON.parse(fs.readFileSync(credsPath, "utf8"));
        fs.copyFileSync(credsPath, backupPath);
        try { fs.chmodSync(backupPath, 0o600); } catch {}
      } catch {}
      return saveCreds();
    })
    .then(() => { try { fs.chmodSync(path.join(AUTH_DIR, "creds.json"), 0o600); } catch {} })
    .catch((err) => {
      log(`creds save error: ${err} — retrying in 1s`);
      setTimeout(enqueueSaveCreds, 1000);
    });
}

// ── Baileys connection ──────────────────────────────────────────────

let sock = null;
let connectionReady = false;
let retryCount = 0;
let connectedAt = 0;
let lastInboundAt = 0;
let watchdogTimer = null;

function computeDelay(attempt) {
  const base = Math.min(RECONNECT.initialMs * Math.pow(RECONNECT.factor, attempt), RECONNECT.maxMs);
  const jitter = base * RECONNECT.jitter * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

function cleanupSocket() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.end(undefined); } catch {}
    sock = null;
  }
  connectionReady = false;
  broadcastConnectionStatus(false);
}

async function connectWhatsApp() {
  cleanupSocket();
  maybeRestoreCredsFromBackup();

  const authState = await useMultiFileAuthState(AUTH_DIR);
  saveCreds = authState.saveCreds;
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: {
      creds: authState.state.creds,
      keys: makeCacheableSignalKeyStore(authState.state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ["Mac OS", "Safari", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async (key) => {
      const cached = rawMessages.get(key.id);
      if (cached?.message) return cached.message;
      return { conversation: "" };
    },
  });

  sock.ev.on("creds.update", enqueueSaveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true }, (code) => {
        log("scan QR code with WhatsApp > Linked Devices > Link a Device");
        process.stderr.write(code + "\n");
      });
    }

    if (connection === "close") {
      connectionReady = false;
      broadcastConnectionStatus(false);
      const reason = lastDisconnect?.error?.output?.statusCode;

      if (reason === 440) { log("session conflict (440) — re-link required"); return; }
      if (reason === DisconnectReason.loggedOut) { log("logged out (401) — re-pair needed"); return; }
      if (reason === 515) { log("WhatsApp restart (515) — reconnecting in 2s"); setTimeout(connectWhatsApp, 2000); return; }

      if (connectedAt && Date.now() - connectedAt > HEALTHY_THRESHOLD) retryCount = 0;
      if (retryCount >= 15) { log("max retries — waiting 5 min"); retryCount = 0; setTimeout(connectWhatsApp, 5 * 60 * 1000); return; }

      const delay = computeDelay(retryCount);
      retryCount++;
      log(`connection closed (${reason}), retry ${retryCount} in ${delay}ms`);
      setTimeout(connectWhatsApp, delay);
    }

    if (connection === "open") {
      connectionReady = true;
      connectedAt = Date.now();
      retryCount = 0;
      log("connected");
      broadcastConnectionStatus(true);
      if (watchdogTimer) clearInterval(watchdogTimer);
      watchdogTimer = setInterval(() => {
        if (!connectionReady) return;
        if (lastInboundAt && Date.now() - lastInboundAt > STALE_TIMEOUT) {
          log(`no messages in ${STALE_TIMEOUT / 60000}min — forcing reconnect`);
          connectWhatsApp();
        }
      }, WATCHDOG_INTERVAL);
    }
  });

  if (sock.ws && typeof sock.ws.on === "function") {
    sock.ws.on("error", (err) => log(`WebSocket error: ${err}`));
  }

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid) continue;
      if (jid.endsWith("@broadcast") || jid.endsWith("@status")) continue;
      const msgId = msg.key.id;
      const participant = msg.key.participant;
      if (msgId && isDuplicate(`${jid}:${msgId}`)) continue;
      if (!isAllowed(jid, participant || undefined)) continue;
      try { await sock.readMessages([msg.key]); } catch {}
      lastInboundAt = Date.now();
      storeRaw(msg);
      try { await handleInbound(msg, jid, participant || undefined); } catch (e) { log(`handleInbound error: ${e}`); }
    }
  });
}

// ── Message helpers ─────────────────────────────────────────────────

function extractText(msg) {
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    ""
  );
}

function extractMediaInfo(msg) {
  if (msg.imageMessage) return { type: "image", mimetype: msg.imageMessage.mimetype || "image/jpeg", size: Number(msg.imageMessage.fileLength) || 0 };
  if (msg.videoMessage) return { type: "video", mimetype: msg.videoMessage.mimetype || "video/mp4", size: Number(msg.videoMessage.fileLength) || 0 };
  if (msg.audioMessage) return { type: "audio", mimetype: msg.audioMessage.mimetype || "audio/ogg", size: Number(msg.audioMessage.fileLength) || 0 };
  if (msg.documentMessage) return { type: "document", mimetype: msg.documentMessage.mimetype || "application/octet-stream", size: Number(msg.documentMessage.fileLength) || 0, filename: msg.documentMessage.fileName };
  if (msg.stickerMessage) return { type: "sticker", mimetype: msg.stickerMessage.mimetype || "image/webp", size: Number(msg.stickerMessage.fileLength) || 0 };
  return null;
}

// ── Voice transcription (OpenAI Whisper) ───────────────────────────

async function transcribeAudio(buf, mimetype) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set in env / .env.local");
  const ext = mimeToExt(mimetype) || "ogg";
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mimetype || "audio/ogg" }), `voice.${ext}`);
  form.append("model", "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`whisper ${res.status}: ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  return (json.text || "").trim();
}

function mimeToExt(mimetype) {
  const map = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "audio/ogg; codecs=opus": "ogg", "audio/ogg": "ogg",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf",
  };
  return map[mimetype] || "bin";
}

function formatJid(jid) {
  return jid.replace(/@s\.whatsapp\.net$/, "").replace(/@g\.us$/, "").replace(/@lid$/, "").replace(/:\d+$/, "");
}

function getQuotedStanzaId(msg) {
  return msg?.extendedTextMessage?.contextInfo?.stanzaId
    || msg?.imageMessage?.contextInfo?.stanzaId
    || msg?.videoMessage?.contextInfo?.stanzaId
    || msg?.documentMessage?.contextInfo?.stanzaId
    || null;
}

// ── Session registry ────────────────────────────────────────────────

const sessions = new Map(); // sessionId → { socket, pid, cwd, tag, number, windowId, lastSeen }
const socketToSession = new WeakMap(); // socket → sessionId
const numberToSessionId = new Map(); // 1..99 → sessionId
const pendingTerminalWindows = []; // [{ cwd, windowId, ts }] from !spawn / !new
let activeSessionId = null;

function allocSessionNumber() {
  for (let n = 1; n <= 99; n++) {
    if (!numberToSessionId.has(n)) return n;
  }
  return null;
}

function registerSession(clientSock, { sessionId, pid, cwd, tag }) {
  const prev = sessions.get(sessionId);
  if (prev && prev.socket && prev.socket !== clientSock) {
    try { prev.socket.end(); } catch {}
  }
  // Reuse prior number on reconnect; otherwise allocate fresh.
  let number = prev?.number;
  if (!number || numberToSessionId.get(number) !== sessionId) number = allocSessionNumber();
  if (number) numberToSessionId.set(number, sessionId);
  // Attach a Terminal windowId so !clear / !kill can target it. First
  // try a pending !spawn entry matching this cwd. If none (manual
  // `claude` launch outside !spawn), look up the windowId asynchronously
  // by matching the process's controlling tty.
  let windowId = prev?.windowId || null;
  let pendingNotify = null;
  if (!windowId) {
    // macOS APFS is case-insensitive but case-preserving: a !spawn path
    // typed as "MyProject" gets canonicalized by Node's process.cwd() to
    // "myproject", so compare case-insensitively after stripping trailing
    // slashes.
    const norm = (p) => p.replace(/\/+$/, "").toLowerCase();
    const target = norm(cwd);
    for (let i = pendingTerminalWindows.length - 1; i >= 0; i--) {
      if (norm(pendingTerminalWindows[i].cwd) === target) {
        windowId = pendingTerminalWindows[i].windowId;
        pendingNotify = pendingTerminalWindows[i].notify || null;
        pendingTerminalWindows.splice(i, 1);
        break;
      }
    }
  }
  if (!windowId) lookupWindowIdByPid(pid).then((wid) => {
    if (wid && sessions.get(sessionId) && !sessions.get(sessionId).windowId) {
      sessions.get(sessionId).windowId = wid;
      log(`session ${sessionId.slice(0, 8)}: attached windowId=${wid} via tty lookup`);
    }
  });
  sessions.set(sessionId, { socket: clientSock, pid, cwd, tag, number, windowId, lastSeen: Date.now() });
  if (pendingNotify && number) {
    pendingNotify.registered = true;
    if (pendingNotify.onStage) {
      // If the new claude registered before the 7.5s dialog-dismissal
      // timer fired, that stage was skipped. Emit it here first so the
      // timeline stays in natural order: dismissed → ready.
      if (!pendingNotify.dismissedShown) {
        pendingNotify.onStage("🤝 dev-channels dialog dismissed");
        pendingNotify.dismissedShown = true;
      }
      pendingNotify.onStage(`✅ session #${number} [${tag}] ready`);
    } else if (pendingNotify.jid && sock) {
      const quoted = pendingNotify.replyTo ? rawMessages.get(pendingNotify.replyTo) : undefined;
      const text = `🆔 session #${number} assigned to [${tag}]\n${cwd}`;
      sock.sendMessage(pendingNotify.jid, { text }, quoted ? { quoted } : undefined)
        .catch((e) => log(`assigned-number notify failed: ${e.message || e}`));
    }
  }
  socketToSession.set(clientSock, sessionId);
  if (!activeSessionId) activeSessionId = sessionId; // first session = default active
  log(`session registered: ${sessionId.slice(0, 8)} number=${number} pid=${pid} tag=${tag} cwd=${cwd}`);
}

function unregisterSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.number && numberToSessionId.get(s.number) === sessionId) numberToSessionId.delete(s.number);
  sessions.delete(sessionId);
  if (activeSessionId === sessionId) {
    const next = sessions.keys().next().value;
    activeSessionId = next || null;
  }
  log(`session unregistered: ${sessionId.slice(0, 8)}`);
}

// Find the most recently modified transcript .jsonl for `cwd` and return
// its last `usage` block (input / cache_creation / cache_read / output
// tokens). Returns null if no transcript exists.
function readLatestUsage(cwd) {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  const dir = path.join(projectsRoot, cwd.replace(/\//g, "-"));
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return null; }
  if (!files.length) return null;
  let newest = null, newestMtime = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; newest = f; }
    } catch {}
  }
  if (!newest) return null;
  let raw;
  try { raw = fs.readFileSync(path.join(dir, newest), "utf8"); } catch { return null; }
  // Walk backwards through lines for the latest line containing "usage".
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"usage"')) continue;
    try {
      const obj = JSON.parse(line);
      const u = obj.message?.usage;
      if (u) return u;
    } catch {}
  }
  return null;
}

// Look up the Terminal windowId hosting the given process. Walks up the
// parent chain (session-client → Claude Code → shell) until we find a
// process whose controlling tty matches a Terminal tab. Returns null
// for non-Terminal hosts (iTerm, ssh, etc.) or on any failure.
function getProcInfo(pid) {
  return new Promise((resolve) => {
    const ps = spawnProcess("ps", ["-o", "ppid=,tty=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    ps.stdout.on("data", (d) => out += d);
    ps.on("error", () => resolve(null));
    ps.on("exit", () => {
      const m = out.trim().match(/^(\d+)\s+(\S+)$/);
      if (!m) return resolve(null);
      resolve({ ppid: parseInt(m[1], 10), tty: m[2] });
    });
  });
}

async function lookupWindowIdByPid(pid) {
  let cur = pid;
  let tty = null;
  for (let i = 0; i < 6 && cur && cur !== 1; i++) {
    const info = await getProcInfo(cur);
    if (!info) return null;
    if (info.tty && info.tty !== "?" && info.tty !== "??") { tty = info.tty; break; }
    cur = info.ppid;
  }
  if (!tty) return null;
  const ttyDev = tty.startsWith("/") ? tty : `/dev/${tty}`;
  return new Promise((resolve) => {
    const osa = `tell application "Terminal"
  repeat with w in windows
    repeat with tb in tabs of w
      if (tty of tb) is "${ttyDev}" then return id of w
    end repeat
  end repeat
  return ""
end tell`;
    const child = spawnProcess("osascript", ["-e", osa], { stdio: ["ignore", "pipe", "ignore"] });
    let wOut = "";
    child.stdout.on("data", (d) => wOut += d);
    child.on("error", () => resolve(null));
    child.on("exit", () => resolve(parseInt(wOut.trim(), 10) || null));
  });
}

function findSessionsByTag(tag) {
  const lower = tag.toLowerCase();
  const exact = [];
  const prefix = [];
  for (const [id, s] of sessions) {
    const t = (s.tag || "").toLowerCase();
    if (t === lower) exact.push(id);
    else if (t.startsWith(lower)) prefix.push(id);
  }
  return exact.length ? exact : prefix;
}

// ── IPC protocol ────────────────────────────────────────────────────

function sendFrame(sock, obj) {
  if (!sock || sock.destroyed) return;
  try { sock.write(JSON.stringify(obj) + "\n"); } catch (e) { log(`write failed: ${e}`); }
}

function ack(sock, reqId, data) {
  if (reqId) sendFrame(sock, { op: "ack", req_id: reqId, ok: true, data: data || {} });
}

function err(sock, reqId, message) {
  if (reqId) sendFrame(sock, { op: "ack", req_id: reqId, ok: false, error: String(message) });
}

function broadcastConnectionStatus(connected) {
  for (const { socket } of sessions.values()) {
    sendFrame(socket, { op: "connection_status", connected });
  }
}

// ── Inbound routing ─────────────────────────────────────────────────

async function handleInbound(msg, jid, participant, fromOrchestrator = false) {
  const message = msg.message;
  let text = extractText(message);
  const media = extractMediaInfo(message);
  const msgId = msg.key.id || `${Date.now()}`;
  const isGroup = jid.endsWith("@g.us");
  const senderJid = participant || jid;
  const senderNumber = formatJid(senderJid);

  // Voice message → transcribe via OpenAI Whisper, then treat the
  // transcript as if the user had typed it. Routing prefixes spoken at
  // the start (e.g. "five, ...") won't match — voice routes default to
  // active session unless the user quote-replied a previous outbound.
  let voiceTranscript = null;
  let voiceError = null;
  if (media?.type === "audio") {
    try {
      const buf = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
      voiceTranscript = await transcribeAudio(buf, media.mimetype);
      text = voiceTranscript;
      log(`transcribed voice (${buf.length}B): ${voiceTranscript.slice(0, 80)}`);
    } catch (e) {
      voiceError = String(e.message || e);
      log(`voice transcription failed: ${voiceError}`);
    }
  }

  storeRecent(jid, {
    id: msgId, from: senderNumber,
    text: text || (media ? `(${media.type})` : ""),
    ts: (Number(msg.messageTimestamp) || Date.now() / 1000) * 1000,
    hasMedia: !!media, mediaType: media?.type,
  });

  // 1. Permission reply?
  const permMatch = PERMISSION_REPLY_RE.exec(text);
  if (permMatch) {
    const behavior = permMatch[1].toLowerCase().startsWith("y") ? "allow" : "deny";
    const request_id = permMatch[2].toLowerCase();
    const pending = pendingPermissions.get(request_id);
    if (pending) {
      const session = sessions.get(pending.sessionId);
      if (session?.socket) {
        sendFrame(session.socket, {
          op: "permission_response",
          request_id, behavior,
        });
      }
      pendingPermissions.delete(request_id);
    }
    try { await sock.sendMessage(jid, { react: { text: behavior === "allow" ? "✅" : "❌", key: msg.key } }); } catch {}
    return;
  }

  // Spawn-related commands:
  //   !projects                       → list folders in WORK_ROOT
  //   !spawn <name|path> [prompt]    → open Terminal.app + claude in that folder
  //                                    (bare name is resolved against WORK_ROOT)
  //   !new <name> [prompt]           → mkdir WORK_ROOT/<name> and spawn
  const aplEsc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // Write `text` + newline directly into a Terminal tab's tty. Unlike
  // `System Events ... keystroke`, this delivers input to the running
  // program (e.g. Claude Code's TUI) reliably regardless of which window
  // is frontmost or whether accessibility permissions are funky. Used to
  // dismiss the dev-channels confirmation dialog and to send /clear.
  const writeToTabTTY = (windowId, text) =>
    spawnProcess("osascript", [
      "-e", `tell application "Terminal" to do script "${aplEsc(text)}" in selected tab of window id ${windowId}`,
    ], { stdio: "ignore" });
  const openClaudeInFolder = (folder, initialPrompt, notify = null) => {
    const shellCmd = `cd "${aplEsc(folder)}" && claude --dangerously-skip-permissions`;
    // Spawn the Terminal window AND capture its id. NOTE: `id of front
    // window` does NOT return the new window — Terminal's z-order takes a
    // beat to update. Instead, hold onto the tab reference returned by
    // `do script` and find the window whose tab matches that tab's tty.
    const osa = `tell application "Terminal"
  set newTab to do script "${aplEsc(shellCmd)}"
  activate
  set newTty to tty of newTab
  repeat with w in windows
    repeat with tb in tabs of w
      if (tty of tb) is newTty then return id of w
    end repeat
  end repeat
end tell`;
    const child = spawnProcess("osascript", ["-e", osa], {
      stdio: ["ignore", "pipe", "ignore"], detached: true,
    });
    let out = "";
    child.stdout.on("data", (d) => out += d);
    child.on("exit", () => {
      const windowId = parseInt(out.trim(), 10) || null;
      if (!windowId) {
        log(`spawn ${folder}: failed to capture window id (out=${JSON.stringify(out)})`);
        notify?.onStage?.("⚠️ could not capture terminal window id");
        return;
      }
      pendingTerminalWindows.push({ cwd: folder, windowId, ts: Date.now(), notify });
      notify?.onStage?.(`🪟 terminal opened (window ${windowId})`);

      // --dangerously-load-development-channels (applied by the user's
      // ~/.zshrc alias) shows a confirmation dialog with "I am using this
      // for local development" pre-highlighted. Send empty-line Returns
      // via the tab's tty across the first several seconds — the exact
      // appearance time varies with the Claude Code version. Extra
      // Returns at Claude's empty prompt are no-ops.
      [500, 1500, 2500, 3500, 5000, 7000].forEach((ms) =>
        setTimeout(() => writeToTabTTY(windowId, ""), ms));
      // After the last Enter has had a chance to land, mark the dialog
      // dismissal stage — but only if registration hasn't already fired
      // the "✅ ready" line, which happens when the new claude connects
      // back faster than 7.5s and would make the ordering look wrong.
      setTimeout(() => {
        if (!notify || notify.registered || notify.dismissedShown) return;
        notify.onStage?.("🤝 dev-channels dialog dismissed, awaiting registration…");
        notify.dismissedShown = true;
      }, 7500);
      if (initialPrompt) {
        setTimeout(() => writeToTabTTY(windowId, initialPrompt), 9000);
      }
    });
    child.unref();
    log(`spawned Terminal.app window running claude in ${folder}`);
  };
  const listProjects = () => fs.readdirSync(WORK_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();

  const resolveFolder = (raw) => {
    if (raw.startsWith("~")) return path.resolve(path.join(os.homedir(), raw.slice(1)));
    if (raw.startsWith("/")) return path.resolve(raw);
    if (/^\d+$/.test(raw)) {
      const idx = parseInt(raw, 10) - 1;
      const entries = listProjects();
      if (idx < 0 || idx >= entries.length) return null;
      return path.join(WORK_ROOT, entries[idx]);
    }
    return path.resolve(path.join(WORK_ROOT, raw));
  };

  if (/^!help\s*$/i.test(text) || /^!\?\s*$/.test(text)) {
    const helpText = [
      "📖 WhatsApp commands",
      "",
      "Routing (pick which terminal replies):",
      "  <N> <msg>         send to session #N (1-99)",
      "  #<tag> <msg>      send to session whose folder matches <tag>",
      "  !all              ask every session for a one-line status",
      "  !all <msg>        broadcast <msg> to every session",
      "  (quote-reply)     replies route back to the session that sent the message",
      "",
      "Spawning new Claude sessions:",
      "  !projects         list folders in " + WORK_ROOT,
      "  !ls               alias for !projects",
      "  !spawn <N|name>   open Terminal + claude in that folder",
      "  !spawn <path>     absolute/~ path also accepted",
      "  !spawn ... <msg>  trailing text becomes the first prompt",
      "  !new <name>       mkdir " + WORK_ROOT + "/<name> and spawn",
      "",
      "Killing sessions:",
      "  !kill <N>         SIGTERM session #N (its Claude Code + client)",
      "  !kill <tag>       kill sessions matching tag (prefix match)",
      "",
      "Clearing context:",
      "  !clear <N|tag>    send /clear to that session's terminal",
      "",
      "Inspecting:",
      "  !ctx              context-window % for all sessions",
      "  !ctx <N|tag>      …only the matching session(s)",
      "",
      "Recovery:",
      "  !unstuck          force the daemon to reconnect to WhatsApp",
      "",
      "Other:",
      "  !help             this message",
    ].join("\n");
    try { await sock.sendMessage(jid, { text: helpText }); } catch (e) { log(`help send failed: ${e.message}`); }
    return;
  }

  if (/^!projects\s*$/i.test(text) || /^!ls\s*$/i.test(text)) {
    try {
      const entries = listProjects();
      const pad = String(entries.length).length;
      const lines = [`📁 ${WORK_ROOT}`, ...entries.map((n, i) => `  ${String(i + 1).padStart(pad)}. ${n}`)];
      if (!entries.length) lines.push("  (empty)");
      lines.push("", "spawn: !spawn <N|name>    new: !new <name>");
      await sock.sendMessage(jid, { text: lines.join("\n") });
    } catch (e) {
      await sock.sendMessage(jid, { text: `❌ ls failed: ${e.message}` });
    }
    return;
  }

  const newMatch = /^!new\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(text);
  if (newMatch) {
    const name = newMatch[1];
    const initialPrompt = (newMatch[2] || "").trim();
    if (name.includes("/") || name === "." || name === "..") {
      await sock.sendMessage(jid, { text: "❌ name must not contain / or be . / .." });
      return;
    }
    const folder = path.join(WORK_ROOT, name);
    try {
      if (fs.existsSync(folder)) {
        await sock.sendMessage(jid, { text: `❌ folder already exists: ${folder}\nuse !spawn ${name} to open it` });
        return;
      }
      fs.mkdirSync(folder, { recursive: true });
      const stages = [`🆕 created ${folder}`, `🚀 spawning claude…`];
      const sent = await sock.sendMessage(jid, { text: stages.join("\n") });
      const editKey = sent?.key;
      const updateProgress = (line) => {
        stages.push(line);
        if (editKey) sock.sendMessage(jid, { text: stages.join("\n"), edit: editKey })
          .catch((e) => log(`progress edit failed: ${e.message || e}`));
      };
      openClaudeInFolder(folder, initialPrompt, { jid, replyTo: msgId, onStage: updateProgress });
    } catch (e) {
      log(`new failed: ${e.message}`);
      await sock.sendMessage(jid, { text: `❌ new failed: ${e.message}` });
    }
    return;
  }

  const spawnMatch = /^!spawn\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(text);
  if (spawnMatch) {
    const folder = resolveFolder(spawnMatch[1]);
    const initialPrompt = (spawnMatch[2] || "").trim();
    if (!folder) {
      await sock.sendMessage(jid, { text: `❌ no project at index ${spawnMatch[1]} — try !projects` });
      return;
    }
    try {
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        await sock.sendMessage(jid, { text: `❌ folder not found: ${folder}` });
        return;
      }
    } catch (e) {
      await sock.sendMessage(jid, { text: `❌ folder check failed: ${e.message}` });
      return;
    }
    try {
      const stages = [`🚀 spawning claude in ${folder}`];
      const sent = await sock.sendMessage(jid, { text: stages.join("\n") });
      const editKey = sent?.key;
      const updateProgress = (line) => {
        stages.push(line);
        if (editKey) sock.sendMessage(jid, { text: stages.join("\n"), edit: editKey })
          .catch((e) => log(`progress edit failed: ${e.message || e}`));
      };
      openClaudeInFolder(folder, initialPrompt, { jid, replyTo: msgId, onStage: updateProgress });
    } catch (e) {
      log(`spawn failed: ${e.message}`);
      await sock.sendMessage(jid, { text: `❌ spawn failed: ${e.message}` });
    }
    return;
  }

  // !kill <N|#tag|tag>       → SIGTERM the session's Claude Code process (its parent)
  //                            plus the session-client itself, so the Terminal
  //                            window drops back to the shell prompt.
  const killMatch = /^!kill\s+(\S+)\s*$/i.exec(text);
  if (killMatch) {
    const target = killMatch[1];
    let victimIds = [];
    if (/^\d+$/.test(target)) {
      const sid = numberToSessionId.get(parseInt(target, 10));
      if (sid && sessions.has(sid)) victimIds.push(sid);
    } else {
      const tag = target.startsWith("#") ? target.slice(1) : target;
      victimIds = findSessionsByTag(tag);
    }
    if (!victimIds.length) {
      await sock.sendMessage(jid, { text: `❌ no session matching ${target}` });
      return;
    }
    const getPPID = (pid) => new Promise((resolve) => {
      const child = spawnProcess("ps", ["-o", "ppid=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (d) => out += d);
      child.on("exit", () => resolve(parseInt(out.trim(), 10) || null));
      child.on("error", () => resolve(null));
    });
    const lines = [];
    for (const sid of victimIds) {
      const s = sessions.get(sid);
      if (!s) continue;
      const ppid = await getPPID(s.pid);
      let killed = false;
      if (ppid && ppid !== 1) {
        try { process.kill(ppid, "SIGTERM"); killed = true; } catch {}
      }
      try { process.kill(s.pid, "SIGTERM"); } catch {}
      orchestrator.wipeSession(sid);
      lines.push(`${killed ? "🔪" : "⚠️"} ${s.number ? `${s.number} ` : ""}[${s.tag}] pid=${s.pid}${ppid ? ` ppid=${ppid}` : ""}`);
    }
    await sock.sendMessage(jid, { text: lines.join("\n") });
    return;
  }

  // !clear <N|#tag|tag>      → write "/clear" + newline directly to the
  //                            session's Terminal tab, dropping Claude
  //                            Code's current conversation context.
  //                            Requires the session was spawned via
  //                            !spawn / !new so we captured its window id.
  const clearMatch = /^!clear\s+(\S+)\s*$/i.exec(text);
  if (clearMatch) {
    const target = clearMatch[1];
    let victimIds = [];
    if (/^\d+$/.test(target)) {
      const sid = numberToSessionId.get(parseInt(target, 10));
      if (sid && sessions.has(sid)) victimIds.push(sid);
    } else {
      const tag = target.startsWith("#") ? target.slice(1) : target;
      victimIds = findSessionsByTag(tag);
    }
    if (!victimIds.length) {
      await sock.sendMessage(jid, { text: `❌ no session matching ${target}` });
      return;
    }
    const lines = [];
    for (const sid of victimIds) {
      const s = sessions.get(sid);
      if (!s) continue;
      const label = `${s.number ? `${s.number} ` : ""}[${s.tag}]`;
      if (!s.windowId) {
        lines.push(`⚠️ ${label} no window id known (start via !spawn to enable)`);
        continue;
      }
      writeToTabTTY(s.windowId, "/clear");
      lines.push(`🧹 ${label} cleared`);
    }
    await sock.sendMessage(jid, { text: lines.join("\n") });
    return;
  }

  // !ctx [N|tag]              → context-window usage. With no arg, all
  //                             sessions; with arg, just the matching
  //                             one(s). Read from each session's most
  //                             recent Claude Code transcript (% of 1M).
  const ctxMatch = /^!(?:ctx|stats)(?:\s+(\S+))?\s*$/i.exec(text);
  if (ctxMatch) {
    const filter = ctxMatch[1];
    let entries = [...sessions.entries()];
    if (filter) {
      if (/^\d+$/.test(filter)) {
        const sid = numberToSessionId.get(parseInt(filter, 10));
        entries = sid && sessions.has(sid) ? [[sid, sessions.get(sid)]] : [];
      } else {
        const tag = filter.startsWith("#") ? filter.slice(1) : filter;
        const ids = findSessionsByTag(tag);
        entries = ids.map((id) => [id, sessions.get(id)]).filter(([, s]) => s);
      }
    }
    entries.sort((a, b) => (a[1].number || 99) - (b[1].number || 99));
    if (!entries.length) {
      await sock.sendMessage(jid, { text: filter ? `❌ no session matching ${filter}` : "no sessions registered" });
      return;
    }
    const lines = ["📊 context usage"];
    for (const [, s] of entries) {
      const usage = readLatestUsage(s.cwd);
      const label = `${s.number ? `${s.number} ` : ""}[${s.tag}]`;
      if (!usage) { lines.push(`${label}  no transcript found`); continue; }
      const total = (usage.input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0)
        + (usage.cache_read_input_tokens || 0);
      const pct = (total / 1_000_000 * 100).toFixed(1);
      const k = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      lines.push(`${label}  ${pct}%  (${k(total)} ctx · ${k(usage.output_tokens || 0)} out)`);
    }
    await sock.sendMessage(jid, { text: lines.join("\n") });
    return;
  }

  // !unstuck — force a clean Baileys reconnect. Handy when the daemon is
  // silently wedged: socket looks open but nothing is flowing. Reset the
  // staleness marker so the watchdog doesn't re-fire on the next tick.
  if (/^!unstuck\s*$/i.test(text)) {
    log("!unstuck received — forcing WA reconnect");
    try { await sock.sendMessage(jid, { react: { text: "🔄", key: msg.key } }); } catch {}
    lastInboundAt = Date.now();
    connectWhatsApp();
    return;
  }

  // Build base content + meta
  let content = text || (media ? `(${media.type})` : "(empty)");
  const meta = {
    chat_id: jid, message_id: msgId, user: senderNumber,
    ts: new Date((Number(msg.messageTimestamp) || Date.now() / 1000) * 1000).toISOString(),
    origin: "whatsapp",
  };
  if (media) {
    const kb = (media.size / 1024).toFixed(0);
    const name = media.filename || `${media.type}.${mimeToExt(media.mimetype)}`;
    meta.attachment_count = "1";
    meta.attachments = `${name} (${media.mimetype}, ${kb}KB)`;
  }
  if (voiceTranscript !== null) meta.voice = "true";
  if (voiceError) meta.voice_error = voiceError;
  if (isGroup) meta.group = "true";

  // 2. Routing classification
  let targets = []; // list of session IDs
  let routedBy = null;

  // Routing prefixes — body is optional so a caption like "5" on a bare
  // image (no text body) still routes to session 5; the attachment itself
  // is the payload.
  const numMatch = /^(\d{1,2})(?:\s+([\s\S]*))?$/.exec(text);
  const hashMatch = /^#([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text);
  const allMatch = /^!all(?:\s+([\s\S]*))?$/i.exec(text);
  const quotedId = getQuotedStanzaId(message);
  const fallbackBody = () => media ? `(${media.type})` : "(empty)";

  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (n >= 1 && n <= 99) {
      const sid = numberToSessionId.get(n);
      if (sid && sessions.has(sid)) {
        const body = (numMatch[2] || "").trim();
        content = body || fallbackBody();
        targets = [sid];
        meta.route_number = String(n);
        routedBy = "number";
      }
    }
  }

  if (!targets.length && hashMatch) {
    const tag = hashMatch[1];
    const stripped = (hashMatch[2] || "").trim();
    targets = findSessionsByTag(tag);
    if (targets.length) { content = stripped || fallbackBody(); meta.route_tag = tag; routedBy = "tag"; }
  }

  if (!targets.length && allMatch) {
    const body = (allMatch[1] || "").trim();
    if (!body) {
      content = "Status check: reply with ONE short line describing what you are working on right now. Nothing else.";
      meta.status_request = "true";
    } else {
      content = body;
    }
    targets = [...sessions.keys()];
    meta.route_broadcast = "true";
    routedBy = "broadcast";
  }

  if (!targets.length && quotedId) {
    const sid = lookupOutbound(quotedId);
    if (sid && sessions.has(sid)) {
      targets = [sid];
      meta.route_quoted = quotedId;
      routedBy = "quoted";
    }
  }

  // Sticky active routing: an explicit pick (<N>, #tag, or quote-reply)
  // promotes that session to "active", so subsequent unprefixed messages
  // — text, images, voice — keep flowing there until you switch with
  // another <N>. Broadcast (!all) is one-shot and never sticks.
  if (targets.length === 1 && (routedBy === "number" || routedBy === "tag" || routedBy === "quoted")) {
    if (activeSessionId !== targets[0]) {
      activeSessionId = targets[0];
      log(`active session → ${activeSessionId.slice(0, 8)} (sticky from ${routedBy})`);
    }
  }

  // No explicit prefix matched — let the orchestrator decide. The classifier
  // can route to a specific terminal, answer itself as YACA, or invoke a
  // daemon command on behalf of the user. Skipped on a recursive re-entry
  // from the command path so we never loop on a failed-to-match !text.
  if (!targets.length && !fromOrchestrator) {
    try {
      const decision = await orchestrator.classify({
        text: content,
        sessions,
        lastActiveId: activeSessionId,
        jid,
      });
      if (decision.action === "answer") {
        const replyText = `[YACA] ${decision.reply}`;
        let sentId = null;
        try {
          const sent = await sock.sendMessage(jid, { text: replyText });
          sentId = sent?.key?.id || null;
        } catch (e) { log(`YACA self-answer send failed: ${e.message}`); }
        orchestrator.record(jid, { dir: "in", text: content });
        orchestrator.record(jid, { dir: "out", session_id: "yaca", text: decision.reply });
        dailyLog.appendInbound({ root: STATE_DIR, chat_id: jid, user: senderNumber, content, meta });
        dailyLog.appendOutbound({ root: STATE_DIR, chat_id: jid, tag: "YACA", text: decision.reply, message_id: sentId });
        log(`YACA self-answered: ${decision.reply.slice(0, 60)}`);
        return;
      }
      if (decision.action === "command") {
        log(`YACA → command: ${decision.text}`);
        orchestrator.record(jid, { dir: "in", text: content });
        orchestrator.record(jid, { dir: "out", session_id: "yaca", text: `(executing ${decision.text})` });
        const fakeMsg = { ...msg, message: { ...msg.message, conversation: decision.text, extendedTextMessage: undefined } };
        return await handleInbound(fakeMsg, jid, participant, true);
      }
      if (decision.action === "route" && decision.target_session_id && sessions.has(decision.target_session_id)) {
        targets = [decision.target_session_id];
        meta.route_smart = "true";
        content = decision.clean || content;
        routedBy = "smart";
        activeSessionId = decision.target_session_id;
      }
    } catch (e) {
      log(`smart-route failed: ${e.message}`);
    }
  }

  if (!targets.length) {
    if (activeSessionId && sessions.has(activeSessionId)) {
      targets = [activeSessionId];
      routedBy = "active";
    }
  }

  if (!targets.length) {
    log(`inbound dropped (no route): ${text.slice(0, 60)}`);
    try { await sock.sendMessage(jid, { react: { text: "❓", key: msg.key } }); } catch {}
    return;
  }

  // Confirm-token gate: if access.json defines confirmToken and the (possibly
  // routing-stripped) content starts with it, strip and mark origin_confirmed.
  // Signal to Claude that destructive operations are authorized.
  const access = loadAccess();
  if (access.confirmToken) {
    const tokenRe = new RegExp(`^\\s*${access.confirmToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`);
    if (tokenRe.test(content)) {
      content = content.replace(tokenRe, "");
      meta.origin_confirmed = "true";
    } else {
      meta.origin_confirmed = "false";
    }
  }

  log(`inbound routed via ${routedBy} → ${targets.length} session(s): ${text.slice(0, 60)}`);
  dailyLog.appendInbound({ root: STATE_DIR, chat_id: jid, user: senderNumber, content, meta });
  orchestrator.record(jid, { dir: "in", text: content });
  for (const sid of targets) {
    const session = sessions.get(sid);
    if (!session?.socket) continue;
    sendFrame(session.socket, {
      op: "inbound",
      to_session: sid,
      content,
      meta: { ...meta, to_session: sid },
    });
  }

  // Immediate ack reaction so the sender knows the daemon picked up the
  // command and routed it (Claude itself may take a beat to reply). For
  // single-target sends we react with the destination session's number
  // emoji — instant visual confirmation of WHO got it. Broadcast → 📣.
  const NUM_EMOJI = ["0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  let ackEmoji;
  if (routedBy === "broadcast") {
    ackEmoji = "📣";
  } else if (targets.length === 1) {
    const n = sessions.get(targets[0])?.number;
    ackEmoji = (n != null && n <= 10) ? NUM_EMOJI[n] : "👀";
  } else {
    ackEmoji = "👀";
  }
  try { await sock.sendMessage(jid, { react: { text: ackEmoji, key: msg.key } }); } catch {}
}

// ── Outbound: permission request (Claude → WhatsApp) ────────────────

async function sendPermissionRequest(sessionId, { request_id, tool_name, description, input_preview }) {
  if (!sock || !connectionReady) throw new Error("WhatsApp not connected");
  const session = sessions.get(sessionId);
  const tag = session?.tag || "?";
  const access = loadAccess();
  const text = `🔐 [${tag}] Permission request [${request_id}]\n\n` +
    `${tool_name}: ${description}\n` +
    `${input_preview}\n\n` +
    `Reply "yes ${request_id}" or "no ${request_id}"`;
  pendingPermissions.set(request_id, { sessionId, ts: Date.now() });
  for (const phone of access.allowFrom) {
    const jid = toJid(phone);
    try { await sock.sendMessage(jid, { text }); } catch (e) { log(`permission_request send to ${jid} failed: ${e}`); }
  }
}

// ── Outbound rate limit ─────────────────────────────────────────────

const outboundCounters = new Map(); // sessionId → [timestamps]

function checkOutboundRate(sessionId) {
  const now = Date.now();
  let arr = outboundCounters.get(sessionId);
  if (!arr) { arr = []; outboundCounters.set(sessionId, arr); }
  while (arr.length && now - arr[0] > OUTBOUND_RATE_WINDOW) arr.shift();
  if (arr.length >= OUTBOUND_RATE_MAX) return false;
  arr.push(now);
  return true;
}

// ── Outbound: reply / react / download / fetch ──────────────────────

async function handleReply(sessionId, { chat_id, text, reply_to, files }) {
  if (!sock || !connectionReady) throw new Error("WhatsApp not connected");
  if (!checkOutboundRate(sessionId)) throw new Error(`outbound rate limit exceeded (${OUTBOUND_RATE_MAX}/min)`);
  files = files || [];
  for (const f of files) {
    assertSendable(f);
    if (fs.statSync(f).size > 64 * 1024 * 1024) throw new Error(`file too large: ${f}`);
  }
  const quoted = reply_to ? rawMessages.get(reply_to) : undefined;
  let lastSentId = null;
  const session = sessions.get(sessionId);
  const outTag = session?.tag || "yaca";
  if (text) {
    const sent = await sock.sendMessage(chat_id, { text }, quoted ? { quoted } : undefined);
    lastSentId = sent?.key?.id || null;
    if (lastSentId) trackOutbound(lastSentId, sessionId);
    dailyLog.appendOutbound({ root: STATE_DIR, chat_id, tag: outTag, text, message_id: lastSentId });
    orchestrator.record(chat_id, { dir: "out", session_id: sessionId, text });
  }
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const buf = fs.readFileSync(f);
    let sent;
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
      sent = await sock.sendMessage(chat_id, { image: buf });
    } else if ([".ogg", ".mp3", ".m4a", ".wav"].includes(ext)) {
      sent = await sock.sendMessage(chat_id, { audio: buf, mimetype: ext === ".ogg" ? "audio/ogg; codecs=opus" : "audio/mpeg", ptt: ext === ".ogg" });
    } else if ([".mp4", ".mov", ".avi"].includes(ext)) {
      sent = await sock.sendMessage(chat_id, { video: buf });
    } else {
      sent = await sock.sendMessage(chat_id, { document: buf, mimetype: "application/octet-stream", fileName: path.basename(f) });
    }
    const id = sent?.key?.id;
    if (id) { trackOutbound(id, sessionId); lastSentId = id; }
  }
  return { message_id: lastSentId };
}

async function handleReact(sessionId, { chat_id, message_id, emoji }) {
  if (!sock || !connectionReady) throw new Error("WhatsApp not connected");
  await sock.sendMessage(chat_id, { react: { text: emoji, key: { remoteJid: chat_id, id: message_id } } });
  return { ok: true };
}

// Rolling progress messages: per (sessionId, chatId), keep one editable
// status message that successive progress() calls append to. State drops
// after PROGRESS_TTL idle so old keys don't pile up indefinitely.
const progressMessages = new Map(); // `${sid}:${chatId}` → { key, lines: [], ts }
const PROGRESS_TTL = 30 * 60 * 1000;

async function handleProgress(sessionId, { chat_id, text, reset }) {
  if (!sock || !connectionReady) throw new Error("WhatsApp not connected");
  if (!chat_id || !text) throw new Error("chat_id and text required");
  const session = sessions.get(sessionId);
  const tagPrefix = session ? `[${session.number ? `${session.number} ` : ""}${session.tag}] ` : "";
  const k = `${sessionId}:${chat_id}`;
  let state = progressMessages.get(k);
  if (state && Date.now() - state.ts > PROGRESS_TTL) state = null;
  if (reset) state = null;

  if (!state) {
    const sent = await sock.sendMessage(chat_id, { text: `${tagPrefix}${text}` });
    progressMessages.set(k, { key: sent?.key, lines: [text], ts: Date.now() });
  } else {
    state.lines.push(text);
    state.ts = Date.now();
    if (state.key) {
      try {
        await sock.sendMessage(chat_id, {
          text: `${tagPrefix}${state.lines.join("\n")}`,
          edit: state.key,
        });
      } catch (e) {
        // Edit failed (msg too old, etc.) — start a fresh status message.
        log(`progress edit failed, sending new: ${e.message || e}`);
        const sent = await sock.sendMessage(chat_id, { text: `${tagPrefix}${text}` });
        progressMessages.set(k, { key: sent?.key, lines: [text], ts: Date.now() });
      }
    }
  }
  return { ok: true };
}

async function handleDownload({ message_id }) {
  const raw = rawMessages.get(message_id);
  if (!raw?.message) throw new Error("message not found in cache");
  const media = extractMediaInfo(raw.message);
  if (!media) throw new Error("message has no attachments");
  const buffer = await downloadMediaMessage(raw, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
  const ext = mimeToExt(media.mimetype);
  const filename = media.filename || `${Date.now()}.${ext}`;
  const filePath = path.join(INBOX_DIR, `${Date.now()}-${filename}`);
  fs.writeFileSync(filePath, buffer);
  return { path: filePath, type: media.type, bytes: buffer.length };
}

function handleFetchMessages({ chat_id, limit }) {
  const cap = Math.min(limit || 20, 100);
  const msgs = recentMessages.get(chat_id) || [];
  return { messages: msgs.slice(-cap) };
}

// ── IPC server ──────────────────────────────────────────────────────

function startIpcServer() {
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  const server = net.createServer((c) => {
    c.setEncoding("utf8");
    let buf = "";

    // Enforce same-uid: Unix peer credentials aren't exposed by node,
    // but socket file is mode 0700 and owned by this user — that's the gate.

    c.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) handleFrame(c, line).catch((e) => log(`frame handler error: ${e}`));
      }
    });

    c.on("close", () => {
      const sid = socketToSession.get(c);
      if (sid) unregisterSession(sid);
    });
    c.on("error", (e) => log(`client socket error: ${e.message}`));
  });

  server.listen(SOCKET_PATH, () => {
    try { fs.chmodSync(SOCKET_PATH, 0o700); } catch {}
    log(`ipc listening at ${SOCKET_PATH}`);
  });

  server.on("error", (e) => {
    log(`ipc server error: ${e}`);
    process.exit(1);
  });

  return server;
}

async function handleFrame(clientSock, line) {
  let frame;
  try { frame = JSON.parse(line); } catch { return err(clientSock, null, "bad json"); }
  const reqId = frame.req_id;
  const op = frame.op;

  switch (op) {
    case "register": {
      registerSession(clientSock, {
        sessionId: frame.session_id,
        pid: frame.pid,
        cwd: frame.cwd,
        tag: frame.tag,
      });
      sendFrame(clientSock, {
        op: "registered",
        session_id: frame.session_id,
        number: sessions.get(frame.session_id)?.number || null,
        connected: connectionReady,
      });
      return;
    }
    case "unregister": {
      unregisterSession(frame.session_id);
      ack(clientSock, reqId, {});
      return;
    }
    case "claim_active": {
      if (!sessions.has(frame.session_id)) return err(clientSock, reqId, "session not registered");
      activeSessionId = frame.session_id;
      log(`active session claimed: ${activeSessionId.slice(0, 8)}`);
      ack(clientSock, reqId, { active: activeSessionId });
      return;
    }
    case "release_active": {
      if (activeSessionId === frame.session_id) {
        activeSessionId = [...sessions.keys()].find((k) => k !== frame.session_id) || null;
        log(`active session released; now: ${activeSessionId ? activeSessionId.slice(0, 8) : "none"}`);
      }
      ack(clientSock, reqId, { active: activeSessionId });
      return;
    }
    case "list_sessions": {
      const list = [...sessions.entries()].map(([id, s]) => ({
        session_id: id, tag: s.tag, cwd: s.cwd, pid: s.pid, active: id === activeSessionId,
      }));
      ack(clientSock, reqId, { sessions: list, connected: connectionReady });
      return;
    }
    case "reply": {
      try {
        const sid = frame.from_session || socketToSession.get(clientSock);
        const data = await handleReply(sid, frame);
        ack(clientSock, reqId, data);
      } catch (e) { err(clientSock, reqId, e.message || e); }
      return;
    }
    case "react": {
      try {
        const sid = frame.from_session || socketToSession.get(clientSock);
        const data = await handleReact(sid, frame);
        ack(clientSock, reqId, data);
      } catch (e) { err(clientSock, reqId, e.message || e); }
      return;
    }
    case "progress": {
      try {
        const sid = frame.from_session || socketToSession.get(clientSock);
        const data = await handleProgress(sid, frame);
        ack(clientSock, reqId, data);
      } catch (e) { err(clientSock, reqId, e.message || e); }
      return;
    }
    case "download_attachment": {
      try {
        const data = await handleDownload(frame);
        ack(clientSock, reqId, data);
      } catch (e) { err(clientSock, reqId, e.message || e); }
      return;
    }
    case "fetch_messages": {
      try {
        const data = handleFetchMessages(frame);
        ack(clientSock, reqId, data);
      } catch (e) { err(clientSock, reqId, e.message || e); }
      return;
    }
    case "permission_request": {
      try {
        const sid = frame.from_session || socketToSession.get(clientSock);
        await sendPermissionRequest(sid, frame);
        ack(clientSock, reqId, {});
      } catch (e) { err(clientSock, reqId, e.message || e); }
      return;
    }
    case "ping": {
      ack(clientSock, reqId, { pong: true });
      return;
    }
    default:
      err(clientSock, reqId, `unknown op: ${op}`);
  }
}

// ── Startup ─────────────────────────────────────────────────────────

process.on("unhandledRejection", (e) => {
  const msg = String(e).toLowerCase();
  if ((msg.includes("unable to authenticate data") || msg.includes("bad mac")) &&
      (msg.includes("baileys") || msg.includes("noise-handler") || msg.includes("signal"))) {
    log("Baileys crypto error — forcing reconnect");
    setTimeout(connectWhatsApp, 2000);
    return;
  }
  log(`unhandled rejection: ${e}`);
});
process.on("uncaughtException", (e) => log(`uncaught exception: ${e}`));
process.setMaxListeners(100);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down");
  cleanupSocket();
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
  setTimeout(() => process.exit(0), 1000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// PANIC file kill-switch
setInterval(() => {
  try { fs.accessSync(PANIC_FILE); log("PANIC file present — shutting down"); shutdown(); } catch {}
}, 5000).unref();

// On daemon startup, ping every registered session for a one-line
// status — same behavior as a phone-side `!all` — so the user can see
// what's alive after a restart. Fired once 10s after main() so existing
// session-clients have a chance to reconnect first.
function broadcastStartupStatus() {
  const access = loadAccess();
  const phone = access.allowFrom?.[0];
  if (!phone) { log("startup status: no allowFrom phone configured, skipping"); return; }
  const chatId = toJid(phone);
  let n = 0;
  for (const [sid, s] of sessions) {
    if (!s.socket) continue;
    sendFrame(s.socket, {
      op: "inbound",
      to_session: sid,
      content: "Status check: reply with ONE short line describing what you are working on right now. Nothing else.",
      meta: {
        chat_id: chatId,
        message_id: `daemon-startup-${Date.now()}-${sid.slice(0, 4)}`,
        user: phone,
        ts: new Date().toISOString(),
        origin: "whatsapp",
        status_request: "true",
        route_broadcast: "true",
        to_session: sid,
      },
    });
    n++;
  }
  log(`broadcast daemon-startup status request to ${n} session(s)`);
}

async function main() {
  acquirePidLock();
  startIpcServer();
  await connectWhatsApp();
  setTimeout(broadcastStartupStatus, 10000);
}

main().catch((e) => { log(`fatal: ${e}`); process.exit(1); });
