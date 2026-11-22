import type { QueryResultRow } from "pg";
import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "../src/db";
import { createApp } from "../src/http";
import { createRuntime } from "../src/runtime";
import { writeUsageEvent } from "../src/usage";
import type { components } from "../../../sdks/typescript/src/generated/openapi";

type UsagePage = components["schemas"]["UsageEvents"];

const url = process.env.MEMOIA_TEST_DATABASE_URL;
test(
  "usage API paginates a UTC day and keeps user filtering inside the authenticated project",
  { skip: !url },
  async () => {
    const db = new Database(url!);
    const project = crypto.randomUUID();
    const otherProject = crypto.randomUUID();
    const secret = "localonly";
    const userId = crypto.randomUUID();
    const otherUser = crypto.randomUUID();
    const headers = { Authorization: `Bearer sk-${project}-${secret}` };
    const app = createApp((env, signal) => createRuntime(env, signal, db));
    const base = "/api/project/usage/events";
    let usageReads = 0;
    const statement = db.query.bind(db);
    db.query = async <T extends QueryResultRow>(
      sql: string,
      values?: unknown[],
    ) => {
      if (sql.includes("FROM memoia.usage_events")) usageReads++;
      return statement<T>(sql, values);
    };
    const use = {
      kind: "fact_extraction" as const,
      provider: "openai" as const,
      model: "model-for-test",
      service_tier: "default",
      input_tokens: 17,
      output_tokens: 3,
    };
    try {
      await db.query(
        "INSERT INTO memoia.projects (project_id, project_secret, status, id) VALUES ($1,$2,'active',gen_random_uuid()),($3,$4,'active',gen_random_uuid())",
        [
          project,
          `sk-${project}-${secret}`,
          otherProject,
          `sk-${otherProject}-${secret}`,
        ],
      );
      await db.query(
        "INSERT INTO memoia.users (project_id,id) VALUES ($1,$2),($1,$3),($4,$2)",
        [project, userId, otherUser, otherProject],
      );
      const occurredAt = new Date("2026-11-15T23:59:55.000Z");
      let loseReceipt = true;
      await writeUsageEvent(
        {
          async query<T extends QueryResultRow>(
            sql: string,
            values?: unknown[],
          ) {
            const result = await db.query<T>(sql, values);
            if (loseReceipt) {
              loseReceipt = false;
              throw Object.assign(new Error("lost commit"), {
                code: "ECONNRESET",
              });
            }
            return result;
          },
        },
        { projectId: project, userId },
        occurredAt,
        use,
      );
      await writeUsageEvent(
        db,
        { projectId: project, userId },
        occurredAt,
        use,
      );
      await writeUsageEvent(
        db,
        { projectId: project, userId: otherUser },
        occurredAt,
        use,
      );
      await writeUsageEvent(
        db,
        { projectId: otherProject, userId },
        occurredAt,
        use,
      );
      await db.query(
        "UPDATE memoia.usage_events SET recorded_at=$1 WHERE project_id IN ($2,$3)",
        ["2026-11-16T00:00:00.000Z", project, otherProject],
      );
      await db.query(
        "UPDATE memoia.usage_events SET recorded_at=$1 WHERE project_id=$2",
        ["2026-11-11T00:00:00.000Z", otherProject],
      );
      await db.query(
        `INSERT INTO memoia.usage_events (project_id,user_id,recorded_at,occurred_at,usage)
         VALUES ($1,$2,$3,$3,$4)`,
        [project, otherUser, "2026-11-14T00:00:00.000Z", JSON.stringify(use)],
      );
      assert.equal(
        (
          await app.request(
            `${base}?date=2026-11-16`,
            {},
            { OPENAI_API_KEY: "fixture" },
          )
        ).status,
        401,
      );
      const get = async (query: string) => {
        usageReads = 0;
        const response = await app.request(
          `${base}?${query}`,
          { headers },
          { OPENAI_API_KEY: "fixture" },
        );
        assert.equal(usageReads, response.ok ? 1 : 0);
        return response;
      };
      assert.equal((await get("date=2026-11-31")).status, 422);
      const page1 = await get(`date=2026-11-16&user_id=${userId}&limit=1`);
      assert.equal(page1.status, 200, await page1.clone().text());
      const first = (await page1.json()) as UsagePage;
      assert.equal(first.project_id, project);
      assert.equal(first.first_recorded_date, "2026-11-16");
      assert.equal(first.events.length, 1);
      assert.equal(first.events[0].user_id, userId);
      assert.equal(first.events[0].occurred_at, occurredAt.toISOString());
      assert.equal(first.events[0].input_tokens, 17);
      assert.ok(first.next_cursor);
      const page2 = await get(
        `date=2026-11-16&user_id=${userId}&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
      );
      const second = (await page2.json()) as UsagePage;
      assert.equal(second.events.length, 1);
      assert.notEqual(second.events[0].id, first.events[0].id);
      assert.equal(second.next_cursor, null);
      assert.equal(Object.hasOwn(second, "first_recorded_date"), false);
      const all = (await (await get("date=2026-11-16")).json()) as UsagePage;
      assert.equal(all.events.length, 3);
      assert.equal(all.first_recorded_date, "2026-11-14");
      const emptyDay = (await (
        await get(`date=2026-11-10&user_id=${userId}`)
      ).json()) as UsagePage;
      assert.deepEqual(emptyDay, {
        project_id: project,
        first_recorded_date: "2026-11-16",
        events: [],
        next_cursor: null,
      });
      const emptyUser = (await (
        await get(`date=2026-11-16&user_id=${crypto.randomUUID()}`)
      ).json()) as UsagePage;
      assert.equal(emptyUser.first_recorded_date, null);
      assert.deepEqual(emptyUser.events, []);
    } finally {
      await db.query(
        "DELETE FROM memoia.projects WHERE project_id IN ($1,$2)",
        [project, otherProject],
      );
      await db.close();
    }
  },
);
