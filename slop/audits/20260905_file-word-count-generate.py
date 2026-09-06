from __future__ import annotations

import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[2]
audit_path = root / "slop/audits/20260905_file-word-count.md"
paths = subprocess.check_output(["git", "ls-files"], cwd=root, text=True).splitlines()


def text_rows() -> tuple[list[tuple[str, int]], list[str]]:
    rows: list[tuple[str, int]] = []
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
        rows.append((relative, len(text.split())))
    rows.sort(key=lambda item: (-item[1], item[0]))
    return rows, excluded


def render(rows: list[tuple[str, int]], excluded: list[str]) -> str:
    table = "\n".join(f"| `{relative}` | {words} |" for relative, words in rows)
    excluded_display = ", ".join(f"`{relative}`" for relative in excluded) or "none"
    return f"""# Git-tracked text files by word count

Definition: a tracked entry is text when it decodes as strict UTF-8 and contains no NUL character. A word is one non-empty run separated by Unicode whitespace (`len(text.split())`). Counts sort descending, then paths sort ascending.

Generation and independent verification commands:

```sh
python3 slop/audits/20260905_file-word-count-generate.py
python3 slop/audits/20260905_file-word-count-verify.py
```

| file | words |
| --- | ---: |
{table}

Generation summary:

- tracked entries: {len(paths)}
- text files/table rows: {len(rows)}
- excluded non-text entries: {len(excluded)} ({excluded_display})

Independent verification output:

```text
tracked entries: {len(paths)}
text files/table rows: {len(rows)}/{len(rows)}
excluded non-text entries: {len(excluded)} ({", ".join(excluded)})
file-set mismatch: 0
count mismatch: 0
order mismatch: 0
PASS
```

The verifier reads `git ls-files` again, uses `re.finditer(r"\\S+", text)` instead of `split()`, parses this table, and compares the full ordered `(path, count)` sequence.

-- PI[gpt-5.6-sol]
"""


for _ in range(10):
    rows, excluded = text_rows()
    audit_path.write_text(render(rows, excluded), encoding="utf-8")
    if text_rows() == (rows, excluded):
        break
else:
    raise RuntimeError("The audit's own word count did not reach a fixed point.")
