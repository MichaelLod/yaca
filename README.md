# YACA — Yet Another Cloud Agent

Minimal, WhatsApp-first Claude Code agent. One WhatsApp number, your laptop, file-based memory, and the full Google stack via `gog`. Clone → install → pair → done.

## What it is

- **One WhatsApp line drives N Claude Code terminals.** Route with `<N>`, `#tag`, `!all`, or quote-reply.
- **Persistent daemon** keeps a single Baileys connection alive (WhatsApp caps linked devices at 4 — this way one slot fans out to many sessions).
- **File-based memory.** Conversation history appended to `~/.yaca/memory/daily/YYYY-MM-DD/chat-<jid>.md`. No vector DB. Claude reads it back with Read/Grep.
- **Google connector.** A `gog` MCP tool wraps the [`gog`](https://github.com/…) CLI so Claude can reach Gmail, Calendar, Drive, Docs, Sheets, Contacts, Tasks, Chat, Keep.
- **Safe by default.** Allowlist-gated, destructive tool calls relay to your phone for approval.

## Architecture

```
Phone (WhatsApp)
    ↕  WhatsApp Web Multi-Device (Baileys v7)
src/daemon.cjs              ← persistent, single connection, managed by launchd
    ↕  /tmp/yaca.sock (JSON-line IPC)
src/mcp-client.cjs          ← thin MCP stdio subprocess, one per Claude session
    ├─ emits notifications/claude/channel          ← host-supported injection
    └─ appends meta-only line to inbox-<tag>.log   ← Monitor-based delivery
    ↕
Claude Code (any terminal)
```

State lives in `$YACA_STATE_DIR` (default `~/.yaca`):

```
~/.yaca/
  auth/                    Baileys creds (0700)
  inbox/                   downloaded attachments
  memory/daily/YYYY-MM-DD/ per-chat markdown conversation log
  access.json              allowlist + confirmToken
  daemon.log daemon.pid
  PANIC                    (create to kill the daemon immediately)
```

## Install

```bash
git clone <this repo> ~/Work/YACA
cd ~/Work/YACA
./scripts/install.sh
```

The installer: runs `npm install`, creates `~/.yaca/`, writes an `access.json` template, installs the launchd plist with absolute paths filled in, and writes `.mcp.json`.

Then:

```bash
# 1. Edit ~/.yaca/access.json — add your E.164 number under allowFrom
# 2. Pair WhatsApp (once):
npm run pair
# Scan the QR on your phone > Settings > Linked Devices > Link a Device

# 3. Load the daemon:
launchctl load ~/Library/LaunchAgents/com.yaca.daemon.plist
launchctl start com.yaca.daemon

# 4. Wire Claude Code to it. Add to ~/.zshrc:
alias claude='command claude --dangerously-load-development-channels server:yaca'

# 5. In any Claude Code session that should receive WhatsApp:
/connect-wa
```

Node 20+. Bun not supported (Baileys needs Node WebSocket events).

## Phone commands (handled in the daemon, no Claude turn)

| Command              | Effect                                                                    |
|----------------------|---------------------------------------------------------------------------|
| `!help` / `!?`       | List routing and phone commands                                           |
| `!projects` / `!ls`  | List folders in `$YACA_WORK_ROOT` (default `~/Work`)                      |
| `!spawn <N\|name>`   | Open Terminal + `claude` in that folder                                   |
| `!spawn ... <msg>`   | Trailing text typed as the first prompt                                   |
| `!new <name>`        | `mkdir $YACA_WORK_ROOT/<name>` and spawn claude                           |
| `!kill <N\|tag>`     | SIGTERM session                                                           |
| `!clear <N\|tag>`    | Focus that session's terminal and run `/clear`                            |
| `!all`               | Ask every registered session "what are you working on right now?"         |
| `!all <message>`     | Broadcast `<message>` to every session                                    |

## Routing (phone → Claude)

| Prefix                              | Routes to                                          |
|-------------------------------------|----------------------------------------------------|
| `<N> <message>`                     | session #N (1–99, daemon-assigned)                 |
| `#<tag> <message>`                  | session(s) whose tag matches                       |
| `!all [<message>]`                  | every session                                      |
| *(quote-reply to a tagged outbound)* | session that sent the quoted message              |
| *(none of the above)*               | the active session (sticky: last `<N>`/`#tag`/quote) |

## MCP tools exposed to Claude

| Tool                     | Description                                                    |
|--------------------------|----------------------------------------------------------------|
| `reply`                  | Send text + file attachments                                   |
| `react`                  | Emoji reaction                                                 |
| `progress`               | Rolling status message (edited in place)                       |
| `download_attachment`    | Download media to `~/.yaca/inbox/`                             |
| `fetch_messages`         | Recent messages for a chat (daemon cache)                      |
| `claim_active_session`   | Make this session the untagged-reply target                    |
| `release_active_session` | Release the claim                                              |
| `list_sessions`          | Every registered session                                       |
| `gog`                    | Run the Google CLI — gmail/calendar/drive/docs/sheets/etc.     |

## Memory

The daemon appends every inbound and outbound message to a per-chat markdown file under `~/.yaca/memory/daily/YYYY-MM-DD/chat-<jid>.md`. That's the memory layer — no vector DB, no external service. Claude recalls with Read/Grep across these files.

Why filesystem-only: for a personal agent the filesystem is [surprisingly competitive with vector stores](https://www.letta.com/blog/benchmarking-ai-agent-memory), and keeping the corpus in plain markdown means every other tool (Claude Code's own memory, your editor, grep) just works on it. If recall breaks down at some scale, a tiny sqlite-vec index over the same files is a later add.

## Access control

`~/.yaca/access.json`:

```json
{
  "allowFrom": ["491701234567"],
  "allowGroups": false,
  "allowedGroups": [],
  "requireAllowFromInGroups": false,
  "confirmToken": null
}
```

- `allowFrom: []` — open relay. Don't.
- `allowFrom: ["<E.164>"]` — only your own number.
- `confirmToken`: prefix required for destructive ops to be auto-approved. Set a secret.

## Security

1. **Use `allowFrom`.**
2. **Secondary WhatsApp number recommended** (reduces ban risk with unofficial Baileys clients).
3. **Destructive Claude tools (Write/Edit/Bash) relay to your phone for approval** — approve by replying `yes <token>` / `no <token>`.
4. **Kill switch.** `touch ~/.yaca/PANIC` — daemon polls every 5s and shuts down.
5. **Socket + state are 0700.**
6. **No content in the inbox log** used by the Monitor wake-up. Content only lives in daemon memory + the daily markdown log.

## Connection stability

OpenClaw-derived patterns tuned for 24/7:

| Pattern                | Behavior                                                          |
|------------------------|-------------------------------------------------------------------|
| 515 = normal           | WhatsApp restart → reconnect in 2s                                |
| Never `process.exit`   | Only 440 (conflict) / 401 (logout) halt permanently               |
| Exponential backoff    | factor 1.8, jitter ±25%, max 30s, reset after 60s healthy         |
| Watchdog               | no inbound for 30 min → force reconnect                           |
| Creds backup           | auto-backup before save, auto-restore if corrupt                  |
| Singleton lock         | PID file prevents double-daemon                                   |
| Crypto-err recovery    | Baileys `bad mac` → reconnect, not crash                          |

## Troubleshooting

| Issue                                 | Fix                                                            |
|---------------------------------------|----------------------------------------------------------------|
| `daemon request timeout`              | Daemon not running. `launchctl start com.yaca.daemon` or `npm run daemon`. |
| `WhatsApp not connected`              | Re-pair: `npm run pair`.                                       |
| Inbound reacts ❓                     | No route matched. Use `<N>`, `#tag`, `!all`, or quote-reply.    |
| 440 in daemon.log                     | A 5th linked device replaced the daemon. Unlink, re-pair.      |
| Messages stop silently                | Watchdog reconnects in 30 min, or restart the daemon.          |
| `entries must be tagged`              | Alias must be `server:yaca`, not bare `yaca`.                   |

## Limitations

- WhatsApp has no search API. `fetch_messages` only returns what the daemon has seen since startup (the daily-log files cover history).
- Baileys is an unofficial client — use a secondary WhatsApp account.

## Credits

- [diogo85/claude-code-whatsapp](https://github.com/diogo85/claude-code-whatsapp) — the single-session plugin YACA's daemon forked from.
- [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) — WhatsApp Web MD library.
- [OpenClaw](https://github.com/openclaw/openclaw) — stability patterns.

## License

MIT. See LICENSE.
