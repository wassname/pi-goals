#!/usr/bin/env bash
# Structural gate for the goal's `verify:` field. Cheap and deterministic: no API calls.
# Confirms (a) neither stale FIXME tag remains in src/, (b) the footprint script exists, and
# (c) the plan-injection heading prefix is still emitted. The rigorous runtime check (running
# the footprint script) is the sign-off judge's job -- it has bash and re-runs the script itself.
set -u
fail() { echo "FAIL: $1"; exit 1; }

grep -rnE 'FIXME\((heading|side-effect)\)' src/ >/dev/null 2>&1 && fail "a stale FIXME(heading|side-effect) is still in src/"
test -f scripts/check-judge-footprint.sh || fail "scripts/check-judge-footprint.sh is missing"
grep -q '\.pi/goals\.md:' src/prompts.ts || fail "the .pi/goals.md: heading prefix was dropped from src/prompts.ts"

echo "PASS: stale FIXMEs gone, footprint script present, heading prefix intact."
exit 0
