import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const url = process.env.MEMOIA_TEST_DATABASE_URL;
test("Fact PostgreSQL integration", { skip: !url }, () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const output = fileURLToPath(
    new URL(`./.facts-${randomUUID()}.mjs`, import.meta.url),
  );
  try {
    execFileSync(
      fileURLToPath(new URL("../node_modules/.bin/esbuild", import.meta.url)),
      [
        "tests/facts-integration.fixture.ts",
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
      stdio: "inherit",
      env,
    });
  } finally {
    try {
      unlinkSync(output);
    } catch {}
  }
});
