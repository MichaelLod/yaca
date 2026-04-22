#!/usr/bin/env node
// YACA — WhatsApp pairing. Run once to link this machine to the WA account.
// Usage: node src/pair.cjs
// Optional: PAIR_PHONE="<E.164>" enables pairing-code flow (else QR only).
const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const path = require("path");
const os = require("os");

const STATE_DIR = process.env.YACA_STATE_DIR || path.join(os.homedir(), ".yaca");
const AUTH_DIR = path.join(STATE_DIR, "auth");
const PID_FILE = path.join(STATE_DIR, "daemon.pid");
const PAIR_PHONE = process.env.PAIR_PHONE || null;

console.log("YACA pairing — auth dir:", AUTH_DIR);

// Tear down any running daemon and wipe prior auth so the new pairing is clean.
(() => {
  const fs = require("fs");
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    if (pid) {
      try { process.kill(pid, "SIGTERM"); console.log(`Stopped running daemon (pid ${pid}).`); } catch {}
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { process.kill(pid, 0); } catch { break; }
        require("child_process").execSync("sleep 0.2");
      }
    }
  } catch {}
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); console.log("Removed prior auth."); } catch {}
})();

console.log("Connecting...\n");

(async () => {
  require("fs").mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: "silent" });

  let restarted = false;

  const connect = () => {
    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      version,
      logger,
      browser: ["Mac OS", "Safari", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    if (!state.creds.registered && PAIR_PHONE && !restarted) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(PAIR_PHONE);
          console.log(`\n📱 PAIRING CODE: ${code}\n`);
          console.log("WhatsApp > Linked Devices > Link a Device > Link with phone number");
          console.log("Enter the code above.\n");
        } catch (e) {
          console.error("Pairing code failed, waiting for QR instead...");
        }
      }, 3000);
    }

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !restarted) {
        qrcode.generate(qr, { small: true }, (code) => {
          console.log("\n📱 Or scan this QR:\n");
          console.log(code);
        });
      }

      if (connection === "open") {
        state.creds.registered = true;
        Promise.resolve(saveCreds()).finally(() => {
          console.log(`\n✅ WhatsApp fully connected. Creds saved to ${AUTH_DIR}. Done.`);
          setTimeout(() => process.exit(0), 500);
        });
      }

      if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode;
        // 515 = restart request right after the pair handshake. Reconnect with
        // the saved creds and wait for `connection === "open"` before exiting —
        // otherwise the phone stays stuck on "Logging in..."
        if (reason === 515 && !restarted) {
          restarted = true;
          console.log("\nPair handshake complete, reconnecting to finalize...");
          setTimeout(connect, 500);
          return;
        }
        if (reason === DisconnectReason.loggedOut || reason === 440) {
          console.log(`❌ Error ${reason}. Delete auth/ and try again after a few minutes.`);
          process.exit(1);
        }
        console.log(`Connection closed (${reason}), retrying...`);
        setTimeout(() => process.exit(1), 1000);
      }
    });
  };

  connect();
})();
