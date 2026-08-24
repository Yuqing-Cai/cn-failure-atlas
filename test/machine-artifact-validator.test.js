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
    taxonomy,
    trustRoot: readJson(join(REPOSITORY_ROOT, "config", "promotion-trust-root.example.json")),
    runReceipt: readJson(join(REPOSITORY_ROOT, "config", "promotion-run-receipt.example.json")),
    enforceConformanceExamples: true
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
    const run = example(records, "verification_run");
    run.promotion_gate = {
      decision_version: "2.0.0-alpha.1",
      run_id: run.verification_id,
      policy_id: "policy.machine-only.v1",
      status: "adopted",
      reason_codes: ["ALL_ADOPTION_GATES_PASSED"],
      metrics: { tampered: true },
      lifecycle_state: "promoted",
      lifecycle_reason: "Deliberately inconsistent test fixture.",
    };
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

test("repair targets must be the reparable priority present symptoms", () => {
  const uncertain = validateMutation((records) => {
    example(records, "diagnostic_trace").findings[0].status = "uncertain";
  });
  assert.ok(
    uncertain.errors.some(
      (error) =>
        error.rule === "R10" && error.message.includes("必须是 present symptom"),
    ),
  );

  const notPriority = validateMutation((records) => {
    example(records, "diagnostic_trace").disposition.priority_finding_ids = [];
  });
  assert.ok(
    notPriority.errors.some(
      (error) =>
        error.rule === "R10" &&
        error.message.includes("priority_finding_ids 中的 present symptoms 完全一致"),
    ),
  );
});

test("repair and verification may cite only supporting evidence owned by their finding", () => {
  const refutingRepairEvidence = validateMutation((records) => {
    example(records, "repair_attempt").repair_plan.edits[0].source_evidence_ids = [
      "evidence.closure-counter-001",
    ];
  });
  assert.ok(
    refutingRepairEvidence.errors.some(
      (error) =>
        error.rule === "R10" &&
        error.message.includes("source evidence") &&
        error.message.includes("stance 为 supports"),
    ),
  );

  const refutingVerificationEvidence = validateMutation((records) => {
    example(records, "verification_run").evidence_checks[0].evidence_ids = [
      "evidence.closure-counter-001",
    ];
  });
  assert.ok(
    refutingVerificationEvidence.errors.some(
      (error) =>
        error.rule === "R10" &&
        error.message.includes("evidence_checks 的 evidence") &&
        error.message.includes("stance 为 supports"),
    ),
  );
});

test("repair and verification cannot borrow another finding's supporting evidence", () => {
  const result = validateMutation((records) => {
    const trace = example(records, "diagnostic_trace");
    const source = trace.findings[0];
    const parallel = structuredClone(source);
    parallel.finding_id = "finding.affective-closure-parallel";
    const remappedEvidenceIds = new Map();
    for (const evidence of parallel.evidence) {
      const remapped = `${evidence.evidence_id}-parallel`;
      remappedEvidenceIds.set(evidence.evidence_id, remapped);
      evidence.evidence_id = remapped;
    }
    for (const testResult of parallel.taxonomy_test_results) {
      testResult.evidence_ids = testResult.evidence_ids.map((evidenceId) =>
        remappedEvidenceIds.get(evidenceId),
      );
    }
    for (const rebuttal of parallel.neighboring_label_rebuttals) {
      rebuttal.evidence_ids = rebuttal.evidence_ids.map((evidenceId) =>
        remappedEvidenceIds.get(evidenceId),
      );
    }
    trace.findings.push(parallel);

    const borrowedEvidenceId = remappedEvidenceIds.get("evidence.closure-001");
    example(records, "repair_attempt").repair_plan.edits[0].source_evidence_ids = [
      borrowedEvidenceId,
    ];
    example(records, "verification_run").evidence_checks[0].evidence_ids = [
      borrowedEvidenceId,
    ];
  });

  assert.ok(
    result.errors.some(
      (error) =>
        error.rule === "R10" &&
        error.message.includes("repair edit 的 source evidence") &&
        error.message.includes("必须属于 target finding"),
    ),
  );
  assert.ok(
    result.errors.some(
      (error) =>
        error.rule === "R10" &&
        error.message.includes("evidence_checks 的 evidence") &&
        error.message.includes("必须属于 finding"),
    ),
  );
});

test("supersedes references are content-addressed and keep same-record schema identity", () => {
  for (const recordType of [
    "evolution_policy",
    "diagnostic_trace",
    "repair_attempt",
    "verification_run",
  ]) {
    const missingDigest = validateMutation((records) => {
      const record = example(records, recordType);
      record.supersedes_ref = {
        record_id: `${recordType}.prior`,
        schema_id: record.provenance.schema.id,
        schema_version: record.schema_version,
        uri: `${recordType}.prior.json`,
      };
    });
    assert.ok(
      missingDigest.errors.some(
        (error) =>
          error.rule === "R8" &&
          error.message.includes("supersedes_ref") &&
          error.message.includes("digest"),
      ),
      recordType,
    );

    const wrongSchema = validateMutation((records) => {
      const record = example(records, recordType);
      record.supersedes_ref = {
        record_id: `${recordType}.prior`,
        schema_id:
          "https://yuqing-cai.github.io/cn-failure-atlas/schemas/wrong.schema.json",
        schema_version: record.schema_version,
        uri: `${recordType}.prior.json`,
        digest: "a".repeat(64),
      };
    });
    assert.ok(
      wrongSchema.errors.some(
        (error) =>
          error.rule === "R10" &&
          error.message.includes(`${recordType}.supersedes_ref`) &&
          error.message.includes("schema_id/schema_version"),
      ),
      recordType,
    );
  }
});
