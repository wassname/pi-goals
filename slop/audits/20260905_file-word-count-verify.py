from __future__ import annotations

import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
audit = root / "slop/audits/20260905_file-word-count.md"
paths = subprocess.check_output(["git", "ls-files"], cwd=root, text=True).splitlines()
expected: list[tuple[str, int]] = []
excluded: list[str] = []
for relative in paths:
    raw = (root / relative).read_bytes()
    try:
        text = raw.decode("utf-8", "strict")
    except UnicodeDecodeError:
        excluded.append(relative)
        continue
    if "\0" in text:
        excluded.append(relative)
        continue
    expected.append((relative, len(list(re.finditer(r"\S+", text)))))
expected.sort(key=lambda item: (-item[1], item[0]))
rows = re.findall(r"^\| `([^`]+)` \| (\d+) \|$", audit.read_text(encoding="utf-8"), flags=re.MULTILINE)
actual = [(path, int(words)) for path, words in rows]
expected_paths = {path for path, _ in expected}
actual_paths = {path for path, _ in actual}
count_mismatch = sum(1 for path, words in actual if path in expected_paths and dict(expected)[path] != words)
print(f"tracked entries: {len(paths)}")
print(f"text files/table rows: {len(expected)}/{len(actual)}")
print(f"excluded non-text entries: {len(excluded)} ({', '.join(excluded)})")
print(f"file-set mismatch: {len(expected_paths ^ actual_paths)}")
print(f"count mismatch: {count_mismatch}")
print(f"order mismatch: {int(actual != expected)}")
if actual != expected:
    raise SystemExit("FAIL")
print("PASS")
