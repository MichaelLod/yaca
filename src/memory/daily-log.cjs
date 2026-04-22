// Append-only daily log. One file per day per chat, markdown, human-readable.
// Intentionally minimal: the filesystem IS the memory layer. Claude reads these
// back via Read/Grep, no vector DB needed at this scale.
//
// Layout:
//   $YACA_STATE_DIR/memory/daily/YYYY-MM-DD/chat-<sanitized-jid>.md
//
// Each inbound message adds one block. Outbound replies (sent from the agent)
// should also be logged — wire appendOutbound() from the daemon's send path.
//
// Content is stored here by design. The inbox-<tag>.log Monitor hook stays
// meta-only; this file is where actual conversation history persists.

const fs = require("fs");
const path = require("path");

function sanitize(jid) {
  return (jid || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function dayDir(root, ts) {
  const d = ts ? new Date(ts) : new Date();
  const ymd = d.toISOString().slice(0, 10);
  return path.join(root, "memory", "daily", ymd);
}

function chatFile(root, jid, ts) {
  return path.join(dayDir(root, ts), `chat-${sanitize(jid)}.md`);
}

function ensureHeader(file, jid) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = `# Chat ${jid}\n\n`;
  fs.writeFileSync(file, header, { mode: 0o600 });
}

function writeBlock(file, block) {
  try {
    fs.appendFileSync(file, block);
  } catch (err) {
    process.stderr.write(`[daily-log] write failed: ${err.message}\n`);
  }
}

function appendInbound({ root, chat_id, user, content, meta }) {
  if (!root || !chat_id) return;
  const file = chatFile(root, chat_id, meta?.ts);
  ensureHeader(file, chat_id);
  const ts = meta?.ts || new Date().toISOString();
  const route = meta?.route_number ? `#${meta.route_number}`
    : meta?.route_tag ? `#tag:${meta.route_tag}`
    : meta?.route_broadcast ? "!all"
    : meta?.route_quoted ? "quoted"
    : "active";
  const tags = [];
  if (meta?.voice === "true") tags.push("voice");
  if (meta?.attachment_count) tags.push(`attach:${meta.attachments || meta.attachment_count}`);
  if (meta?.origin_confirmed === "true") tags.push("confirmed");
  const tagStr = tags.length ? ` _${tags.join(" · ")}_` : "";
  const block = `## ${ts} ← ${user || "unknown"} (${route})${tagStr}\n\n${content}\n\n`;
  writeBlock(file, block);
}

function appendOutbound({ root, chat_id, tag, text, message_id, ts }) {
  if (!root || !chat_id) return;
  const file = chatFile(root, chat_id, ts);
  ensureHeader(file, chat_id);
  const iso = ts || new Date().toISOString();
  const idStr = message_id ? ` _msg:${message_id}_` : "";
  const block = `## ${iso} → [${tag || "yaca"}]${idStr}\n\n${text}\n\n`;
  writeBlock(file, block);
}

module.exports = { appendInbound, appendOutbound };
