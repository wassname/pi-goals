"""Mechanical checks on planning-simulation runs. -- PI/Claude 2026-11-11

Run: python3 slop/sims/20261111_planning_checks.py <run dir> [...]
Each row is one behaviour the planning prompt asks for. Regex on prose: read the transcripts before trusting a cell.
"""
import json
import pathlib
import re
import sys

HEADINGS = ["Loop statement", "User-visible result", "Review preview", "User voice", "Goals", "Resources", "Out of scope", "Log", "Interview"]


def section(text: str, name: str) -> str:
    match = re.search(rf"^## {re.escape(name)}\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    return match.group(1).strip() if match else ""


def checks(run: pathlib.Path) -> dict[str, object]:
    events = [json.loads(line) for line in open(run / "events.jsonl")]
    goals = (run / "goals.md").read_text()
    turn = lambda n: [e for e in events if e["turn"] == n]
    calls = lambda n: [c["name"] for e in turn(n) for c in e.get("calls", [])]
    said = lambda n: "\n".join(e.get("text", "") for e in turn(n) if e["kind"] == "assistant")
    last = lambda n: next((e["text"] for e in reversed(turn(n)) if e["kind"] == "assistant" and e["text"].strip()), "")
    goal_blocks = re.split(r"^(?=\d+\. \[.\] goal:)", section(goals, "Goals"), flags=re.M)[1:]
    tasks = [re.findall(r"^\s+\d+\. \[.\] (.+)$", block, re.M) for block in goal_blocks]
    preview = section(goals, "Review preview").split("\n")
    edits = [c["args"].get("path", "") for e in events for c in e.get("calls", []) if c["name"] in ("edit", "write")]
    return {
        "turn 1: questions with a recommendation": len(re.findall(r"^\s*\d+\.\s", last(1), re.M)) and len(re.findall(r"[Rr]ecommend", last(1))),
        "turn 1: predicts the user's choice": bool(re.search(r"predict|I expect you|my guess is you", said(1), re.I)),
        "turn 1: mock-up table pasted in chat": last(1).count("\n|") >= 3,
        "turn 1: mock-up has 'What I checked'": "What I checked" in last(1),
        "turn 1: review menu requested (should be no)": "RequestPlanReview" in calls(1),
        "turn 1: tool calls": len(calls(1)),
        "turn 2: review menu requested": "RequestPlanReview" in calls(2),
        "turn 2: also asks a question (should be no)": last(2).rstrip().endswith("?"),
        "turn 3: review menu requested": "RequestPlanReview" in calls(3),
        "turn 3: other tool calls (should be none)": [c for c in calls(3) if c != "RequestPlanReview"],
        "edits outside the goals file and slop/": [p for p in edits if ".pi/goals/" not in p and "slop/" not in p],
        "file: template headings missing": [h for h in HEADINGS if f"\n## {h}\n" not in goals],
        "file: goals": len(goal_blocks),
        "file: tasks per goal": [len(t) for t in tasks],
        "file: a goal ends with a brainstorm-and-keep-going task": any(t and re.search(r"brainstorm", t[-1], re.I) for t in tasks),
        "file: ideas the user named that have their own task": sum(any(re.search(pattern, label, re.I) for t in tasks for label in t) for pattern in ("MFV|WVS", "primer", "tradition", "duel", "language", "long")),
        "file: User voice quotes": section(goals, "User voice").count("> "),
        "file: Resources entries": len(re.findall(r"^- ", section(goals, "Resources"), re.M)),
        "file: Review preview lines / widest": f"{len(preview)} / {max(map(len, preview))}",
        "file: Interview entries (3 sent)": len(re.findall(r"^### \d{4}-", section(goals, "Interview"), re.M)),
        "file: chars above Log": goals.find("\n## Log"),
    }


runs = [pathlib.Path(p) for p in sys.argv[1:]]
rows = [checks(run) for run in runs]
print("| check | " + " | ".join(run.name for run in runs) + " |")
print("|:--|" + ":--|" * len(runs))
for key in rows[0]:
    print(f"| {key} | " + " | ".join(str(row[key]) for row in rows) + " |")
