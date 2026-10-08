#!/usr/bin/env node
// Real, bounded SDK acceptance. Only this invocation's random user may be deleted.
import { randomUUID } from "node:crypto";
import { fstatSync, fsyncSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const names = ["input", "sdk_version", "authentication", "user_absent", "first_import",
  "operation_replay", "source_evidence", "fact_search", "profiles", "embedding_search", "history",
  "flush", "partial_maintenance", "delete_maintenance",
  "partial_retract", "retract", "profile_history", "forget_user", "forget_repeat", "late_import_rejected", "cleanup"];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const requireTrue = (condition) => { if (!condition) throw new Error("Probe check failed"); };
const terminal = (operation) => operation.status === "completed" || operation.status === "failed";
const historyProfiles = (history) => history.entries.flatMap((entry) => [...entry.profiles, ...entry.added, ...entry.removed]);
const ids = (rows, field = "id") => rows.map((row) => row[field]).sort();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const profileState = (rows) => rows.map((profile) => [profile.id, profile.content, profile.topic,
  profile.sub_topic, [...profile.source_ids].sort()]).sort(([left], [right]) => left.localeCompare(right));

export async function runProbe(input, sdkEntry, { transport = fetch, pollIntervalMs = 1000, checkpoint = async () => {} } = {}) {
  const evidence = { success: false, outcome_unknown: false,
    checks: Object.fromEntries(names.map((name) => [name, false])), ids: {}, counts: {}, maintenance: {} };
  let origin, token, deadline, client, MemoiaError;
  let ownedUser = false, mutationUnknown = false, forgetStarted = false, checkpointFailed = false;
  const remaining = () => Math.max(0, deadline - Date.now());
  const options = () => ({ deadline });
  const raw = (method, path, key = token, budget = remaining()) => {
    requireTrue(budget > 0);
    return transport(`${origin}${path}`, { method, redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, budget))),
      headers: { Accept: "application/json", ...(key === null ? {} : { Authorization: `Bearer ${key}` }) } });
  };
  const absent = async (response) => response.status === 404 ||
    false;
  const record = async (stage, unknown = mutationUnknown) => {
    requireTrue(!checkpointFailed);
    try {
      // 传递独立的脱敏快照；必须等待持久化，不能让后续写入越过失败的检查点。
      await checkpoint({ ...structuredClone(evidence), kind: "boundary", stage, outcome_unknown: unknown });
    } catch (error) { checkpointFailed = true; throw error; }
  };
  const remember = (operation) => {
    if (!operation) return;
    if (!evidence.ids.operation_ids.includes(operation.operation_id)) evidence.ids.operation_ids.push(operation.operation_id);
    if (operation.source_id) {
      evidence.ids.source_id ??= operation.source_id;
      if (!evidence.ids.source_ids.includes(operation.source_id)) evidence.ids.source_ids.push(operation.source_id);
    }
    for (const kind of ["event_ids", "profile_ids"]) {
      for (const id of operation.result?.[kind] ?? []) {
        if (!evidence.ids[kind].includes(id)) evidence.ids[kind].push(id);
      }
    }
  };
  const complete = async (stage, key, post) => {
    // Mark the boundary before the one POST. A lost acknowledgement is not a rejection.
    await record(`${stage}.before`, true);
    mutationUnknown = true;
    let operation;
    try { operation = await post(); } catch (error) {
      if (error.outcome !== "unknown") {
        mutationUnknown = false;
        await record(`${stage}.rejected`);
        throw error;
      }
      await record(`${stage}.unknown`);
    }
    remember(operation);
    if (operation) {
      mutationUnknown = operation.kind !== "flush" && !terminal(operation);
      await record(`${stage}.receipt`);
      if (operation.kind === "flush" && operation.status !== "failed") requireTrue(operation.error === null);
    }
    while (!operation || !terminal(operation)) {
      requireTrue(remaining() > 0);
      await delay(Math.min(pollIntervalMs, remaining()));
      try {
        operation = await client.getOperationByKey(evidence.ids.user_id, key, options());
        remember(operation);
        mutationUnknown = operation.kind !== "flush" && !terminal(operation);
        await record(`${stage}.receipt`);
        if (operation.kind === "flush" && operation.status !== "failed") requireTrue(operation.error === null);
      }
      catch (error) {
        // Receipt lookup is read-only; neither 404 nor a temporary error permits a POST replay.
        if (checkpointFailed) throw error;
        if (![null, 404, 429, 500, 502, 503, 504].includes(error.status)) throw error;
      }
    }
    mutationUnknown = false;
    if (operation.kind === "flush") {
      evidence.maintenance[stage.replace(/_flush$/, "")] = { operation_id: operation.operation_id,
        status: operation.flush.status, blob_ids: operation.flush.blob_ids,
        attempts: operation.flush.attempts, failed: operation.error !== null };
    }
    requireTrue(operation.status === "completed");
    return operation;
  };
  const maintain = async (operation, stage) => {
    const version = operation.result?.memory_version;
    requireTrue(Number.isSafeInteger(version) && version >= 0);
    evidence.counts[`${stage}_memory_version`] = version;
    const key = randomUUID();
    evidence.ids[`${stage}_flush_key`] = key;
    const sealed = await complete(`${stage}_flush`, key,
      () => client.flushUser(evidence.ids.user_id, { idempotency_key: key }, options()));
    requireTrue(sealed.kind === "flush" && sealed.source_id === null && sealed.blob_id === null &&
      sealed.result.blob_ids.includes(operation.blob_id));
    evidence.ids[`${stage}_flush_operation_id`] = sealed.operation_id;
    while (true) {
      requireTrue(remaining() > 0);
      let state;
      try { state = await client.getMaintenance(evidence.ids.user_id, options()); }
      catch (error) {
        // Read-only transient lookup failures never authorize replay or recovery.
        if (![null, 429, 500, 502, 503, 504].includes(error.status)) throw error;
        await delay(Math.min(pollIntervalMs, remaining()));
        continue;
      }
      const progress = state.flushes.find((item) => item.operation_id === sealed.operation_id);
      requireTrue(progress && progress.blob_ids.includes(operation.blob_id));
      evidence.maintenance[stage] = { operation_id: progress.operation_id, status: progress.status,
        blob_ids: progress.blob_ids, attempts: progress.attempts, failed: progress.error !== null };
      // Preserve the first model failure; do not wait through retries until it passes.
      requireTrue(progress.status === "completed" && progress.error === null);
      return sealed;
    }
  };
  try {
    const url = new URL(input.origin);
    requireTrue((url.protocol === "https:" || (url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === "/");
    requireTrue(typeof input.token === "string" && input.token.trim().length > 0);
    requireTrue(typeof checkpoint === "function");
    const budget = input.deadline_ms ?? 360_000;
    requireTrue(Number.isSafeInteger(budget) && budget >= 1000 && budget <= 900_000);
    origin = url.origin; token = input.token; deadline = Date.now() + budget;
    evidence.checks.input = true;
    const entry = resolve(sdkEntry);
    const manifest = JSON.parse(await readFile(resolve(dirname(entry), "../package.json"), "utf8"));
    requireTrue(manifest.name === "@jianify/memoia" && manifest.version === "0.9.0");
    const sdk = await import(pathToFileURL(entry).href);
    const { MemoiaClient } = sdk;
    MemoiaError = sdk.MemoiaError;
    requireTrue(typeof MemoiaError === "function");
    client = new MemoiaClient({ baseUrl: origin, apiKey: token, fetch: transport,
      maxAttempts: 1, readTimeoutMs: 15_000, writeTimeoutMs: 90_000 });
    evidence.checks.sdk_version = true;
    evidence.ids = { user_id: randomUUID(), input_source_id: randomUUID(), import_key: randomUUID(),
      partial_retract_key: randomUUID(), retract_key: randomUUID(), late_import_key: randomUUID(), late_input_source_id: randomUUID(),
      operation_ids: [], source_ids: [], event_ids: [], profile_ids: [] };
    const uid = evidence.ids.user_id;
    const profilePath = `/api/users/${uid}/profiles`;
    for (const credential of [null, `invalid-${randomUUID()}`]) {
      const response = await raw("GET", profilePath, credential);
      requireTrue([401, 403].includes(response.status));
    }
    const empty = await client.getProfiles(uid, options());
    requireTrue(empty.profiles.length === 0);
    evidence.checks.authentication = true;
    requireTrue(await absent(await raw("GET", `/api/users/${uid}`)));
    evidence.checks.user_absent = true;
    ownedUser = true;
    const occurredAt = new Date().toISOString();
    const body = { idempotency_key: evidence.ids.import_key, source_id: evidence.ids.input_source_id,
      metadata: { sdk_probe: true }, messages: [
        { message_id: "name", role: "user", content: "My real name is Renata Calder. Please remember my name.", occurred_at: occurredAt },
        { message_id: "food", role: "user", content: "My favourite food is lemon risotto, and it has been my favourite for years. On 12 April 2026 I cooked lemon risotto at home for my friend Lina, and she said she enjoyed it.", occurred_at: occurredAt },
      ] };
    const readSource = async () => {
      const source = await client.getSource(uid, body.source_id, options());
      requireTrue([source.next_message_offset, source.next_blob_offset, source.next_evidence_offset]
        .every((offset) => offset === null));
      return source;
    };
    const imported = await complete("first_import", body.idempotency_key, () => client.importBlob(uid, body, options()));
    evidence.ids.source_id = imported.source_id;
    evidence.ids.import_operation_id = imported.operation_id;
    evidence.checks.first_import = true;
    const queried = await client.getOperationByKey(uid, body.idempotency_key, options());
    const byId = await client.getOperation(uid, imported.operation_id, options());
    requireTrue(same(queried, imported) && same(byId, imported));
    const stored = await readSource();
    const storedBlob = await client.getBlob(uid, imported.blob_id, options());
    requireTrue(stored.source_id === body.source_id && stored.source_id === imported.source_id &&
      storedBlob.source_id === stored.source_id && storedBlob.status === "active" && stored.evidence.length > 0);
    requireTrue(["name", "food"].every((id) => stored.evidence.some((fact) =>
      fact.support_groups.some((group) => group.length === 1 && group[0] === id))));
    evidence.counts.evidence_before = stored.evidence.length;
    evidence.checks.source_evidence = true;
    const factSearch = await client.search(uid, "Renata Calder", 10, options());
    requireTrue(factSearch.facts.some((fact) => fact.source_id === imported.source_id));
    evidence.checks.fact_search = true;
    const importFlush = await maintain(imported, "import");
    evidence.checks.flush = true;
    const profiles = await client.getProfiles(uid, options());
    requireTrue(profiles.profiles.length > 0 && profiles.profiles.every((p) => p.source_ids.includes(imported.source_id)));
    evidence.counts.profiles_before = profiles.profiles.length;
    evidence.ids.profile_ids.push(...ids(profiles.profiles));
    evidence.checks.profiles = true;
    const search = await client.search(uid, "Renata Calder", 10, options());
    requireTrue(search.facts.length > 0 && search.facts.some((fact) => fact.source_id === imported.source_id));
    evidence.counts.facts_before = search.facts.length;
    evidence.checks.embedding_search = true;
    const history = await client.getHistory(uid, options());
    requireTrue(history.entries.some((r) => r.operation_id === importFlush.operation_id) && historyProfiles(history).length > 0);
    evidence.counts.history_before = history.entries.length;
    evidence.checks.history = true;
    const sourcesBefore = await client.listSources(uid, { ...options(), limit: 100 });
    const events = async () => (await client.getEvents(uid, { limit: 100 }, options())).events;
    const eventsBefore = await events();
    requireTrue(same(ids(sourcesBefore.sources, "source_id"), [imported.source_id]) && eventsBefore.length > 0);
    evidence.counts.sources_before_replay = sourcesBefore.sources.length;
    evidence.counts.events_before_replay = eventsBefore.length;
    evidence.ids.event_ids.push(...ids(eventsBefore));
    // Deliberate replay is allowed only after this exact import has confirmed completion.
    // Its own lost acknowledgement remains unknown: never send a third POST or clean it away.
    await record("operation_replay.before", true);
    mutationUnknown = true;
    let replayed;
    try { replayed = await client.importBlob(uid, body, options()); }
    catch (error) {
      if (error.outcome !== "unknown") mutationUnknown = false;
      await record(mutationUnknown ? "operation_replay.unknown" : "operation_replay.rejected");
      throw error;
    }
    remember(replayed);
    if (terminal(replayed)) mutationUnknown = false;
    await record("operation_replay.receipt");
    requireTrue(replayed.status === "completed" && same(replayed, imported));
    const sourcesAfter = await client.listSources(uid, { ...options(), limit: 100 });
    const profilesAfter = await client.getProfiles(uid, options());
    const eventsAfter = await events();
    evidence.counts.sources_after_replay = sourcesAfter.sources.length;
    evidence.counts.profiles_after_replay = profilesAfter.profiles.length;
    evidence.counts.events_after_replay = eventsAfter.length;
    requireTrue(same(ids(sourcesAfter.sources, "source_id"), ids(sourcesBefore.sources, "source_id")) &&
      same(profileState(profilesAfter.profiles), profileState(profiles.profiles)) && same(ids(eventsAfter), ids(eventsBefore)));
    const replaySource = await readSource();
    requireTrue(replaySource.source_id === body.source_id && replaySource.blobs.length === 1 &&
      replaySource.blobs[0].blob_id === imported.blob_id &&
      same(replaySource.message_ids, stored.message_ids) &&
      same(ids(replaySource.evidence, "fact_id"), ids(stored.evidence, "fact_id")));
    evidence.checks.operation_replay = true;
    const withdrawn = new Set(stored.evidence.filter((f) =>
      f.support_groups.every((group) => group.includes("name"))).map((f) => f.fact_id));
    const partial = await complete("partial_retract", evidence.ids.partial_retract_key, () => client.deleteMessages(uid, imported.source_id,
      { idempotency_key: evidence.ids.partial_retract_key, message_ids: ["name"] }, options()));
    evidence.ids.partial_operation_id = partial.operation_id;
    const remainingSource = await readSource();
    await maintain(partial, "partial");
    evidence.checks.partial_maintenance = true;
    const remainingProfiles = await client.getProfiles(uid, options());
    const remainingHistory = await client.getHistory(uid, options());
    requireTrue(remainingSource.deleted_message_ids.includes("name") && remainingSource.evidence.length > 0 &&
      remainingSource.evidence.every((f) => !withdrawn.has(f.fact_id) && f.support_groups.every((g) => !g.includes("name"))));
    requireTrue(remainingProfiles.profiles.length > 0 &&
      remainingProfiles.profiles.every((p) => !p.content.toLowerCase().includes("renata calder")));
    requireTrue(historyProfiles(remainingHistory).every((p) => p.fact_ids.every((id) => !withdrawn.has(id))));
    evidence.counts.profiles_after_partial = remainingProfiles.profiles.length;
    evidence.checks.partial_retract = true;
    const retracted = await complete("retract", evidence.ids.retract_key, () => client.deleteMessages(uid, imported.source_id,
      { idempotency_key: evidence.ids.retract_key, message_ids: ["food"] }, options()));
    evidence.ids.retract_operation_id = retracted.operation_id;
    const finalSource = await readSource();
    requireTrue(finalSource.blobs.every((b) => b.status === "retracted") && finalSource.evidence.length === 0 &&
      ["name", "food"].every((id) => finalSource.deleted_message_ids.includes(id)));
    evidence.checks.retract = true;
    await maintain(retracted, "delete");
    evidence.checks.delete_maintenance = true;
    const finalProfiles = await client.getProfiles(uid, options());
    const finalHistory = await client.getHistory(uid, options());
    const finalSearch = await client.search(uid, "Renata Calder", 10, options());
    requireTrue(finalProfiles.profiles.length === 0 && historyProfiles(finalHistory).length === 0 &&
      finalSearch.facts.length === 0 && finalSearch.events.length === 0 && finalSearch.profiles.length === 0);
    evidence.counts.profiles_after = finalProfiles.profiles.length;
    evidence.counts.history_profiles_after = historyProfiles(finalHistory).length;
    evidence.counts.events_after = finalSearch.events.length;
    evidence.checks.profile_history = true;
    const forget = async (check, receiptId) => {
      // 每次 DELETE 的边界先登记；未知回执不自动重发，也不退回普通删除掩盖失败。
      forgetStarted = true;
      await record(`${check}.before`, true);
      mutationUnknown = true;
      let receipt;
      try { receipt = await client.forgetUser(uid, options()); }
      catch (error) {
        if (error instanceof MemoiaError && error.outcome === "rejected") mutationUnknown = false;
        await record(mutationUnknown ? `${check}.unknown` : `${check}.rejected`);
        throw error;
      }
      requireTrue(receipt?.user_id === uid && receipt.forgotten === true && Object.keys(receipt).length === 2);
      evidence.ids[receiptId] = receipt.user_id;
      mutationUnknown = false;
      evidence.checks[check] = true;
      await record(`${check}.receipt`);
    };
    await forget("forget_user", "forget_user_id");
    // 仅首次严格提交回执确认后，明确重复同一 UUID 的遗忘，验证幂等契约。
    await forget("forget_repeat", "forget_repeat_user_id");
    await record("late_import.before", true);
    mutationUnknown = true;
    try {
      const late = await client.importBlob(uid, { idempotency_key: evidence.ids.late_import_key,
        source_id: evidence.ids.late_input_source_id, metadata: { sdk_probe: true }, messages: [
          { message_id: "late", role: "user", content: "This is a late write from the forgotten probe user.", occurred_at: occurredAt },
        ] }, options());
      // 意外接纳同样保留全部已知身份，不能清理后把迟到写入误报为已拒绝。
      remember(late);
      evidence.ids.late_operation_id = late.operation_id;
      if (late.source_id) evidence.ids.late_source_id = late.source_id;
      mutationUnknown = !terminal(late);
      await record("late_import.receipt");
      requireTrue(false);
    } catch (error) {
      if (!(error instanceof MemoiaError) || error.outcome !== "rejected") {
        if (mutationUnknown && !checkpointFailed) await record("late_import.unknown");
        throw error;
      }
      mutationUnknown = false;
      const forgotten = error.status === 410 && error.code === "user_forgotten" && error.retryable === false;
      evidence.checks.late_import_rejected = forgotten;
      await record("late_import.rejected");
      requireTrue(forgotten);
    }
  } catch {
    // No exception text: SDK/provider/validation failures may contain protected values.
  } finally {
    if (ownedUser && !mutationUnknown && !checkpointFailed) {
      const path = `/api/users/${evidence.ids.user_id}`;
      // Cleanup has its own small read-back budget, never another mutation replay.
      try {
        const current = await raw("GET", path, token, 15_000);
        if (await absent(current)) evidence.checks.cleanup = true;
        else if (!forgetStarted) {
          requireTrue(current.ok);
          await record("cleanup.before", true);
          mutationUnknown = true;
          const forgotten = await client.forgetUser(evidence.ids.user_id, { deadline: Date.now() + 15_000 });
          requireTrue(forgotten?.user_id === evidence.ids.user_id && forgotten.forgotten === true);
          evidence.checks.cleanup = await absent(await raw("GET", path, token, 15_000));
          if (evidence.checks.cleanup) mutationUnknown = false;
        }
        if (evidence.checks.cleanup) await record("cleanup.confirmed");
      } catch { /* Keep the owned UUID visible for explicit investigation. */ }
    }
    evidence.outcome_unknown = mutationUnknown;
  }
  evidence.success = Object.values(evidence.checks).every(Boolean) && !evidence.outcome_unknown && !checkpointFailed;
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let input = "";
  let result;
  const output = async (value) => {
    await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve()));
    // 普通文件使用 fsync 保证先留证据后发请求；管道只能证明本进程写入完成。
    if (fstatSync(1).isFile()) fsyncSync(1);
  };
  process.stdout.on("error", () => { process.exitCode = 1; });
  try {
    for await (const chunk of process.stdin) { input += chunk; requireTrue(input.length <= 16_384); }
    requireTrue(process.argv.length === 3);
    result = await runProbe(JSON.parse(input), process.argv[2], { checkpoint: output });
  } catch {
    result = { success: false, outcome_unknown: false, checks: { input: false }, ids: {}, counts: {} };
  }
  process.exitCode = result.success ? 0 : 1;
  try { await output({ ...result, kind: "result" }); }
  catch { process.exitCode = 1; }
}
