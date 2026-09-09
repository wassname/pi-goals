import assert from "node:assert/strict";
import test from "node:test";
import { goalReviewWire, isWire } from "../../src/internal/supervisor/protocol.js";
import { MAX_VIEW_BYTES } from "../../src/internal/supervisor/view.js";

test("goal_review accepts an optional bounded snapshot but rejects malformed snapshots", () => {
  const review = { t: "goal_review", to: "supervisor", requestId: "request", bindingId: "binding", goal: "first", planHash: "hash" };
  assert.equal(isWire(review), true, "older peers can omit the optional snapshot");
  assert.equal(isWire({ ...review, view: "Fresh worker evidence" }), true);
  for (const view of [null, false, 1, {}, [], "x".repeat(MAX_VIEW_BYTES + 1)]) {
    assert.equal(isWire({ ...review, view }), false);
  }
});

test("worker completion metadata is optional but cannot claim malformed counts", () => {
  const view = { t: "view", to: "supervisor", view: "Worker evidence", stopped: true };
  const completion = { planHash: "hash", total: 2, pending: 1, inconclusive: 1 };
  assert.equal(isWire(view), true);
  assert.equal(isWire({ ...view, completion }), true);
  for (const bad of [null, {}, { ...completion, total: -1 }, { ...completion, pending: 0.5 }, { ...completion, inconclusive: 2 }, { ...completion, total: Infinity }, { ...completion, total: "2" }, { ...completion, planHash: false }]) assert.equal(isWire({ ...view, completion: bad }), false);
});

test("checkpoint snapshot bounding counts JSON escapes and does not split Unicode characters", () => {
  const review = { requestId: "request", bindingId: "binding", goal: "goal ".repeat(1800), planHash: "hash" };
  const wire = goalReviewWire("supervisor", review, '😀\\"\n'.repeat(2000));
  assert.equal(isWire(wire), true);
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) <= 16 * 1024);
  assert.equal(wire.t, "goal_review");
  if (wire.t !== "goal_review") assert.fail("Expected a checkpoint request");
  assert.equal(wire.goal, review.goal);
  assert.doesNotMatch(wire.view!, /�|\\ud83d(?!\\ude00)|(?<!\\ud83d)\\ude00/u);
  assert.match(wire.view!, /cut to fit/);
});
