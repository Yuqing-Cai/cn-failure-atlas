#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  evaluatePromotion,
  validateGateInputSchemas,
} from "../lib/evolution-gate.js";
import { validateMachineArtifacts } from "../lib/machine-artifact-validator.js";
import {
  parseJsonWithUniqueKeys,
  sha256Json,
} from "../lib/content-integrity.js";
import {
  assertJsonSourceSize,
  describeStructureFailure,
  inspectUntrustedStructure,
} from "../lib/untrusted-input.js";

const SCHEMA_FILES = [
  "common.schema.json",
  "diagnostic-trace.schema.json",
  "repair-attempt.schema.json",
  "verification-run.schema.json",
  "evolution-policy.schema.json",
  "promotion-trust-root.schema.json",
  "promotion-run-receipt.schema.json",
];

const EXIT_CODES = {
  adopted: 0,
  candidate: 2,
  rejected: 3,
  inconclusive: 4,
};

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  let policy;
  let verificationRun;
  let completeBundle = null;
  let trustRoot = null;
  let runReceipt = null;

  if (options.runReceipt && !options.trustRoot) {
    throw new CliError("--run-receipt requires --trust-root");
  }

  if (options.input) {
    const combined = await readJson(options.input);
    if (
      combined.trust_root ||
      combined.trustRoot ||
      combined.run_receipt ||
      combined.runReceipt
    ) {
      throw new CliError(
        "trust_root and run_receipt must not come from the candidate-writable --input bundle; pass them separately",
      );
    }
    policy = combined.policy;
    verificationRun =
      combined.verification_run ?? combined.verificationRun ?? combined.run;
    completeBundle = {
      diagnostic_trace:
        combined.diagnostic_trace ?? combined.diagnosticTrace ?? null,
      repair_attempt: combined.repair_attempt ?? combined.repairAttempt ?? null,
      taxonomy: combined.taxonomy ?? null,
    };
    if (!options.trustRoot) {
      throw new CliError("--trust-root is required with --input");
    }
    if (!options.runReceipt) {
      throw new CliError("--run-receipt is required with --input");
    }
    trustRoot = await readJson(options.trustRoot);
    assertPinnedTrustRoot(trustRoot);
    runReceipt = await readJson(options.runReceipt);
  } else {
    if (!options.policy) throw new CliError("an evolution policy is required");
    policy = await readJson(options.policy);
    if (!options.run) throw new CliError("a verification run is required");
    verificationRun = await readJson(options.run);
    const bundlePaths = [options.trace, options.repair, options.taxonomy];
    if (bundlePaths.some(Boolean)) {
      if (!bundlePaths.every(Boolean)) {
        throw new CliError(
          "--trace, --repair, and --taxonomy are all required for a full bundle",
        );
      }
      if (!options.trustRoot) {
        throw new CliError(
          "--trust-root is required for an adopting full-bundle evaluation",
        );
      }
      if (!options.runReceipt) {
        throw new CliError(
          "--run-receipt is required for an adopting full-bundle evaluation",
        );
      }
      completeBundle = {
        diagnostic_trace: await readJson(options.trace),
        repair_attempt: await readJson(options.repair),
        taxonomy: await readJson(options.taxonomy),
      };
      trustRoot = await readJson(options.trustRoot);
      assertPinnedTrustRoot(trustRoot);
      runReceipt = await readJson(options.runReceipt);
    } else if (options.trustRoot) {
      trustRoot = await readJson(options.trustRoot);
      assertPinnedTrustRoot(trustRoot);
      if (options.runReceipt) runReceipt = await readJson(options.runReceipt);
    }
  }

  if (!verificationRun) {
    throw new CliError("input does not contain verification_run");
  }
  if (!policy) throw new CliError("input does not contain policy");

  const schemaValidation = validateGateInputSchemas(policy, verificationRun);
  if (!schemaValidation.valid) {
    throw new CliError(formatSchemaValidation(schemaValidation));
  }

  if (completeBundle) {
    const missing = Object.entries(completeBundle)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new CliError(
        `full promotion bundle is missing: ${missing.join(", ")}`,
      );
    }
    const artifactValidation = await validateBundleArtifacts({
      policy,
      verificationRun,
      ...completeBundle,
      trust_root: trustRoot,
      run_receipt: runReceipt,
    });
    if (artifactValidation.errors.length > 0) {
      throw new CliError(
        `artifact bundle validation failed: ${artifactValidation.errors
          .map((error) => `[${error.rule}] ${error.message}`)
          .join("; ")}`,
      );
    }
  }

  const result = evaluatePromotion(
    policy,
    verificationRun,
    completeBundle
      ? {
          diagnostic_trace: completeBundle.diagnostic_trace,
          repair_attempt: completeBundle.repair_attempt,
          taxonomy: completeBundle.taxonomy,
        }
      : null,
    trustRoot,
    runReceipt,
  );
  process.stdout.write(
    `${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`,
  );
  process.exitCode = EXIT_CODES[result.status];
}

