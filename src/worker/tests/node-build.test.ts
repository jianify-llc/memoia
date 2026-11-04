import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
test("Node packaging contains both entrypoints and migration journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memoia-node-build-"));
  try {
    await run(process.execPath, [
      "--import",
      "tsx",
      "scripts/build-node.ts",
      directory,
    ]);
    for (const entry of [
      "node-api.js",
      "node-worker.js",
      "scripts/migrate.js",
    ]) {
      const source = await readFile(join(directory, entry), "utf8");
      assert.ok(source.length > 0);
      assert.doesNotMatch(source, /workerd/);
    }
    const journal = JSON.parse(
      await readFile(join(directory, "migrations/meta/_journal.json"), "utf8"),
    );
    for (const entry of journal.entries) {
      assert.ok(
        (await readFile(join(directory, `migrations/${entry.tag}.sql`), "utf8"))
          .length > 0,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
