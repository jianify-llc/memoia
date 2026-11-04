import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, unlink } from "node:fs/promises";
import pg from "pg";

function option(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1] || process.argv[i + 1].startsWith("--"))
    throw new Error(`Missing --${name}`);
  return process.argv[i + 1];
}
async function run(program: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic += chunk.toString().slice(0, 4096);
    });
    child.on("error", () =>
      reject(new Error(`${program} could not be started`)),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${program} failed (exit ${code}); verify the database and archive before retrying`,
            ),
          ),
    );
  });
}
async function main() {
  const action = process.argv[2];
  const file = option("file");
  if (action === "export") {
    const source = option("source");
    // Exclusive creation prevents accidentally overwriting the only recovery copy.
    const handle = await open(file, "wx", 0o600);
    await handle.close();
    try {
      await run("pg_dump", [
        "--format=custom",
        "--schema=memoia",
        "--no-owner",
        "--no-privileges",
        "--file",
        file,
        "--dbname",
        source,
      ]);
    } catch (error) {
      await unlink(file).catch(() => {});
      throw error;
    }
  } else if (action === "restore") {
    const target = option("target");
    let list: string;
    try {
      ({ stdout: list } = await promisify(execFile)(
        "pg_restore",
        ["--list", file],
        { maxBuffer: 10 * 1024 * 1024 },
      ));
    } catch {
      throw new Error("Cannot inspect snapshot archive");
    }
    const entry =
      /^\d+; \d+ \d+ (?:COMMENT|CONSTRAINT|DEFAULT|FK CONSTRAINT|FUNCTION|INDEX|SEQUENCE|SEQUENCE OWNED BY|SEQUENCE SET|TABLE|TABLE DATA|TRIGGER) memoia /;
    const schema = /^\d+; \d+ \d+ SCHEMA - memoia /;
    let hasSchema = false;
    for (const line of list.split("\n")) {
      if (!line || line.startsWith(";")) continue;
      if (schema.test(line)) hasSchema = true;
      if (!entry.test(line) && !schema.test(line))
        throw new Error(
          "Snapshot contains an unsupported or non-memoia archive entry",
        );
    }
    if (!hasSchema) throw new Error("Snapshot is missing the memoia schema");
    const client = new pg.Client({
      connectionString: target,
      connectionTimeoutMillis: 5_000,
    });
    await client.connect();
    try {
      const objects =
        await client.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname = 'memoia'
        AND c.relkind IN ('r','p','v','m','S','f')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
        UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='memoia'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') LIMIT 1`);
      if (objects.rowCount)
        throw new Error("Restore target memoia schema must be empty");
      await client.query("CREATE SCHEMA IF NOT EXISTS memoia");
    } finally {
      await client.end();
    }
    await run("pg_restore", [
      "--exit-on-error",
      "--schema=memoia",
      "--single-transaction",
      "--no-owner",
      "--no-privileges",
      "--dbname",
      target,
      file,
    ]);
  } else
    throw new Error(
      "Usage: snapshot.ts export --source URL --file PATH | restore --target URL --file PATH",
    );
}
main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Snapshot failed"}\n`,
  );
  process.exitCode = 1;
});
