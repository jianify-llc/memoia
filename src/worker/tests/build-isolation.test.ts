import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("the packaging entry ignores dotenv and emits only a local bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memoia-package-test-"));
  try {
    await symlink(resolve("node_modules"), join(directory, "node_modules"));
    await writeFile(join(directory, ".env"), "MEMOIA_DOTENV_SENTINEL=must-not-load\n");
    await writeFile(join(directory, "entry.js"), "export default {fetch(){return new Response('ok')}}");
    await writeFile(join(directory, "wrangler.json"), JSON.stringify({
      name: "isolated-package", main: "entry.js", compatibility_date: "2026-10-30",
      build: { command: 'node -e "if (process.env.MEMOIA_DOTENV_SENTINEL) process.exit(42)"' },
    }));
    await promisify(execFile)(resolve("node_modules/.bin/tsx"), [resolve("scripts/build.ts"), "--outdir", join(directory, "bundle")], {
      cwd: directory, timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } as unknown as NodeJS.ProcessEnv,
    });
    assert.ok((await stat(join(directory, "bundle/entry.js"))).size > 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
