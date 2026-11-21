import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExtraction } from "../src/temporal";
const messages = [
  {
    message_id: "a",
    role: "user" as const,
    content: "I moved in May 2024.",
    occurred_at: "2024-05-10T00:00:00Z",
  },
  {
    message_id: "b",
    role: "user" as const,
    content: "That is right.",
    occurred_at: "2024-05-11T00:00:00Z",
  },
];
const fact = () => ({
  content: "The user moved in May 2024.",
  subject: "the user",
  reporter: "the user",
  certainty: "asserted",
  fact_time: {
    start: "2024-05-01",
    end: "2024-05-31",
    precision: "month",
    evidence: [{ message_id: "a", expression: "May 2024" }],
  },
  any_of: [{ all_of: ["a"] }],
});
test("normalizes any_of/all_of and keeps only supplied user buckets", () => {
  const result = normalizeExtraction(
    {
      messages: [
        { message_id: "a", facts: [fact()] },
        { message_id: "b", facts: [] },
      ],
    },
    messages,
  );
  assert.deepEqual(result[0].support_groups, [["a"]]);
  assert.equal(result[0].fact_time?.precision, "month");
  assert.throws(() =>
    normalizeExtraction(
      { messages: [{ message_id: "a", facts: [fact()] }] },
      messages,
    ),
  );
});
test("rejects time anchors outside evidence and invented quotes", () => {
  const invalid = [
    { ...fact(), any_of: [{ all_of: ["b"] }] },
    {
      ...fact(),
      fact_time: {
        ...fact().fact_time,
        evidence: [{ message_id: "a", expression: "April" }],
      },
    },
  ];
  for (const f of invalid)
    assert.throws(() =>
      normalizeExtraction(
        {
          messages: [
            { message_id: "a", facts: [f] },
            { message_id: "b", facts: [] },
          ],
        },
        messages,
      ),
    );
});
test("rejects incorrect calendar boundaries and duplicated independent groups", () => {
  const invalid = [
    { ...fact(), fact_time: { ...fact().fact_time, end: "2024-05-30" } },
    { ...fact(), any_of: [{ all_of: ["a"] }, { all_of: ["a"] }] },
  ];
  for (const f of invalid)
    assert.throws(() =>
      normalizeExtraction(
        {
          messages: [
            { message_id: "a", facts: [f] },
            { message_id: "b", facts: [] },
          ],
        },
        messages,
      ),
    );
});
