import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
test(
  "maintenance PostgreSQL integration",
  { skip: !process.env.MEMOIA_TEST_DATABASE_URL },
  () => {
    const output = fileURLToPath(
      new URL(`./.maintenance-pg-${crypto.randomUUID()}.mjs`, import.meta.url),
    );
    try {
      execFileSync(
        fileURLToPath(new URL("../node_modules/.bin/esbuild", import.meta.url)),
        [
          "tests/maintenance-integration.fixture.ts",
          "--bundle",
          "--platform=node",
          "--format=esm",
          "--packages=external",
          "--loader:.md=text",
          `--outfile=${output}`,
        ],
        { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" },
      );
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      execFileSync(process.execPath, ["--test", output], {
        env,
        stdio: "inherit",
      });
    } finally {
      try {
        unlinkSync(output);
      } catch {}
    }
  },
);
