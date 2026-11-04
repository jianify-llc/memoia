import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExtraction } from "../src/temporal";

const messages = [
  {
    message_id: "a",
    role: "user" as const,
    content: "I moved in May.",
    occurred_at: "2024-05-01T00:00:00Z",
  },
  {
    message_id: "b",
    role: "user" as const,
    content: "It was 2024.",
    occurred_at: "2024-05-02T00:00:00Z",
  },
  {
    message_id: "assistant",
    role: "assistant" as const,
    content: "May 2024?",
    occurred_at: "2024-05-03T00:00:00Z",
  },
];
const fact = {
  content: "The user moved in May 2024.",
  subject: "the user",
  reporter: "the user",
  certainty: "asserted",
  fact_time: null,
  any_of: [{ all_of: ["a", "b"] }],
};
const response = (f: unknown) => ({
  messages: [
    { message_id: "a", facts: [f] },
    { message_id: "b", facts: [] },
  ],
});

test("joint support is retained; unknown, assistant-only, and wrong-bucket support are rejected", () => {
  assert.deepEqual(
    normalizeExtraction(response(fact), messages)[0].support_groups,
    [["a", "b"]],
  );
  for (const all_of of [["missing"], ["assistant"], ["b"]])
    assert.throws(() =>
      normalizeExtraction(
        response({ ...fact, any_of: [{ all_of }] }),
        messages,
      ),
    );
});

test("empty user buckets are valid and duplicate or missing buckets cannot silently lose facts", () => {
  assert.deepEqual(
    normalizeExtraction(
      {
        messages: [
          { message_id: "a", facts: [] },
          { message_id: "b", facts: [] },
        ],
      },
      messages,
    ),
    [],
  );
  for (const buckets of [
    [{ message_id: "a", facts: [] }],
    [
      { message_id: "a", facts: [] },
      { message_id: "a", facts: [] },
    ],
  ])
    assert.throws(() => normalizeExtraction({ messages: buckets }, messages));
});
