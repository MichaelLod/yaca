// YACA orchestrator — smart routing + self-answer.
//
// When a phone message has no explicit routing prefix, an LLM classifier
// looks at the live session list + recent dialogue and decides:
//   - "route"  → forward to a specific terminal
//   - "answer" → YACA replies itself (prefixed [YACA])
//
// Memory is in-memory only: a rolling per-chat buffer of recent turns,
// tagged with the session each turn was directed at / came from. On
// !kill we drop the killed session's entries so context never bloats.
// No vector DB — keeps daemon dependency-free.

const HISTORY_PER_CHAT = 60;
const ROUTER_MODEL = process.env.YACA_ROUTER_MODEL || "gpt-4o-mini";
const OPENAI_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com";

const history = new Map(); // jid → [{ts, dir, session_id?, text}]

function record(jid, entry) {
  if (!jid || !entry || !entry.text) return;
  const arr = history.get(jid) || [];
  arr.push({ ts: Date.now(), ...entry });
  if (arr.length > HISTORY_PER_CHAT) arr.splice(0, arr.length - HISTORY_PER_CHAT);
  history.set(jid, arr);
}

function wipeSession(sessionId) {
  if (!sessionId) return;
  for (const [jid, arr] of history) {
    history.set(jid, arr.filter((e) => e.session_id !== sessionId));
  }
}

function snapshot(jid) {
  return history.get(jid) || [];
}

function buildSessionList(sessions) {
  return [...sessions.values()].map((s) => ({
    number: s.number,
    tag: s.tag,
    cwd: s.cwd,
    session_id: s.session_id,
  }));
}

function renderRecent(jid, sessionList) {
  const entries = snapshot(jid).slice(-20);
  if (!entries.length) return "(empty)";
  return entries.map((e) => {
    if (e.dir === "in") return `← user: ${e.text}`;
    if (e.session_id === "yaca") return `→ YACA: ${e.text}`;
    const sess = sessionList.find((s) => s.session_id === e.session_id);
    const label = sess ? `${sess.number ?? "?"} [${sess.tag}]` : "?";
    return `→ ${label}: ${e.text}`;
  }).join("\n");
}

async function classify({ text, sessions, lastActiveId, jid }) {
  if (!process.env.OPENAI_API_KEY) {
    return lastActiveId
      ? { action: "route", target_session_id: lastActiveId, clean: text }
      : { action: "noop" };
  }

  const sessionList = buildSessionList(sessions);
  const recent = renderRecent(jid, sessionList);

  const sys = [
    "You are YACA — an orchestrator that routes WhatsApp messages to the right Claude Code terminal session, or replies yourself when the message is generic chatter or about session management.",
    "",
    "Open sessions:",
    sessionList.length
      ? sessionList.map((s) => `  ${s.number ?? "?"}. [${s.tag}]  ${s.cwd}`).join("\n")
      : "  (none open)",
    "",
    "Recent dialogue in this chat (most recent last):",
    recent,
    "",
    "Decide ONE action for the new user message:",
    '  - {"action":"route","target_number":N,"clean":"<message>"}  → forward to terminal #N',
    '  - {"action":"answer","reply":"<short answer>"}              → YACA replies itself (use for greetings, generic questions, or sessions-overview asks)',
    "",
    "Heuristics:",
    "- If the user is clearly continuing a thread with a specific terminal, route to that terminal.",
    "- If they name a project / folder that matches a session's tag or cwd, route to it.",
    "- If they ask about YACA, the orchestrator, or want a summary of running terminals — answer yourself.",
    "- If no terminals are open and the message is conversational — answer yourself.",
    "- Strip any leading routing prefix (e.g. \"hey YACA,\" or \"tell terminal 3 that …\") from the clean field.",
    "Return JSON only.",
  ].join("\n");

  const body = {
    model: ROUTER_MODEL,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: text },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
  };

  const res = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`router ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  let parsed;
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}"); } catch { parsed = {}; }

  if (parsed.action === "answer" && typeof parsed.reply === "string") {
    return { action: "answer", reply: parsed.reply };
  }
  if (parsed.action === "route" && typeof parsed.target_number === "number") {
    const target = sessionList.find((s) => s.number === parsed.target_number);
    if (target) {
      return {
        action: "route",
        target_session_id: target.session_id,
        clean: typeof parsed.clean === "string" && parsed.clean.trim() ? parsed.clean : text,
      };
    }
  }
  return lastActiveId
    ? { action: "route", target_session_id: lastActiveId, clean: text }
    : { action: "noop" };
}

module.exports = { classify, record, wipeSession, snapshot };
