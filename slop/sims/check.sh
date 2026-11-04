#!/bin/sh
# Sim watcher: herdr status + last session entry + bottom of the screen (dialogs hide behind "done"). -- PI/Claude
F=$(ls -t ~/.pi/agent/sessions/--home-code-sims-tv-sim--/*.jsonl | head -1)
timeout 10 herdr agent get tvsim | grep -o '"agent_status":"[a-z]*"'
tail -1 "$F" | python3 -c 'import sys,json; e=json.loads(sys.stdin.read()); m=e.get("message") or {}; print("last:", m.get("role") or e.get("customType") or e.get("type"), m.get("stopReason",""))'
timeout 10 herdr agent read tvsim --source visible 2>/dev/null | grep -v "^ *$" | grep -iv "tok/s\|…\|ago\|[0-9]s ·" | tail -4
