import { readFileSync } from "node:fs";

import {
  parseJsonWithUniqueKeys,
  sha256Json,
} from "../lib/content-integrity.js";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/print-trust-root-digest.js <trust-root.json>");
  process.exitCode = 64;
} else {
  const source = readFileSync(path, "utf8");
  console.log(sha256Json(parseJsonWithUniqueKeys(source)));
}
