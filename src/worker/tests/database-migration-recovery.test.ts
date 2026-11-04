import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

test(
  "migration recovery PostgreSQL integration",
  { skip: !process.env.MEMOIA_TEST_ADMIN_DATABASE_URL },
  () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const output = fileURLToPath(
      new URL(
        `./.migration-recovery-${crypto.randomUUID()}.mjs`,
        import.meta.url,
      ),
    );
    try {
      execFileSync(
        fileURLToPath(new URL("../node_modules/.bin/esbuild", import.meta.url)),
        [
          "tests/database-migration-recovery.fixture.ts",
          "--bundle",
          "--platform=node",
          "--format=esm",
          "--packages=external",
          "--loader:.md=text",
          `--outfile=${output}`,
        ],
        { cwd: root, stdio: "pipe" },
      );
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      execFileSync(process.execPath, ["--test", output], {
        cwd: root,
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
