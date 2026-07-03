#!/usr/bin/env bash
# Replaces the stale FIXME(side-effect) claim in src/index.ts with a checked fact.
#
# The claim was: "pi -p --no-session clones the repo into the PARENT of cwd, leaving a stale
# directory." Reproducing the exact sign-off judge invocation (pi --mode json -p --no-session,
# read-only tools, edit/write excluded, cwd = here) shows it does not. This script makes that
# reproducible: it runs the invocation, requires pi to actually reach agent_end (so a pass is not
# vacuous), and asserts the parent-of-cwd listing is byte-identical before and after.
#
# Exit 0 = judge leaves no clone in the parent. Exit 1 = either pi did not run, or it polluted.
# Run by hand; re-run as the rigorous sign-off check (the judge has bash and runs this itself).
set -u

PARENT="$(cd "$PWD/.." && pwd)"
before="$(ls -1A "$PARENT" | sort)"

# Cheapest available model; the test exercises pi --no-session's workdir setup, not the output.
out="$(timeout 90 pi --mode json -p --no-session \
  --model 'openrouter/~anthropic/claude-haiku-latest' \
  --tools read,bash,grep,find,ls --exclude-tools edit,write \
  --append-system-prompt 'Reply with exactly: VERDICT: accept' \
  "Reply with exactly: VERDICT: accept" 2>/dev/null || true)"

# Non-vacuous: require pi to have actually completed a turn. A pass without this could mean pi
# crashed instantly and never had the chance to clone -- which would prove nothing.
if ! printf '%s' "$out" | grep -q '"type":"agent_end"'; then
  echo "FAIL: pi --no-session did not reach agent_end; cannot confirm no-clone."
  exit 1
fi

after="$(ls -1A "$PARENT" | sort)"

echo "parent: $PARENT"
echo "--- before ---"; echo "$before"
echo "--- after ---";  echo "$after"

if [ "$before" == "$after" ]; then
  echo "PASS: parent-of-cwd listing identical before/after; no clone created."
  exit 0
fi
echo "FAIL: parent-of-cwd listing changed. Diff (< before, > after):"
diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | head -20
exit 1
