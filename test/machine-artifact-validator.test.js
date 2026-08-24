import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateMachineArtifacts } from "../lib/machine-artifact-validator.js";
import { REPOSITORY_ROOT } from "../validate.js";

const taxonomy = readJson(join(REPOSITORY_ROOT, "taxonomy.json"));
const schemas = loadFiles(join(REPOSITORY_ROOT, "schemas"), ".schema.json");
const examples = loadFiles(join(REPOSITORY_ROOT, "examples", "machine-only"), ".json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadFiles(directory, suffix) {
  return readdirSync(directory)
    .filter((filename) => filename.endsWith(suffix))
    .map((filename) => ({ filename, data: readJson(join(directory, filename)) }));
}

function validateMutation(mutate) {
  const candidateSchemas = structuredClone(schemas);
  const candidateExamples = structuredClone(examples);
  mutate(candidateExamples, candidateSchemas);
  return validateMachineArtifacts({
    schemas: candidateSchemas,
    examples: candidateExamples,
    taxonomyVersion: taxonomy.taxonomy_version,
    taxonomy
  });
}

function example(records, type) {
  return records.find((entry) => entry.data.record_type === type).data;
}

test("all four machine-only examples compile and link", () => {
  const result = validateMutation(() => {});
  assert.deepEqual(result.errors, []);
  assert.equal(result.recordCount, 4);
});

test("a machine record cannot silently drift to another taxonomy version", () => {
  const result = validateMutation((records) => {
    example(records, "repair_attempt").provenance.taxonomy.version = "1.1.0";
  });
  assert.ok(result.errors.some((error) => error.rule === "R9"));
});

test("cross-record candidate digests must preserve artifact identity", () => {
  const result = validateMutation((records) => {
    example(records, "verification_run").candidates.candidate.digest = "f".repeat(64);
  });
  assert.ok(result.errors.some((error) => error.rule === "R10" && error.message.includes("digest")));
});

test("every order trial must use a declared judge", () => {
  const result = validateMutation((records) => {
    example(records, "verification_run").order_trials[0].judge_id = "actor.ghost-judge";
  });
  assert.ok(result.errors.some((error) => error.rule === "R10" && error.message.includes("未声明")));
});

test("AB/BA coverage cannot be forged by duplicate presentation orders", () => {
  const result = validateMutation((records) => {
    const run = example(records, "verification_run");
    const pair = run.order_trials.filter(
      (trial) => trial.repeat_id === "repeat-001" && trial.judge_id === "actor.judge-01"
    );
    pair[1].order = "AB";
  });
  assert.ok(result.errors.some((error) => error.rule === "R10" && error.message.includes("恰有一次")));
});

test("persisted promotion output must equal a fresh deterministic recomputation", () => {
  const result = validateMutation((records) => {
    example(records, "verification_run").promotion_gate.metrics.repeat_runs.observed = 999;
  });
  assert.ok(result.errors.some((error) => error.rule === "R10" && error.message.includes("重新计算")));
});

test("diagnostic evidence spans must reproduce the quoted source text", () => {
  const result = validateMutation((records) => {
    example(records, "diagnostic_trace").findings[0].evidence[0].span.end -= 1;
  });
  assert.ok(result.errors.some((error) => error.rule === "R10" && error.message.includes("span")));
});

test("diagnostic label IDs and kinds are checked against the taxonomy", () => {
  const result = validateMutation((records) => {
    const finding = example(records, "diagnostic_trace").findings[0];
    finding.label_id = "invented_failure_label";
    finding.label_kind = "causal_hypothesis";
    finding.supporting_finding_ids = ["finding.ghost-1", "finding.ghost-2"];
  });
  assert.ok(result.errors.some((error) => error.rule === "R10" && error.message.includes("不存在的 label_id")));
  assert.ok(result.errors.some((error) => error.rule === "R10" && error.message.includes("至少两个 present symptom")));
});
