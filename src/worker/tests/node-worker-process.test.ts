import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

test(
  "Node worker process recovery PostgreSQL integration",
  { skip: !process.env.MEMOIA_TEST_DATABASE_URL },
  () => {
    const suffix = crypto.randomUUID();
    const dir = fileURLToPath(new URL("..", import.meta.url));
    const fixture = fileURLToPath(
      new URL(`./.node-process-fixture-${suffix}.mjs`, import.meta.url),
    );
    const cli = fileURLToPath(
      new URL(`./.node-process-cli-${suffix}.mjs`, import.meta.url),
    );
    try {
      const esbuild = fileURLToPath(
        new URL("../node_modules/.bin/esbuild", import.meta.url),
      );
      for (const [entry, output] of [
        ["tests/node-worker-process.fixture.ts", fixture],
        ["src/node-worker.ts", cli],
      ]) {
        execFileSync(
          esbuild,
          [
            entry,
            "--bundle",
            "--platform=node",
            "--format=esm",
            "--packages=external",
            "--loader:.md=text",
            `--outfile=${output}`,
          ],
          { cwd: dir, stdio: "pipe" },
        );
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MEMOIA_TEST_WORKER_CLI: cli,
      };
      delete env.NODE_TEST_CONTEXT;
      execFileSync(process.execPath, ["--test", fixture], {
        env,
        stdio: "inherit",
      });
    } finally {
      for (const path of [fixture, cli])
        try {
          unlinkSync(path);
        } catch {}
    }
  },
);
