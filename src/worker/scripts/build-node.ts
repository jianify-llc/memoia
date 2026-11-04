import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";

const outdir = process.argv[2] ?? "dist-node";
if (outdir === "dist-node") await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: {
    "node-api": "src/node-api.ts",
    "node-worker": "src/node-worker.ts",
    "scripts/migrate": "scripts/migrate.ts",
  },
  outdir,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  loader: { ".md": "text" },
});
await cp("migrations", `${outdir}/migrations`, { recursive: true });
