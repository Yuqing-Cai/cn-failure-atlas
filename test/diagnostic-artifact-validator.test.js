import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateDiagnosticArtifact } from "../lib/diagnostic-artifact-validator.js";

const root = new URL("../", import.meta.url);
const taxonomy = readJson(new URL("taxonomy.json", root));
const example = readJson(
  new URL("examples/machine-only/diagnostic-trace.example.json", root),
);
const symptoms = new Map();
for (const layer of taxonomy.layers) {
  for (const subcategory of layer.subcategories) {
    for (const symptom of subcategory.labels) symptoms.set(symptom.id, symptom);
  }
}

test("the diagnostic example has internally replayable evidence and scene contracts", () => {
  assert.deepEqual(validateDiagnosticArtifact(example, taxonomy), []);
});

test("every scene contract digest is recomputed from an embedded contract", () => {
  const trace = structuredClone(example);
  trace.subject.scenes[0].contract.intent = "silently changed contract";

  assert.ok(
    validateDiagnosticArtifact(trace, taxonomy).some((message) =>
      message.includes("不能由内嵌 contract 重算"),
    ),
  );
});

test("conversation and cross_scene scopes are orthogonal", () => {
  const trace = structuredClone(example);
  const finding = trace.findings[0];
  finding.label_id = "drift_without_correction";
  finding.scope = "cross_scene";
  finding.neighboring_label_rebuttals = [];
  finding.taxonomy_test_results[0].taxonomy_test =
    symptoms.get(finding.label_id).discriminating_tests[0];

  assert.ok(
    validateDiagnosticArtifact(trace, taxonomy).some((message) =>
      message.includes("scope cross_scene 低于 taxonomy 要求的 conversation"),
    ),
  );
});

test("a rebuttal may cite only evidence owned by its finding", () => {
  const trace = structuredClone(example);
  const second = structuredClone(trace.findings[0]);
  second.finding_id = "finding.second";
  for (const evidence of second.evidence) {
    evidence.evidence_id = `${evidence.evidence_id}.second`;
  }
  second.taxonomy_test_results[0].evidence_ids = [second.evidence[1].evidence_id];
  for (const rebuttal of second.neighboring_label_rebuttals) {
    rebuttal.evidence_ids = [second.evidence[1].evidence_id];
  }
  trace.findings.push(second);
  trace.findings[0].neighboring_label_rebuttals[0].evidence_ids = [
    second.evidence[1].evidence_id,
  ];

  assert.ok(
    validateDiagnosticArtifact(trace, taxonomy).some((message) =>
      message.includes("rebuttal 引用了不属于本 finding"),
    ),
  );
});

test("co-present overlap must use supporting evidence on both findings", () => {
  const trace = structuredClone(example);
  const primary = trace.findings[0];
  const neighbor = structuredClone(primary);
  neighbor.finding_id = "finding.tension-neighbor";
  neighbor.label_id = "tension_premature_resolution";
  for (const evidence of neighbor.evidence) {
    evidence.evidence_id = `${evidence.evidence_id}.neighbor`;
  }
  neighbor.evidence[0].stance = "supports";
  neighbor.evidence[1].stance = "refutes";
  neighbor.taxonomy_test_results[0] = {
    taxonomy_test: symptoms.get(neighbor.label_id).discriminating_tests[0],
    outcome: "passed",
    rationale: "Synthetic neighboring finding boundary result.",
    evidence_ids: [neighbor.evidence[0].evidence_id],
  };
  for (const rebuttal of neighbor.neighboring_label_rebuttals) {
    rebuttal.evidence_ids = [neighbor.evidence[0].evidence_id];
  }
  trace.findings.push(neighbor);

  Object.assign(primary.neighboring_label_rebuttals[0], {
    verdict: "co_present",
    neighbor_finding_id: neighbor.finding_id,
    evidence_ids: [primary.evidence[0].evidence_id],
  });

  assert.ok(
    validateDiagnosticArtifact(trace, taxonomy).some((message) =>
      message.includes("没有共享或重叠的支持证据"),
    ),
  );
});

test("a symptom with no frozen neighbor records a boundary test without inventing one", () => {
  const trace = structuredClone(example);
  const finding = trace.findings[0];
  finding.label_id = "tonal_whiplash";
  finding.neighboring_label_rebuttals = [];
  finding.taxonomy_test_results[0].taxonomy_test =
    symptoms.get(finding.label_id).discriminating_tests[0];

  const messages = validateDiagnosticArtifact(trace, taxonomy);
  assert.ok(!messages.some((message) => message.includes("neighboring label")));
  assert.ok(!messages.some((message) => message.includes("冻结的 discriminating_test")));
});

test("an unresolved frozen neighbor cannot coexist with a present symptom claim", () => {
  const trace = structuredClone(example);
  trace.findings[0].neighboring_label_rebuttals[0].verdict =
    "uncertain_between";

  assert.ok(
    validateDiagnosticArtifact(trace, taxonomy).some((message) =>
      message.includes("仍与冻结近邻无法区分，不得标为 present"),
    ),
  );
});

test("finding-kind-specific fields cannot be mixed back together", () => {
  const trace = structuredClone(example);
  trace.findings[0].label_id = "closure_drive";
  trace.findings[0].label_kind = "causal_hypothesis";
  trace.findings[0].status = "uncertain";

  const messages = validateDiagnosticArtifact(trace, taxonomy);
  assert.ok(messages.some((message) => message.includes("不得记录 taxonomy_test_results")));
  assert.ok(messages.some((message) => message.includes("不得记录 neighboring_label_rebuttals")));
});

test("priority findings must resolve to present or uncertain findings", () => {
  const trace = structuredClone(example);
  trace.disposition.priority_finding_ids = ["finding.missing"];

  assert.ok(
    validateDiagnosticArtifact(trace, taxonomy).some((message) =>
      message.includes("必须指向 present 或 uncertain finding"),
    ),
  );
});

test("repair disposition and priority findings must agree", () => {
  const trace = structuredClone(example);
  trace.disposition.repair_recommended = false;

  assert.ok(
    validateDiagnosticArtifact(trace, taxonomy).some((message) =>
      message.includes("repair_recommended 为 false"),
    ),
  );
});

function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}
