import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp } from "../src/http";
import { createRuntime } from "../src/runtime";
// @ts-ignore SDK standalone validators have no declaration file
import * as generated from "../../../sdks/typescript/src/generated/validators.js";
const validators = generated as Record<string, (value: unknown) => boolean>;
const connection = process.env.MEMOIA_HTTP_TEST_DB;

test(
  "HTTP project isolation and retrieval against isolated PostgreSQL",
  { skip: !connection },
  async () => {
    const env = {
      DATABASE_URL: connection!,
      OPENAI_API_KEY: "unused",
      ACCESS_TOKEN: "local-root",
      MEMOIA_CONFIG: '{"enable_event_embedding":false}',
    };
    const app = createApp(createRuntime);
    const db = new pg.Client({ connectionString: connection });
    await db.connect();
    await db.query("SET search_path TO memoia,public");
    const api = async (
      method: string,
      path: string,
      token = "local-root",
      payload?: unknown,
    ) => {
      const response = await app.request(
        path,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(payload === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        },
        env,
      );
      const content = await response.text();
      return {
        status: response.status,
        data: content ? JSON.parse(content) : null,
      };
    };
    const project = `p${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const other = `p${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    try {
      assert.equal(
        (
          await api("POST", "/api/projects", "local-root", {
            project_id: project,
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await api("POST", "/api/projects", "local-root", {
            project_id: other,
          })
        ).status,
        201,
      );
      const key = await api(
        "POST",
        `/api/projects/${project}/keys`,
        "local-root",
        { name: "admin", scopes: ["admin"] },
      );
      assert.equal(key.status, 201);
      assert.ok(validators.validateIssuedKey(key.data));
      const admin = key.data.token as string;
      const read = await api("POST", `/api/projects/${project}/keys`, admin, {
        name: "read",
        scopes: ["read"],
      });
      assert.equal(read.status, 201);
      assert.ok(validators.validateIssuedKey(read.data));
      const reader = read.data.token as string;
      assert.equal(
        (await api("GET", `/api/projects/${other}/keys`, admin)).status,
        403,
      );
      assert.equal((await api("POST", "/api/users", reader, {})).status, 403);
      const user = crypto.randomUUID(),
        foreign = crypto.randomUUID();
      assert.equal(
        (
          await api("POST", "/api/users", admin, {
            id: user,
            data: { kind: "sample" },
          })
        ).status,
        201,
      );
      assert.equal(
        (await api("POST", "/api/users", admin, { id: foreign })).status,
        201,
      );
      const profile = await api("POST", `/api/users/${user}/profiles`, admin, {
        content: "manual",
        topic: "habits",
        sub_topic: "work",
      });
      assert.equal(profile.status, 201);
      assert.ok(validators.validateProfileId(profile.data));
      assert.equal(
        (
          await api(
            "PATCH",
            `/api/users/${user}/profiles/${profile.data.id}`,
            admin,
            { content: "updated", topic: "habits", sub_topic: "work" },
          )
        ).status,
        204,
      );
      assert.equal(
        (await db.query("SELECT version FROM memoia.user_profiles WHERE id=$1", [profile.data.id])).rows[0].version,
        "2",
      );
      const blob = crypto.randomUUID(),
        fact = crypto.randomUUID(),
        event = crypto.randomUUID();
      await db.query(
        `INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES($1,$2,'source')`,
        [user, project],
      );
      await db.query(
        `INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at) VALUES($1,$2,'source','m1','hash','user',now())`,
        [user, project],
      );
      await db.query(
        `INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,status,message_ids) VALUES($1,$2,$3,'source','active','["m1"]')`,
        [blob, user, project],
      );
      await db.query(
        `INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at,certainty,subject,reporter) VALUES($1,$2,$3,$4,'enjoys coffee','[["m1"]]',now(),'asserted','user','user')`,
        [fact, user, project, blob],
      );
      await db.query(
        `INSERT INTO memoia.user_events(id,user_id,project_id,event_data) VALUES($1,$2,$3,$4::jsonb)`,
        [
          event,
          user,
          project,
          JSON.stringify({
            title: "Coffee",
            content: "enjoys coffee",
            memoia_v2: true,
          }),
        ],
      );
      await db.query(
        `INSERT INTO memoia.memory_event_facts(user_id,project_id,event_id,fact_id) VALUES($1,$2,$3,$4)`,
        [user, project, event, fact],
      );
      await db.query(
        `UPDATE memoia.user_profiles SET attributes=attributes||$3::jsonb WHERE id=$1 AND project_id=$2`,
        [
          profile.data.id,
          project,
          JSON.stringify({ fact_ids: [fact], memoia_v2: true }),
        ],
      );
      const queried = await api(
        "POST",
        `/api/users/${user}/facts/query`,
        reader,
        {},
      );
      assert.equal(queried.status, 200);
      assert.ok(validators.validateQueriedFacts(queried.data));
      assert.equal(queried.data.facts[0].id, fact);
      assert.equal(
        queried.data.facts[0].evidence.source_messages[0].message_id,
        "m1",
      );
      const isolated = await api(
        "POST",
        `/api/users/${foreign}/facts/query`,
        reader,
        {},
      );
      assert.equal(isolated.status, 200);
      assert.deepEqual(isolated.data.facts, []);
      const found = await api("POST", `/api/users/${user}/search`, reader, {
        query: "coffee",
        include_events: false,
      });
      assert.equal(found.status, 200);
      assert.ok(validators.validateSearch(found.data));
      assert.equal(found.data.facts[0].id, fact);
      assert.deepEqual(found.data.events, []);
      const eventQuery = await api(
        "POST",
        `/api/users/${user}/events/query`,
        reader,
        { fact_ids: [fact] },
      );
      assert.equal(eventQuery.status, 200);
      assert.ok(validators.validateQueriedEvents(eventQuery.data));
      assert.equal(eventQuery.data.events[0].event_data.fact_ids[0], fact);
      const all = await api("POST", `/api/users/${user}/search`, reader, {
        query: "coffee",
      });
      assert.equal(all.status, 200);
      assert.ok(validators.validateSearch(all.data));
      assert.equal(all.data.events[0].id, event);
      assert.equal(all.data.profiles[0].id, profile.data.id);
      const navigation = await api(
        "POST",
        `/api/users/${user}/search`,
        reader,
        { query: "coffee", exclude_fact_ids: [fact] },
      );
      assert.equal(navigation.status, 200);
      assert.deepEqual(navigation.data.facts, []);
      assert.equal(navigation.data.events[0].id, event);
      assert.equal(navigation.data.profiles[0].id, profile.data.id);
      const blockedEvent = await api(
        "POST",
        `/api/users/${user}/search`,
        reader,
        {
          query: "coffee",
          exclude_event_ids: [event],
          exclude_profile_ids: [profile.data.id],
        },
      );
      assert.equal(blockedEvent.status, 200);
      assert.deepEqual(blockedEvent.data.events, []);
      assert.deepEqual(blockedEvent.data.profiles, []);
      const tiny = await api("POST", `/api/users/${user}/facts/query`, reader, {
        max_token_size: 1,
      });
      assert.equal(tiny.status, 422);
      const oversized = crypto.randomUUID();
      await db.query(
        `INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at,certainty) VALUES($1,$2,$3,$4,$5,'[["m1"]]',now()+interval '1 second','asserted')`,
        [oversized, user, project, blob, "oversized ".repeat(2000)],
      );
      const budgeted = await api(
        "POST",
        `/api/users/${user}/facts/query`,
        reader,
        { limit: 2, max_token_size: 500 },
      );
      assert.equal(budgeted.status, 200);
      assert.deepEqual(
        budgeted.data.facts.map((item: any) => item.id),
        [fact],
      );
      await db.query("DELETE FROM memoia.memory_facts WHERE id=$1", [
        oversized,
      ]);
      const vector = [1, ...Array(1535).fill(0)];
      await db.query(
        `UPDATE memoia.memory_facts SET embedding=$2 WHERE id=$1`,
        [fact, `[${vector.join(",")}]`],
      );
      await db.query(
        `UPDATE memoia.user_events SET embedding=$2 WHERE id=$1`,
        [event, `[${vector.join(",")}]`],
      );
      let embeddingCalls = 0;
      let responseVector = vector;
      let duringEmbedding: (() => Promise<unknown>) | undefined;
      const server = createServer((req, res) => {
        embeddingCalls++;
        req.resume();
        req.on("end", async () => {
          try {
            await duringEmbedding?.();
          } catch {
            res.writeHead(500).end();
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              object: "list",
              data: [{ object: "embedding", index: 0, embedding: responseVector }],
              model: "test",
              usage: { prompt_tokens: 1, total_tokens: 1 },
            }),
          );
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const addr = server.address();
        assert.ok(addr && typeof addr !== "string");
        const semanticEnv = {
          ...env,
          OPENAI_BASE_URL: `http://127.0.0.1:${addr.port}/v1`,
          MEMOIA_CONFIG: "{}",
        };
        const response = await app.request(
          `/api/users/${user}/search`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${reader}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query: "nebula" }),
          },
          semanticEnv,
        );
        assert.equal(response.status, 200);
        const semantic: any = await response.json();
        assert.equal(semantic.facts[0].id, fact);
        assert.equal(embeddingCalls, 1);
        for (const kind of ["facts", "events"]) {
          const result = await app.request(
            `/api/users/${user}/${kind}/query`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${reader}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ query: "nebula" }),
            },
            semanticEnv,
          );
          assert.equal(result.status, 200);
          const data: any = await result.json();
          assert.equal(data[kind][0].id, kind === "facts" ? fact : event);
        }
        const result = await app.request(
          `/api/users/${user}/context`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${reader}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query: "nebula" }),
          },
          semanticEnv,
        );
        assert.equal(result.status, 200);
        const data: any = await result.json();
        assert.match(data.context, /enjoys coffee/);
        assert.equal(embeddingCalls, 4);
        const eventsPath = `/api/users/${user}/events`;
        const writeEvent = (method: string, path: string, body: unknown) =>
          app.request(path, {
            method,
            headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }, semanticEnv);
        const indexed = await writeEvent("POST", eventsPath, { content: "Walked in the park." });
        assert.equal(indexed.status, 201);
        const { id: indexedId } = await indexed.json() as { id: string };
        assert.equal(embeddingCalls, 5);
        const indexedPath = `${eventsPath}/${indexedId}`;
        assert.equal((await writeEvent("PATCH", indexedPath, {
          interpretation: "Enjoyed the calm.",
        })).status, 204);
        assert.equal(embeddingCalls, 5);
        responseVector = [0, 1, ...Array(1534).fill(0)];
        assert.equal((await writeEvent("PATCH", indexedPath, {
          content: "Walked by the river.",
        })).status, 204);
        assert.equal(embeddingCalls, 6);
        const { rows: [persisted] } = await db.query(
          "SELECT embedding::text AS embedding FROM memoia.user_events WHERE id=$1",
          [indexedId],
        );
        assert.deepEqual(JSON.parse(persisted.embedding), responseVector);
        duringEmbedding = () => db.query(
          `UPDATE memoia.user_events SET event_data=event_data || '{"summary":"Concurrent maintenance"}',version=version+1 WHERE id=$1`,
          [indexedId],
        );
        const conflicted = await writeEvent("PATCH", indexedPath, { content: "Changed during indexing." });
        assert.equal(conflicted.status, 409);
        assert.equal((await conflicted.json() as { detail: { code: string } }).detail.code, "write_conflict");
        const latestIndexed = await api("GET", indexedPath, reader);
        assert.equal(latestIndexed.data.event_data.content, "Walked by the river.");
        assert.equal(latestIndexed.data.event_data.summary, "Concurrent maintenance");
        assert.equal((await api("DELETE", indexedPath, admin)).status, 204);
      } finally {
        server.close();
        await once(server, "close");
      }
      const context = await api("POST", `/api/users/${user}/context`, reader, {
        query: "coffee",
      });
      assert.equal(context.status, 200);
      assert.ok(validators.validateContext(context.data));
      assert.match(context.data.context, /enjoys coffee/);
      assert.match(context.data.context, /source_messages/);
      const excluded = await api(
        "POST",
        `/api/users/${user}/facts/query`,
        reader,
        { exclude_ids: [fact] },
      );
      assert.equal(excluded.status, 200);
      assert.deepEqual(excluded.data.facts, []);
      const usage = await api("GET", "/api/project/usage", reader);
      assert.equal(usage.status, 200);
      assert.ok(validators.validateUsage(usage.data));
      assert.equal(usage.data.usages.length, 7);
      const extendedUsage = await api(
        "GET",
        "/api/project/usage?last_days=365",
        reader,
      );
      assert.equal(extendedUsage.status, 200);
      assert.equal(extendedUsage.data.usages.length, 30);
      assert.equal(
        (
          await api("PATCH", "/api/project/config", reader, {
            profile_config: "language: en",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await api("PATCH", "/api/project/config", admin, {
            profile_config: "language: en",
          })
        ).status,
        204,
      );
      assert.equal(
        (await api("GET", "/api/project/config", reader)).data.profile_config,
        "language: en",
      );
      const eventPath = `/api/users/${user}/events`;
      const directProfile = await api("GET", `/api/users/${user}/profiles/${profile.data.id}`, reader);
      assert.equal(directProfile.status, 200);
      assert.ok(validators.validateProfile(directProfile.data));
      assert.equal((await api("GET", `/api/users/${foreign}/profiles/${profile.data.id}`, reader)).status, 404);
      const edited = { content: "A confirmed coffee preference.", interpretation: "Likes the ritual." };
      assert.equal((await api("PATCH", `/api/users/${foreign}/events/${event}`, admin, edited)).status, 404);
      assert.equal((await api("PATCH", `${eventPath}/${event}`, reader, edited)).status, 403);
      const beforeEdit = await api("GET", `${eventPath}/${event}`, reader);
      assert.equal(beforeEdit.data.event_data.summary, null);
      await db.query(
        `UPDATE memoia.user_events SET event_data=event_data || '{"summary":"Updated by maintenance"}',version=version+1 WHERE id=$1`,
        [event],
      );
      assert.equal((await api("PATCH", `${eventPath}/${event}`, admin, edited)).status, 204);
      const editedEvent = await api("POST", `${eventPath}/query`, reader, { ids: [event] });
      assert.equal(editedEvent.status, 200);
      assert.equal(editedEvent.data.events[0].event_data.content, edited.content);
      assert.equal(editedEvent.data.events[0].event_data.title, "Coffee");
      assert.equal(editedEvent.data.events[0].event_data.summary, "Updated by maintenance");
      assert.deepEqual(editedEvent.data.events[0].event_data.fact_ids, [fact]);
      const { rows: [eventVersion] } = await db.query("SELECT version FROM memoia.user_events WHERE id=$1", [event]);
      assert.equal(eventVersion.version, "3");
      assert.equal((await api("PATCH", `${eventPath}/${event}`, admin, { title: null })).status, 204);
      const cleared = await api("GET", `${eventPath}/${event}`, reader);
      assert.equal(cleared.data.event_data.title, null);
      assert.equal(cleared.data.event_data.summary, "Updated by maintenance");
      await db.query(
        `UPDATE memoia.memory_blobs SET fact_completed_at=now(),fact_changes=$2::jsonb WHERE id=$1`,
        [blob, JSON.stringify([{ kind: "updated", fact_id: fact }])],
      );
      const pending = await api(
        "POST",
        `/api/users/${user}/profiles/query`,
        reader,
        {},
      );
      assert.equal(pending.status, 200);
      assert.ok(validators.validateQueriedProfiles(pending.data));
      assert.deepEqual(pending.data.profiles[0].fact_ids, []);
      const pendingEvent = await api(
        "POST",
        `/api/users/${user}/events/query`,
        reader,
        { fact_ids: [fact] },
      );
      assert.equal(pendingEvent.status, 200);
      assert.deepEqual(pendingEvent.data.events, []);
      const directPending = await api("GET", `${eventPath}/${event}`, reader);
      assert.equal(directPending.status, 200);
      assert.deepEqual(directPending.data.event_data.evidence, []);
      assert.equal((await api("GET", `/api/users/${foreign}/events/${event}`, reader)).status, 404);
      const eventBody = { title: "Manual observation", content: "用户周末骑自行车去公园，回家后记录了路线和天气。".repeat(260) };
      assert.equal((await api("POST", eventPath, reader, eventBody)).status, 403);
      assert.equal((await api("POST", eventPath, admin, { ...eventBody, fact_ids: [fact] })).status, 422);
      const manualEvent = await api("POST", eventPath, admin, eventBody);
      assert.equal(manualEvent.status, 201);
      assert.equal((await api("PATCH", `${eventPath}/${manualEvent.data.id}`, admin, eventBody)).status, 204);
      const manual = await api("POST", `${eventPath}/query`, reader, {
        ids: [manualEvent.data.id],
        max_token_size: 10000,
      });
      assert.equal(manual.status, 200);
      assert.equal(manual.data.events[0].event_data.content, eventBody.content);
      assert.deepEqual(manual.data.events[0].event_data.fact_ids, []);
      assert.deepEqual(manual.data.events[0].event_data.evidence, []);
      const budgetLimited = await api("POST", `${eventPath}/query`, reader, {
        ids: [manualEvent.data.id], max_token_size: 100,
      });
      assert.deepEqual(budgetLimited.data.events, []);
      const directManual = await api("GET", `${eventPath}/${manualEvent.data.id}`, reader);
      assert.ok(validators.validateEvent(directManual.data));
      assert.equal(directManual.data.event_data.content, eventBody.content);
      assert.equal((await api("DELETE", `${eventPath}/${manualEvent.data.id}`, admin)).status, 204);
      const deleted = await api("POST", `${eventPath}/query`, reader, { ids: [manualEvent.data.id] });
      assert.deepEqual(deleted.data.events, []);
      const revoke = await api(
        "DELETE",
        `/api/projects/${project}/keys/${read.data.key_id}`,
        admin,
      );
      assert.equal(revoke.status, 204);
      assert.equal(
        (await api("GET", "/api/project/identity", reader)).status,
        401,
      );
    } finally {
      try {
        await db.query("DELETE FROM memoia.projects WHERE project_id=ANY($1::text[])", [[project, other]]);
      } finally {
        await db.end();
      }
    }
  },
);

