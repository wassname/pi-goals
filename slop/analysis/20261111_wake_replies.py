"""What the agent did after each short-format loop reminder. -- PI/Claude 2026-11-11

Run: python3 slop/analysis/20261111_wake_replies.py <session.jsonl> [...]
For each reminder: the first three listed tasks, the start of the agent's first reply, and its tool calls until the next user-role message.
"""
import collections
import json
import sys

MARK = "[pi-goals: loop] Automated reminder, not a message from the user. It fires every"


def text(message: dict) -> str:
    content = message.get("content")
    return content if isinstance(content, str) else " ".join(part.get("text", "") for part in content if part.get("type") == "text")


for path in sys.argv[1:]:
    print(f"===== {path}")
    rows = []
    for line in open(path):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("type") == "message":
            rows.append((entry.get("timestamp"), entry["message"]))
    for i, (stamp, message) in enumerate(rows):
        if message.get("role") != "user" or MARK not in text(message):
            continue
        wake = text(message)
        tasks = wake.split("longest unchanged first:")[1].strip().split("\n")[:3] if "longest unchanged first:" in wake else []
        replies, tools = [], collections.Counter()
        for _, later in rows[i + 1:]:
            if later.get("role") == "user":
                break
            if later.get("role") == "assistant":
                if text(later).strip():
                    replies.append(text(later).strip())
                tools.update(part.get("name") for part in later.get("content", []) if isinstance(part, dict) and part.get("type") == "toolCall")
        print(f"\n[{stamp}] reminder {len(wake)} chars; tasks listed: {[t[:90] for t in tasks] or 'none'}")
        print("  reply:", (replies[0][:420] if replies else "(none)").replace("\n", " / "))
        print("  tools:", dict(tools))
