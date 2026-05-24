#!/usr/bin/env node

import { chmod } from "node:fs/promises";
import { build } from "esbuild";

const outputFile = "dist/cli.js";

await build({
  bundle: true,
  entryPoints: ["src/cli/index.js"],
  external: [
    "acpx",
    "acpx/runtime",
    "better-sqlite3",
    "commander",
    "ink",
    "js-yaml",
    "react",
    "zod",
  ],
  format: "esm",
  outfile: outputFile,
  platform: "node",
  target: "node20",
});

await chmod(outputFile, 0o755);
