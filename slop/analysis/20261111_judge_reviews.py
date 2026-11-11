"""Judge verdicts and goals-file sizes across /workspace projects. -- PI/Claude 2026-11-11

Run: python3 slop/analysis/20261111_judge_reviews.py [workspace root, default /workspace]
Reads */.pi/goals/reviews/*.json (one per CompleteGoal call) and */.pi/goals/*.md.
Copied repos share review files; reviews are counted once per file name (a UUID).
Reject reasons are keyword matches on the judge's `missing` text: rough, and one review can match several.
"""
import collections
import glob
import json
import os
import re
import sys

root = sys.argv[1] if len(sys.argv) > 1 else "/workspace"
paths = glob.glob(f"{root}/*/*/.pi/goals/reviews/*.json") + glob.glob(f"{root}/*/.pi/goals/reviews/*.json")

reviews = {}
for path in sorted(paths):
    name = os.path.basename(path)
    if name in reviews:
        continue
    try:
        data = json.load(open(path))
    except json.JSONDecodeError:
        continue
    result = data.get("result")
    if isinstance(result, dict) and result.get("ok"):
        reviews[name] = (os.path.getmtime(path), data["goal"], data["goals"], result["verdict"], (result.get("model") or "?").split("/")[-1])

verdicts = collections.Counter(v["verdict"] for *_, v, _ in reviews.values())
print(f"judged reviews: {len(reviews)}  {dict(verdicts)}")

by_model = collections.defaultdict(collections.Counter)
for *_, v, model in reviews.values():
    by_model[model][v["verdict"]] += 1
for model, c in by_model.items():
    print(f"  judge {model}: n={sum(c.values())} accept {c['accept'] / sum(c.values()):.0%}")

by_goal = collections.defaultdict(list)
for at, goal, text, v, _ in reviews.values():
    by_goal[goal.strip().lower()].append((at, v["verdict"], text, goal))
tries, first = [], collections.Counter()
for rows in by_goal.values():
    rows.sort()
    seq = [r[1] for r in rows]
    first[seq[0]] += 1
    if "accept" in seq:
        tries.append(seq.index("accept") + 1)
print(f"goals: {len(by_goal)}  first verdict {dict(first)}  tries until accept {sorted(collections.Counter(tries).items())}  never accepted {len(by_goal) - len(tries)}")

REASONS = {
    "discriminator not shown": r"discriminator",
    "failure mode not ruled out": r"failure mode|ruled out|rule out",
    "fidelity to the user": r"substitut|user voice|user asked|user's|intended outcome|fidelity",
    "provenance": r"provenance|how .* produced|not saved",
    "open tasks remain": r"open task|unfinished task|\[ \]|\[/\]",
    "quote does not match file": r"does not match|not match the file|reconstruct|not found in|does not exist",
    "empty evidence": r"empty|placeholder|no evidence",
}
rejects = [v["missing"].lower() for *_, v, _ in reviews.values() if v["verdict"] == "reject"]
print(f"reject reasons (keyword, n={len(rejects)}):")
for label, pattern in REASONS.items():
    n = sum(bool(re.search(pattern, text)) for text in rejects)
    print(f"  {n / len(rejects):4.0%} {label}")
checks = sorted(len(v["checks"]) for *_, v, _ in reviews.values())
print(f"files cited per review: median {checks[len(checks) // 2]}, min {checks[0]}, max {checks[-1]}")


def discriminator(text: str, goal: str) -> str | None:
    """The goal's discriminator field, whitespace-normalised. Regex on prose: approximate."""
    start = re.search(r"^[ \t]*\d+\. \[.\] goal: *" + re.escape(goal.strip()), text, re.M | re.I)
    if not start:
        return None
    rest = text[start.end():]
    end = re.search(r"^\d+\. \[.\] goal:|^## ", rest, re.M)
    block = rest[: end.start()] if end else rest
    field = re.search(r"^\s*- discriminator[^:\n]*:(.*?)(?=^\s{0,5}- [a-z ]+[:(]|\Z)", block, re.M | re.S)
    return re.sub(r"\s+", " ", field.group(1)).strip() if field else None


pairs = changed = changed_then_accepted = 0
for rows in by_goal.values():
    for a, b in zip(rows, rows[1:]):
        if a[1] != "reject":
            continue
        pairs += 1
        if discriminator(a[2], a[3]) != discriminator(b[2], b[3]):
            changed += 1
            changed_then_accepted += b[1] == "accept"
print(f"reject then retry: {pairs} pairs; discriminator text changed in {changed}; of those the retry was accepted in {changed_then_accepted}")

print("\ngoals-file size in chars (newest 12): total = above Log + Log + Interview")
files = [f for f in glob.glob(f"{root}/*/*/.pi/goals/*.md") + glob.glob(f"{root}/*/.pi/goals/*.md") if not os.path.islink(f.split("/.pi/")[0])]
for path in sorted(files, key=os.path.getmtime)[-12:]:
    text = open(path).read()
    log = text.find("\n## Log")
    log = log if log >= 0 else len(text)
    interview = text.find("\n## Interview")
    interview = interview if interview >= 0 else len(text)
    print(f"  {len(text):7d} = {log:6d} + {max(0, interview - log):6d} + {len(text) - interview:6d}  {path.removeprefix(root + '/')}")
