#!/usr/bin/env bash
# Debug wrapper: tees stdin/stdout/stderr to files while running mcp-client.cjs
LOG_DIR="$HOME/.yaca/wrap-logs"
mkdir -p "$LOG_DIR"
TS=$(date +%s)
IN="$LOG_DIR/stdin-$TS.log"
OUT="$LOG_DIR/stdout-$TS.log"
ERR="$LOG_DIR/stderr-$TS.log"
echo "=== wrap started pid=$$ ts=$TS ===" >> "$ERR"
tee -a "$IN" | node /Users/michael/Work/YACA/src/mcp-client.cjs 2>> "$ERR" | tee -a "$OUT"
echo "=== wrap exit code=$? ts=$(date +%s) ===" >> "$ERR"
