import test from "node:test";
import assert from "node:assert/strict";
import cases from "./business-parity-quality-cases.json";
import { normalizeExtraction } from "../src/temporal";

type Fact = {
  content: string;
  subject: string;
  certainty: string;
  support_groups: string[][];
};
// This is a fixed-case scorer for local examples, not a live-model quality measurement.
function grade(name: string, facts: Fact[]): boolean {
  if (name === "smalltalk") return facts.length === 0;
  if (name === "reported_uncertainty") {
    const busy = facts.find((f) => /busy/i.test(f.content));
    const guess = facts.find((f) => /might.*quit/i.test(f.content));
    return (
      facts.length === 2 &&
      !!busy &&
      !!guess &&
      busy.subject === "Zhou" &&
      guess.subject === "Zhou" &&
      guess.certainty === "uncertain" &&
      facts.every((f) => JSON.stringify(f.support_groups) === '[["u-busy"]]')
    );
  }
  return (
    facts.length === 1 &&
    /rooibos/i.test(facts[0].content) &&
    !/favorite drink is coffee/i.test(facts[0].content) &&
    JSON.stringify(facts[0].support_groups) === '[["u-correct"]]'
  );
}
for (const example of cases)
  test(`quality fixture: ${example.name}`, () => {
    const messages = example.messages.map((m) => ({
      ...m,
      role: m.role as "user",
    }));
    const response = {
      messages: messages.map((m) => ({
        message_id: m.message_id,
        facts: example.facts.filter((f) =>
          f.any_of.some((g) => g.all_of.includes(m.message_id)),
        ),
      })),
    };
    const extracted = normalizeExtraction(response, messages) as Fact[];
    assert.equal(grade(example.name, extracted), true);
    if (example.name === "reported_uncertainty") {
      assert.equal(
        grade(
          example.name,
          extracted.map((f) =>
            f.content.includes("might") ? { ...f, certainty: "asserted" } : f,
          ),
        ),
        false,
      );
      assert.equal(
        grade(
          example.name,
          extracted.map((f) => ({ ...f, subject: "user" })),
        ),
        false,
      );
    } else if (example.name === "corrected_preference") {
      assert.equal(
        grade(example.name, [{ ...extracted[0], support_groups: [["u-old"]] }]),
        false,
      );
    } else {
      assert.equal(
        grade(example.name, [
          {
            content: "invented",
            subject: "user",
            certainty: "asserted",
            support_groups: [["u-hello"]],
          },
        ]),
        false,
      );
    }
  });
