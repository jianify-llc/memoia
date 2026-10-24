import type { BlobImport, Evidence, Events, FactTime, MemoiaClient, QueriedEvents, Search, UpdateFact, Usage } from "../dist/index.js";
// @ts-expect-error The old public time type has been removed.
import type { EventTime } from "../dist/index.js";

declare const client: MemoiaClient;
const user = "11111111-1111-4111-8111-111111111111";
const input: BlobImport = {
  idempotency_key: "batch:1",
  source_id: "source:1",
  messages: [{ message_id: "1", role: "user", content: "Tokyo", occurred_at: "2026-10-22T00:00:00Z" }],
};
client.importBlob(user, input);
// @ts-expect-error Fact imports no longer expose reasoning mode.
client.importBlob(user, { ...input, reasoning_mode: "standard" });
// @ts-expect-error Pro is not part of the import contract.
client.importBlob(user, { ...input, reasoning_mode: "pro" });
// @ts-expect-error No mode values are accepted.
client.importBlob(user, { ...input, reasoning_mode: "plus" });
// @ts-expect-error Optional defaults do not make required messages optional.
client.importBlob(user, { idempotency_key: "batch:1", source_id: "source:1" });
// @ts-expect-error The separate policy sync API has been removed.
client.setReasoningPolicy(user, {});

const factTime: FactTime = { start: "2026-10-22", end: "2026-10-22", precision: "day", evidence: [{ message_id: "1", expression: "today" }] };
declare const evidence: Evidence;
const revision: number = evidence.revision;
const certainty: "asserted" | "reported" | "uncertain" | "legacy" = evidence.certainty;
declare const usage: Usage["usages"][number];
const totalTokens: number = usage.total_input_token + usage.total_output_token;
const totalInserts: number = usage.total_insert + usage.total_success_insert;
const completeUsage: boolean = usage.usage_complete;
const observedTime: FactTime | null | undefined = evidence.fact_time;
declare const correction: UpdateFact;
client.updateFact(user, user, { ...correction, fact_time: factTime });
// @ts-expect-error The old public field is not accepted in corrections.
client.updateFact(user, user, { ...correction, event_time: factTime });
// @ts-expect-error Recording instants are not calendar dates.
const invalidTime: FactTime = { ...factTime, precision: "instant" };

declare const event: Events["events"][number]["event_data"];
declare const queriedEvent: QueriedEvents["events"][number]["event_data"];
declare const searchEvent: Search["events"][number];
const storyTime: string | null | undefined = event.event_time;
const queriedStoryTime: string | null | undefined = queriedEvent.event_time;
const searchedStoryTime: string | null | undefined = searchEvent.event_time;
// @ts-expect-error Story time uses event_time, not the retired time field.
event.time;
// @ts-expect-error The independent Event query shares the current field name.
queriedEvent.time;
// @ts-expect-error Search uses the same Event story field.
searchEvent.time;
// @ts-expect-error Event prose is not the structured FactTime evidence object.
const invalidStory: Search["events"][number] = { ...searchEvent, event_time: factTime };