test(
  "healthcheck reports real role connection exhaustion and traces the recovered backend",
  { skip: !connection },
  async () => {
    const admin = new pg.Client({ connectionString: connection });
    const role = "probe_" + crypto.randomUUID().replaceAll("-", "");
    const password = crypto.randomUUID().replaceAll("-", "");
    const url = new URL(connection!);
    url.username = role;
    url.password = password;
    const holder = new pg.Client({ connectionString: url.href });
    const attributes: Record<string, unknown> = {};
    const tracing = {
      enterSpan(_name: string, callback: (span: unknown) => unknown) {
        return callback({
          setAttributes() {},
          setStatus() {},
          setAttribute(key: string, value: unknown) {
            attributes[key] = value;
          },
        });
      },
      getActiveSpan() {
        return {
          setAttributes(values: object) {
            Object.assign(attributes, values);
          },
        };
      },
    } as unknown as Tracing;
    const env = {
      DATABASE_URL: url.href,
      OPENAI_API_KEY: "unused",
      MEMOIA_HEALTHCHECK_DB_TRACE: "true",
      tracing,
    };
    const app = createApp(createRuntime);
    let created = false;
    let occupied = false;
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${role} LOGIN CONNECTION LIMIT 1 PASSWORD '${password}'`,
      );
      created = true;
      await holder.connect();
      occupied = true;
      const rejected = await app.request("/api/healthcheck", {}, env);
      assert.equal(rejected.status, 503);
      assert.deepEqual(await rejected.json(), {
        detail: {
          code: "database_unavailable",
          message: "Database temporarily unavailable",
          retryable: true,
        },
      });
      assert.equal(attributes["db.response.status_code"], "53300");

      await holder.end();
      occupied = false;
      const healthy = await app.request("/api/healthcheck", {}, env);
      assert.equal(healthy.status, 200);
      assert.deepEqual(await healthy.json(), { status: "ok" });
      assert.ok(Number.isSafeInteger(attributes["memoia.db.backend_pid"]));
      assert.ok(
        Number.isSafeInteger(attributes["memoia.db.backend_started_at_ms"]),
      );
    } finally {
      if (occupied) await holder.end();
      try {
        if (created) await admin.query(`DROP ROLE ${role}`);
      } finally {
        await admin.end();
      }
    }
  },
);
