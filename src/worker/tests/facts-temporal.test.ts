import test from "node:test";
import assert from "node:assert/strict";
import {
  retainedGroups,
  supportedFactTime,
  renderSearchFact,
  evidenceTime,
  sourceObservations,
} from "../src/temporal";

test("retraction removes whole AND groups while preserving independent alternatives and time only with its anchor", () => {
  const groups = [["a", "b"], ["c"], ["d", "e"]];
  const time = {
    start: "2024-05-01",
    end: "2024-05-31",
    precision: "month" as const,
    evidence: [{ message_id: "a", expression: "May" }],
  };
  const surviving = retainedGroups(groups, ["b"]);
  assert.deepEqual(surviving, [["c"], ["d", "e"]]);
  assert.equal(supportedFactTime(time, surviving), null);
  assert.equal(
    renderSearchFact("Fact", supportedFactTime(time, surviving)),
    "Fact",
  );
  assert.equal(
    renderSearchFact("Fact", time),
    "Fact\n[Event time: 2024-05; precision: month]",
  );
});
test("recording time and observations derive only from surviving support", () => {
  const messages = [
    { message_id: "x", occurred_at: "2025-01-02T00:00:00Z", time_zone: "UTC" },
    { message_id: "y", occurred_at: "2025-03-02T00:00:00Z", time_zone: null },
    { message_id: "z", occurred_at: "2026-01-01T00:00:00Z" },
  ];
  assert.equal(evidenceTime([["x", "y"]], messages), "2025-03-02T00:00:00Z");
  assert.deepEqual(sourceObservations([["x"]], messages), [
    { message_id: "x", recorded_at: "2025-01-02T00:00:00Z", time_zone: "UTC" },
  ]);
  assert.throws(() => evidenceTime([["absent"]], messages));
});

test("preserves microsecond order in recording timestamps", () => {
  const messages = [
    { message_id: "a", occurred_at: "2024-01-01T00:00:00.123001Z" },
    { message_id: "b", occurred_at: "2024-01-01T00:00:00.123999Z" },
  ];
  assert.equal(evidenceTime([["b", "a"]], messages), messages[1].occurred_at);
});