export function parseArguments(argv) {
  const result = {
    input: null,
    policy: null,
    trace: null,
    repair: null,
    run: null,
    taxonomy: null,
    trustRoot: null,
    runReceipt: null,
    pretty: false,
    help: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--pretty") result.pretty = true;
    else if ([
      "--input",
      "-i",
      "--policy",
      "-p",
      "--trace",
      "--repair",
      "--run",
      "-r",
      "--taxonomy",
      "--trust-root",
      "--run-receipt",
    ].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new CliError(`${argument} requires a file path`);
      }
      index += 1;
      if (argument === "--input" || argument === "-i") result.input = value;
      else if (argument === "--policy" || argument === "-p") result.policy = value;
      else if (argument === "--trace") result.trace = value;
      else if (argument === "--repair") result.repair = value;
      else if (argument === "--taxonomy") result.taxonomy = value;
      else if (argument === "--trust-root") result.trustRoot = value;
      else if (argument === "--run-receipt") result.runReceipt = value;
      else result.run = value;
    } else if (argument.startsWith("-")) {
      throw new CliError(`unknown option: ${argument}`);
    } else positional.push(argument);
  }

  if (
    result.input &&
    (result.policy ||
      result.trace ||
      result.repair ||
      result.run ||
      result.taxonomy ||
      positional.length > 0)
  ) {
    throw new CliError("--input cannot be combined with separate record files");
  }
  if (!result.input && positional.length > 0) {
    if (positional.length > 2) throw new CliError("too many positional files");
    if (positional.length === 2) {
      if (result.policy || result.run) {
        throw new CliError(
          "two positional files cannot be combined with --policy or --run",
        );
      }
      [result.policy, result.run] = positional;
    } else if (result.policy && !result.run) {
      result.run = positional[0];
    } else if (result.run && !result.policy) {
      result.policy = positional[0];
    } else if (!result.policy && !result.run) {
      result.run = positional[0];
    } else {
      throw new CliError("unexpected positional file");
    }
  }
  return result;
}

async function readJson(filePath) {
  let source;
  try {
    const metadata = await stat(filePath);
    assertJsonSourceSize(metadata.size, String(filePath));
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new CliError(`cannot read ${filePath}: ${error.message}`);
  }
  try {
    const parsed = parseJsonWithUniqueKeys(source);
    const structure = inspectUntrustedStructure(parsed);
    if (!structure.pass) {
      throw new Error(describeStructureFailure(structure, String(filePath)));
    }
    return parsed;
  } catch (error) {
    throw new CliError(`invalid JSON in ${filePath}: ${error.message}`);
  }
}

function assertPinnedTrustRoot(trustRoot) {
  const expected = process.env.CN_FAILURE_ATLAS_TRUST_ROOT_SHA256;
  const observed = sha256Json(trustRoot);
  if (!expected) {
    throw new CliError(
      "CN_FAILURE_ATLAS_TRUST_ROOT_SHA256 must be pinned by the deployment environment",
    );
  }
  if (expected !== observed) {
    throw new CliError(
      `trust root digest does not match deployment pin (observed ${observed})`,
    );
  }
}

async function validateBundleArtifacts({
  policy,
  verificationRun,
  diagnostic_trace: diagnosticTrace,
  repair_attempt: repairAttempt,
  taxonomy,
  trust_root: trustRoot,
  run_receipt: runReceipt,
}) {
  const schemas = await Promise.all(
    SCHEMA_FILES.map(async (filename) => ({
      filename,
      data: await readJson(
        new URL(`../schemas/${filename}`, import.meta.url),
      ),
    })),
  );
  const examples = [
    ["evolution-policy.bundle.json", policy],
    ["diagnostic-trace.bundle.json", diagnosticTrace],
    ["repair-attempt.bundle.json", repairAttempt],
    ["verification-run.bundle.json", verificationRun],
  ].map(([filename, data]) => ({ filename, data }));
  const result = validateMachineArtifacts({
    schemas,
    examples,
    taxonomyVersion: taxonomy.taxonomy_version,
    taxonomy,
    trustRoot,
    runReceipt,
  });
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const { data } of schemas) ajv.addSchema(data);
  const validateTrustRoot = ajv.getSchema(
    "https://yuqing-cai.github.io/cn-failure-atlas/schemas/promotion-trust-root.schema.json",
  );
  if (!validateTrustRoot?.(trustRoot)) {
    for (const error of validateTrustRoot?.errors ?? []) {
      result.errors.push({
        rule: "R8",
        message: `promotion-trust-root.bundle.json${error.instancePath || "/"} ${error.message}`,
      });
    }
  }
  const validateRunReceipt = ajv.getSchema(
    "https://yuqing-cai.github.io/cn-failure-atlas/schemas/promotion-run-receipt.schema.json",
  );
  if (!validateRunReceipt?.(runReceipt)) {
    for (const error of validateRunReceipt?.errors ?? []) {
      result.errors.push({
        rule: "R8",
        message: `promotion-run-receipt.bundle.json${error.instancePath || "/"} ${error.message}`,
      });
    }
  }
  return result;
}

function formatSchemaValidation(validation) {
  const groups = [
    ["policy", validation.policy],
    ["verification_run", validation.verification_run],
  ];
  const messages = [];
  for (const [name, result] of groups) {
    for (const error of result.errors) {
      messages.push(`${name}${error.instance_path}: ${error.message}`);
    }
  }
  return `schema validation failed: ${messages.join("; ")}`;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/evaluate-promotion.js --policy policy.json --trace diagnostic.json --repair repair.json --run verification.json --taxonomy taxonomy.json --trust-root trust-root.json --run-receipt receipt.json [--pretty]",
    "  node scripts/evaluate-promotion.js --input full-promotion-bundle.json --trust-root trust-root.json --run-receipt receipt.json [--pretty]",
    "  node scripts/evaluate-promotion.js --policy policy.json --run verification.json [--pretty]  # diagnostic-only",
    "  node scripts/evaluate-promotion.js policy.json verification-run.json [--pretty]",
    "",
    "Only a full bundle plus a deployment-pinned trust_root and completed five-stage run_receipt can authorize adopted. Two-file mode is diagnostic-only.",
    "",
    "Exit codes: 0 adopted, 2 candidate, 3 rejected, 4 inconclusive, 64 CLI/input error.",
  ].join("\n");
}

class CliError extends Error {}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 64;
  });
}
