# PI/Claude 2026-11-07: which events in a Pi session led to the most agent work.
# Splits the session at each incoming event and credits following assistant messages to the latest event.
# Steered messages arrive mid-turn, so credit is approximate. Usage: python 20261107_wake_sources.py <session.jsonl>
import json, re, sys
from collections import defaultdict
from datetime import datetime

def text_of(content):
    return content if isinstance(content, str) else " ".join(p.get("text", "") for p in content if isinstance(p, dict))

def classify(e):
    if e["type"] == "message" and e["message"]["role"] == "user":
        t = text_of(e["message"]["content"]).lstrip()
        if t.startswith("[pi-goals: loop]"): return "pi-goals loop reminder"
        if t.startswith("[Scheduled task"): return "agent's own timer: " + (re.search(r"Name: (\S+)", t) or [None, "?"])[1]
        if t.startswith("Inspect subagent updates"): return "pi-subagents wake line"
        return "human (wassname)"
    if e["type"] == "custom_message":
        c = e.get("customType", "")
        if c == "intercom_message":
            name = e["details"]["from"].get("name") or "?"
            return "intercom from " + (name if not name.startswith("subagent-chat") else "subagent-chat")
        if c == "ad-process:notification":
            k = re.search(r'kind="(\w+)"', text_of(e["content"]) if not isinstance(e["content"], str) else e["content"])
            return "process " + (k[1] if k else "?")
        if c.startswith("subagent"): return "pi-subagents " + c
        if c == "pi-hooks": return "lint hook nudge"
    return None

rows = defaultdict(lambda: dict(n=0, acted=0, assistant=0, tools=0, sends=0, user_chars=0, minutes=0.0))
cur, cur_t, acted = None, None, False
ts = lambda e: datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00"))
for line in open(sys.argv[1]):
    e = json.loads(line)
    src = classify(e)
    if src:
        if cur: rows[cur]["minutes"] += (ts(e) - cur_t).total_seconds() / 60
        cur, cur_t = src, ts(e)
        rows[cur]["n"] += 1
        acted = False
        continue
    if cur and e["type"] == "message" and e["message"]["role"] == "assistant":
        r = rows[cur]
        r["assistant"] += 1
        parts = e["message"]["content"]
        calls = [p for p in parts if p.get("type") == "toolCall"]
        r["tools"] += len(calls)
        r["sends"] += sum(1 for p in calls if p["name"] == "intercom" and p["arguments"].get("action") in ("send", "ask", "reply"))
        if not calls: r["user_chars"] += sum(len(p.get("text", "")) for p in parts if p.get("type") == "text")
        if calls and not acted: r["acted"] += 1; acted = True

print("| source | events | led to work | tool calls | intercom sends | chars to user | agent-hours until next event |")
print("|---|--:|--:|--:|--:|--:|--:|")
for src, r in sorted(rows.items(), key=lambda kv: -kv[1]["tools"]):
    if r["n"] < 3: continue
    print(f"| {src} | {r['n']} | {r['acted']} | {r['tools']} | {r['sends']} | {r['user_chars']} | {r['minutes']/60:.1f} |")
