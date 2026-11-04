import { fileURLToPath } from "node:url";
import { startMaintenanceWorker } from "./maintenance-worker.js";
import { createNodeDatabase, readNodeEnv } from "./node-env.js";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = readNodeEnv();
  const database = createNodeDatabase(env);
  const worker = startMaintenanceWorker(env, database);
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      if (stopping) return;
      stopping = true;
      void worker
        .stop()
        .then(async (ok) => {
          if (!ok) {
            process.stderr.write(
              "Maintenance shutdown timed out; original tasks remain recoverable\n",
            );
            process.exit(1);
          }
          await database.close();
        })
        .catch(() => {
          process.stderr.write("Maintenance shutdown failed\n");
          process.exit(1);
        });
    });
}
