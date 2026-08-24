#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  evaluatePromotion,
  validateGateInputSchemas,
} from "../lib/evolution-gate.js";

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

  if (options.input) {
    const combined = await readJson(options.input);
    policy = combined.policy;
    verificationRun =
      combined.verification_run ?? combined.verificationRun ?? combined.run;
  } else {
    if (!options.policy) throw new CliError("an evolution policy is required");
    policy = await readJson(options.policy);
    if (!options.run) throw new CliError("a verification run is required");
    verificationRun = await readJson(options.run);
  }

  if (!verificationRun) {
    throw new CliError("input does not contain verification_run");
  }
  if (!policy) throw new CliError("input does not contain policy");

  const schemaValidation = validateGateInputSchemas(policy, verificationRun);
  if (!schemaValidation.valid) {
    throw new CliError(formatSchemaValidation(schemaValidation));
  }

  const result = evaluatePromotion(policy, verificationRun);
  process.stdout.write(
    `${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`,
  );
  process.exitCode = EXIT_CODES[result.status];
}

export function parseArguments(argv) {
  const result = { input: null, policy: null, run: null, pretty: false, help: false };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--pretty") result.pretty = true;
    else if (["--input", "-i", "--policy", "-p", "--run", "-r"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new CliError(`${argument} requires a file path`);
      }
      index += 1;
      if (argument === "--input" || argument === "-i") result.input = value;
      else if (argument === "--policy" || argument === "-p") result.policy = value;
      else result.run = value;
    } else if (argument.startsWith("-")) {
      throw new CliError(`unknown option: ${argument}`);
    } else positional.push(argument);
  }

  if (result.input && (result.policy || result.run || positional.length > 0)) {
    throw new CliError("--input cannot be combined with policy/run files");
  }
  if (!result.input && positional.length > 0) {
    if (positional.length > 2) throw new CliError("too many positional files");
    result.policy ??= positional.length === 2 ? positional[0] : null;
    result.run ??= positional.length === 2 ? positional[1] : positional[0];
  }
  return result;
}

async function readJson(filePath) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new CliError(`cannot read ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new CliError(`invalid JSON in ${filePath}: ${error.message}`);
  }
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
    "  node scripts/evaluate-promotion.js --policy policy.json --run verification-run.json [--pretty]",
    "  node scripts/evaluate-promotion.js --input combined.json [--pretty]",
    "  node scripts/evaluate-promotion.js policy.json verification-run.json [--pretty]",
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
