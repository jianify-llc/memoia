import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";

// Packaging never obtains credentials from dotenv or invokes a deployment.
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!["--env", "--outdir"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error("Build accepts only --env and --outdir");
}
const directory = await mkdtemp(join(tmpdir(), "memoia-build-"));
const envFile = join(directory, "empty.env");
await writeFile(envFile, "", { mode: 0o600 });
// CLI subprocesses intentionally omit the Worker credentials declared in generated bindings.
const env = { CI: "true", WRANGLER_SEND_METRICS: "false" } as unknown as NodeJS.ProcessEnv;
for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot"])
  if (process.env[key]) env[key] = process.env[key];
try {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(resolve("node_modules/.bin/wrangler"), ["deploy", "--dry-run", ...(!args.includes("--outdir") ? ["--outdir", "dist"] : []), "--env-file", envFile, ...args], {
      env, stdio: "inherit", detached: process.platform !== "win32",
    });
    const stop = () => { if (child.pid) { try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch {} } };
    const timer = setTimeout(stop, 120_000);
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop);
      code === 0 ? resolvePromise() : reject(new Error(`Worker packaging failed (${code})`));
    });
  });
} finally { await rm(directory, { recursive: true, force: true }); }
