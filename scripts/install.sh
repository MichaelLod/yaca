#!/usr/bin/env bash
# YACA one-shot installer.
# - Installs npm deps
# - Creates $YACA_STATE_DIR (default: ~/.yaca)
# - Installs launchd plist with absolute paths filled in
# - Writes ~/.mcp.json if missing, adding the YACA MCP server
#
# Does NOT pair — run `npm run pair` once after this to link your WhatsApp.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${YACA_STATE_DIR:-$HOME/.yaca}"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then echo "node not found in PATH" >&2; exit 1; fi

echo "YACA installer"
echo "  repo:       $REPO_ROOT"
echo "  state dir:  $STATE_DIR"
echo "  node:       $NODE_BIN"
echo

echo "[1/4] Installing dependencies..."
(cd "$REPO_ROOT" && npm install --silent)

echo "[2/4] Creating state dir..."
mkdir -p "$STATE_DIR/auth" "$STATE_DIR/inbox" "$STATE_DIR/memory/daily"
chmod 700 "$STATE_DIR" "$STATE_DIR/auth"
if [ ! -f "$STATE_DIR/access.json" ]; then
  cat > "$STATE_DIR/access.json" <<'JSON'
{
  "allowFrom": [],
  "allowGroups": false,
  "allowedGroups": [],
  "requireAllowFromInGroups": false,
  "confirmToken": null
}
JSON
  chmod 600 "$STATE_DIR/access.json"
  echo "     wrote default access.json — EDIT before opening to others"
fi

echo "[3/4] Installing launchd plist..."
PLIST_SRC="$REPO_ROOT/com.yaca.daemon.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.yaca.daemon.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|/usr/local/bin/node|$NODE_BIN|g" \
    -e "s|/ABSOLUTE/PATH/TO/YACA|$REPO_ROOT|g" \
    -e "s|/ABSOLUTE/PATH/TO/HOME|$HOME|g" \
    "$PLIST_SRC" > "$PLIST_DST"
echo "     wrote $PLIST_DST"
echo "     launchctl load $PLIST_DST  (run after pairing)"

echo "[4/4] Writing .mcp.json example..."
MCP_EX="$REPO_ROOT/.mcp.json"
if [ ! -f "$MCP_EX" ]; then
  cat > "$MCP_EX" <<JSON
{
  "mcpServers": {
    "yaca": {
      "command": "$NODE_BIN",
      "args": ["$REPO_ROOT/src/mcp-client.cjs"]
    }
  }
}
JSON
  echo "     wrote $MCP_EX"
else
  echo "     $MCP_EX already exists — leaving it alone"
fi

echo
echo "Next:"
echo "  1. Edit $STATE_DIR/access.json and add your phone number under allowFrom"
echo "  2. Pair once:  cd $REPO_ROOT && npm run pair"
echo "  3. Load daemon:  launchctl load $PLIST_DST"
echo "  4. Add this to ~/.zshrc:"
echo "       alias claude='command claude --dangerously-load-development-channels server:yaca'"
echo "  5. In a Claude session, run /connect-wa if you want the Monitor wake-up"
