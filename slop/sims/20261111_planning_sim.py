"""Planning simulation over Pi's RPC mode: no terminal, no human. -- PI/Claude 2026-11-11

Run: python3 slop/sims/20261111_planning_sim.py <pi-goals dir to load> <project dir> <out dir> [model]

Three user turns: the seed (`/goals new ...`), fixed answers, then "ok ready" typed in chat.
The review menu is always answered "Discuss in chat", so work never starts.
Writes <out>/events.jsonl (assistant messages, tool calls, review menus, per turn) and <out>/goals.md.
Limits: the answers are fixed, so they may not match the questions a run asks; the project has no .env.
"""
import json
import pathlib
import queue
import shutil
import subprocess
import sys
import threading
import time

ext, project, out = (pathlib.Path(p).resolve() for p in sys.argv[1:4])
model = sys.argv[4] if len(sys.argv) > 4 else "openai-codex/gpt-6.1-sol"
deps = pathlib.Path(__file__).resolve().parents[2] / "node_modules"
inputs = pathlib.Path(__file__).resolve().parent / "inputs"
TURNS = [(inputs / "01_seed.txt").read_text().strip(), (inputs / "03_answers_fixed.txt").read_text().strip(), "ok ready"]
TURN_TIMEOUT_S = 1500

out.mkdir(parents=True, exist_ok=True)
proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-extensions", "-e", str(ext / "src/index.ts"), "-e", str(deps / "pi-subagents/index.js"),
     "-e", str(deps / "@jl1990/pi-scheduler/extensions/scheduler/index.ts"), "--session-dir", str(out / "sessions"), "--model", model],
    cwd=project, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(out / "stderr.txt", "w"), text=True)
events: queue.Queue = queue.Queue()
threading.Thread(target=lambda: [events.put(line) for line in proc.stdout] and None, daemon=True).start()
log = open(out / "events.jsonl", "w")


def send(obj: dict) -> None:
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def record(turn: int, kind: str, **data) -> None:
    log.write(json.dumps({"turn": turn, "kind": kind, **data}, ensure_ascii=False) + "\n")
    log.flush()


def run_turn(turn: int, message: str) -> None:
    send({"id": f"turn-{turn}", "type": "prompt", "message": message})
    deadline, started, settled_at = time.time() + TURN_TIMEOUT_S, False, None
    while time.time() < deadline:
        # After the run settles, wait a little for a review menu queued by RequestPlanReview.
        if settled_at and time.time() - settled_at > 8:
            return
        try:
            event = json.loads(events.get(timeout=2))
        except queue.Empty:
            continue
        kind = event.get("type")
        if kind == "agent_start":
            started, settled_at = True, None
        elif kind == "agent_settled" and started:
            settled_at = time.time()
        elif kind == "message_end" and event["message"].get("role") == "assistant":
            parts = event["message"].get("content", [])
            text = "".join(p.get("text", "") for p in parts if p.get("type") == "text")
            calls = [{"name": p.get("name"), "args": p.get("arguments")} for p in parts if p.get("type") == "toolCall"]
            record(turn, "assistant", text=text, calls=calls)
        elif kind == "extension_ui_request" and event.get("method") in ("select", "confirm", "input", "editor"):
            record(turn, "menu", method=event["method"], title=event.get("title"), options=event.get("options"))
            reply = {"value": "Discuss in chat"} if event["method"] == "select" else {"cancelled": True}
            send({"type": "extension_ui_response", "id": event["id"], **reply})
    record(turn, "timeout")
    raise TimeoutError(f"turn {turn} did not settle in {TURN_TIMEOUT_S}s")


try:
    for number, message in enumerate(TURNS, 1):
        run_turn(number, message)
finally:
    goals = sorted((project / ".pi/goals").glob("*.md"), key=lambda p: p.stat().st_mtime)
    if goals:
        shutil.copy(goals[-1], out / "goals.md")
    proc.terminate()
print("done", out)
