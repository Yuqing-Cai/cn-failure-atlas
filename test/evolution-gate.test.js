import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_POLICY,
  collectPromptBundleDescriptors,
  computeAuditCheckSeed,
  computeAuditRequestDigest,
  computeBlindingProtocolDigest,
  computeChallengeRequestDigest,
  computeChallengeResolutionRequestDigest,
  computeEvaluationInvocationPlanDigest,
  computeEvaluationCaseCommitments,
  computeExperimentPlanDigest,
  computeGenerationInputDigest,
  computeJudgeActorSetDigest,
  computePreferenceRequestDigest,
  computeRepairInputDigest,
  computeRepeatInputDigest,
  computeRepeatPlanDigest,
  computeRepeatRunDigest,
  computeVerificationRunAttestationDigest,
  evaluatePromotion as evaluatePromotionRecord,
  diagnosticPrecommitPayload,
  getLocalSchemaDescriptor,
  generationPrecommitPayload,
  normalizePolicy,
  promotionRunCompletionPayload,
  promotionRunReceiptPayload,
  verificationPrecommitPayload,
  validateGateInputSchemas,
} from "../lib/evolution-gate.js";
import {
  canonicalJson,
  sha256Json,
  sha256Text,
} from "../lib/content-integrity.js";
import {
  computeTaxonomyTestExecutionDigest,
  computeTaxonomyTestInputDigest,
} from "../lib/diagnostic-artifact-validator.js";

const {
  publicKey: TEST_PUBLIC_KEY_OBJECT,
  privateKey: TEST_PRIVATE_KEY,
} = generateKeyPairSync("ed25519");
const TEST_PUBLIC_KEY = TEST_PUBLIC_KEY_OBJECT.export({
  type: "spki",
  format: "pem",
});

const root = new URL("../", import.meta.url);
const policyExample = readJson(
  new URL("examples/machine-only/evolution-policy.example.json", root),
);
const runExample = readJson(
  new URL("examples/machine-only/verification-run.example.json", root),
);
const traceExample = readJson(
  new URL("examples/machine-only/diagnostic-trace.example.json", root),
);
const repairExample = readJson(
  new URL("examples/machine-only/repair-attempt.example.json", root),
);
const taxonomyExample = readJson(new URL("taxonomy.json", root));

function evaluatePromotion(policy, run) {
  const trace = structuredClone(traceExample);
  const repair = structuredClone(repairExample);
  const preserveClaimedRunDigests = run.repeat_manifest?.some(
    (entry, index) =>
      entry.run_digest !== runExample.repeat_manifest[index]?.run_digest,
  );
  const preserveClaimedInputDigests = run.repeat_manifest?.some(
    (entry, index) =>
      entry.input_digest !== runExample.repeat_manifest[index]?.input_digest,
  );
  const preserveClaimedCandidateDigests = ["baseline", "candidate"].some(
    (candidateId) =>
      run.candidates?.[candidateId]?.digest !==
      runExample.candidates?.[candidateId]?.digest,
  );
  const shouldVerify =
    policy.provenance.digest_status === "verified" &&
    run.provenance.digest_status === "verified";
  for (const record of [policy, trace, repair, run]) {
    if (shouldVerify) record.provenance.digest_status = "verified";
    record.provenance.schema = getLocalSchemaDescriptor(record.record_type);
  }
  if (!validateGateInputSchemas(policy, run).valid) {
    return evaluatePromotionRecord(policy, run);
  }
  resealBundle(policy, run, trace, repair, {
    preserveClaimedInputDigests,
    preserveClaimedRunDigests,
    preserveClaimedCandidateDigests,
  });
  const artifactBundle = {
    diagnostic_trace: trace,
    repair_attempt: repair,
    taxonomy: structuredClone(taxonomyExample),
  };
  const trustRoot = makeTrustRoot(policy, [policy, trace, repair, run]);
  const receipt = makeRunReceipt(policy, run, artifactBundle, trustRoot);
  return evaluatePromotionRecord(
    policy,
    run,
    artifactBundle,
    trustRoot,
    receipt,
  );
}

function makeTrustRoot(policy, records) {
  const run = records.find((record) => record.record_type === "verification_run");
  const trustedRunners = [
    ...new Map(
      records.map((record) => [
        JSON.stringify(record.provenance.runner),
        structuredClone(record.provenance.runner),
      ]),
    ).values(),
  ];
  return {
    record_type: "promotion_trust_root",
    schema_version: "1.0.0",
    trust_root_id: "trust-root.test.v1",
    policy_id: policy.policy.id,
    policy_version: policy.policy.version,
    policy_digest: policy.policy_digest,
    taxonomy_name: taxonomyExample.name,
    taxonomy_version: taxonomyExample.taxonomy_version,
    taxonomy_digest: sha256Json(taxonomyExample),
    trusted_runners: trustedRunners,
    trusted_prompt_bundles: collectPromptBundleDescriptors(records),
    trusted_regression_suites: makeTrustedRegressionSuites(run),
    receipt_public_keys: [
      {
        key_id: "key.test.ed25519.v1",
        issuer_id: "orchestrator.test.v1",
        algorithm: "Ed25519",
        public_key_pem: TEST_PUBLIC_KEY,
      },
    ],
    immutable: true,
    created_at: "2026-08-24T09:50:00Z",
  };
}

function makeTrustedRegressionSuites(run) {
  const suites = new Map();
  for (const check of run?.regression_checks ?? []) {
    const key = `${check.suite_id}\u0000${check.suite_version}`;
    if (!suites.has(key)) {
      suites.set(key, {
        suite_id: check.suite_id,
        suite_version: check.suite_version,
        suite_digest: check.suite_digest,
        suite_uri: `registry://test/suites/${encodeURIComponent(check.suite_id)}.json`,
        digest_rule: "sha256_rfc8785_json",
        cases: [],
      });
    }
    suites.get(key).cases.push({
      case_id: check.case_id,
      case_digest: check.case_digest,
      case_uri: `registry://test/cases/${encodeURIComponent(check.case_id)}.json`,
      digest_rule: "sha256_rfc8785_json",
      required_for_promotion: true,
      failure_policy: "hard_veto",
    });
  }
  return [...suites.values()];
}

function makeRunReceipt(policy, run, artifactBundle, trustRoot) {
  const trace = artifactBundle.diagnostic_trace;
  const repair = artifactBundle.repair_attempt;
  const outputTurnId = trace.subject.generator_output_turn_id;
  const outputTurn = trace.subject.turns.find(
    (turn) => turn.turn_id === outputTurnId,
  );
  const scene = trace.subject.scenes.find(
    (item) => item.scene_id === outputTurn?.scene_id,
  );
  const generationPrecommit = {
    generation_request_id: "generation-request.test.v1",
    single_use_nonce: "b".repeat(64),
    subject_record_id: trace.subject.record_id,
    output_turn_id: outputTurnId,
    scene_id: scene.scene_id,
    input_digest: computeGenerationInputDigest(trace, outputTurnId),
    scene_contract_digest: scene.contract_digest,
    generator_actor_digest: sha256Json(trace.actors.generator),
    contract_critic_actor_digest: sha256Json(trace.actors.contract_critic),
    policy_digest: policy.policy_digest,
    taxonomy_digest: sha256Json(artifactBundle.taxonomy),
    trust_root_id: trustRoot.trust_root_id,
    trust_root_digest: sha256Json(trustRoot),
    experiment_plan_digest: computeExperimentPlanDigest(
      trace.experiment_ledger,
    ),
    trace_identity_isolation_digest: sha256Json(trace.identity_isolation),
    issued_at: "2026-08-24T09:59:50Z",
    issuer_id: "orchestrator.test.v1",
  };
  generationPrecommit.signature = {
    key_id: "key.test.ed25519.v1",
    algorithm: "Ed25519",
    value: signPayload(
      null,
      Buffer.from(
        canonicalJson(generationPrecommitPayload(generationPrecommit)),
        "utf8",
      ),
      TEST_PRIVATE_KEY,
    ).toString("base64"),
  };
  const diagnosticPrecommit = {
    diagnostic_request_id: "diagnostic-request.test.v1",
    single_use_nonce: "a".repeat(64),
    generation_request_id: generationPrecommit.generation_request_id,
    output_turn_id: outputTurnId,
    output_digest: sha256Text(outputTurn.content),
    critic_actor_digest: sha256Json(trace.actors.critic),
    test_judge_actor_digest: sha256Json(trace.actors.test_judge),
    taxonomy_digest: sha256Json(artifactBundle.taxonomy),
    experiment_plan_digest: computeExperimentPlanDigest(
      trace.experiment_ledger,
    ),
    trace_identity_isolation_digest: sha256Json(trace.identity_isolation),
    issued_at: "2026-08-24T09:59:59Z",
    issuer_id: "orchestrator.test.v1",
  };
  diagnosticPrecommit.signature = {
    key_id: "key.test.ed25519.v1",
    algorithm: "Ed25519",
    value: signPayload(
      null,
      Buffer.from(
        canonicalJson(diagnosticPrecommitPayload(diagnosticPrecommit)),
        "utf8",
      ),
      TEST_PRIVATE_KEY,
    ).toString("base64"),
  };
  const receipt = {
    record_type: "promotion_run_receipt",
    schema_version: "1.1.0",
    generation_precommits: [generationPrecommit],
    diagnostic_precommits: [diagnosticPrecommit],
    receipt_id: "receipt.test.v1",
    run_request_id: "request.test.v1",
    single_use_nonce: "c".repeat(64),
    policy_digest: policy.policy_digest,
    taxonomy_digest: sha256Json(artifactBundle.taxonomy),
    diagnostic_trace_ref: {
      ...run.diagnostic_trace_ref,
      digest: sha256Json(trace),
    },
    repair_id: repair.repair_id,
    repair_input_digest: computeRepairInputDigest(trace, repair),
    baseline_digest: repair.candidates.baseline.digest,
    repair_generator_actor_digest: sha256Json(
      repair.actors.repair_generator,
    ),
    repair_critic_actor_digest: sha256Json(repair.actors.critic),
    evaluation_invocation_plan_digest:
      computeEvaluationInvocationPlanDigest(run),
    blinding_protocol_digest: computeBlindingProtocolDigest(run),
    mapping_visible_to_repairer: false,
    verification_id: run.verification_id,
    input_digest: trace.subject.input_digest,
    experiment_ledger_digest: sha256Json(trace.experiment_ledger),
    manifest_id: run.evaluation_manifest.manifest_id,
    manifest_version: run.evaluation_manifest.manifest_version,
    manifest_digest: run.evaluation_manifest.manifest_digest,
    frozen_at: run.evaluation_manifest.frozen_at,
    issued_at: "2026-08-24T10:00:45Z",
    issuer_id: "orchestrator.test.v1",
  };
  receipt.signature = {
    key_id: "key.test.ed25519.v1",
    algorithm: "Ed25519",
    value: signPayload(
      null,
      Buffer.from(canonicalJson(promotionRunReceiptPayload(receipt)), "utf8"),
      TEST_PRIVATE_KEY,
    ).toString("base64"),
  };
  receipt.verification_precommit = {
    verification_request_id: "verification-request.test.v1",
    single_use_nonce: "e".repeat(64),
    repair_attempt_digest: sha256Json(repair),
    baseline_digest: repair.candidates.baseline.digest,
    candidate_digest: repair.candidates.candidate.digest,
    manifest_digest: run.evaluation_manifest.manifest_digest,
    repeat_input_digest: computeRepeatInputDigest(
      policy,
      run,
      artifactBundle,
    ),
    repeat_plan_digest: computeRepeatPlanDigest(run),
    judge_actor_set_digest: computeJudgeActorSetDigest(run),
    blinding_mapping_digest: run.blinding.mapping_digest,
    issued_at: "2026-08-24T10:04:30Z",
    issuer_id: "orchestrator.test.v1",
  };
  receipt.verification_precommit.signature = {
    key_id: "key.test.ed25519.v1",
    algorithm: "Ed25519",
    value: signPayload(
      null,
      Buffer.from(
        canonicalJson(verificationPrecommitPayload(receipt)),
        "utf8",
      ),
      TEST_PRIVATE_KEY,
    ).toString("base64"),
  };
  receipt.completion = {
    completed_at: "2026-08-24T10:08:00Z",
    diagnostic_trace_digest: sha256Json(trace),
    repair_attempt_digest: sha256Json(repair),
    verification_run_digest: computeVerificationRunAttestationDigest(run),
    candidate_digest: repair.candidates.candidate.digest,
  };
  receipt.completion.signature = {
    key_id: "key.test.ed25519.v1",
    algorithm: "Ed25519",
    value: signPayload(
      null,
      Buffer.from(
        canonicalJson(promotionRunCompletionPayload(receipt)),
        "utf8",
      ),
      TEST_PRIVATE_KEY,
    ).toString("base64"),
  };
  return receipt;
}

function resealBundle(
  policy,
  run,
  trace,
  repair,
  {
    preserveClaimedInputDigests = false,
    preserveClaimedRunDigests = false,
    preserveClaimedCandidateDigests = false,
  } = {},
) {
  const primaryTurn = trace.subject.turns.find(
    (turn) => turn.turn_id === trace.subject.generator_output_turn_id,
  );
  const primaryScene = trace.subject.scenes.find(
    (scene) => scene.scene_id === primaryTurn?.scene_id,
  );
  primaryScene.contract = structuredClone(trace.scene_contract);
  primaryScene.contract_digest = sha256Json(trace.scene_contract);
  trace.subject.input_digest = computeGenerationInputDigest(
    trace,
    trace.subject.generator_output_turn_id,
  );
  const taxonomyDigest = sha256Json(taxonomyExample);
  for (const finding of trace.findings ?? []) {
    const taxonomyLabel = taxonomyExample.layers
      .flatMap((layer) => layer.subcategories)
      .flatMap((subcategory) => subcategory.labels)
      .find((label) => label.id === finding.label_id);
    for (const result of finding.taxonomy_test_results ?? []) {
      const execution = result.execution;
      if (!execution) continue;
      const targetTurn = trace.subject.turns.find(
        (turn) => turn.turn_id === execution.intervention.target_turn_id,
      );
      const targetScene = trace.subject.scenes.find(
        (scene) => scene.scene_id === targetTurn?.scene_id,
      );
      const recipe = taxonomyLabel?.test_recipes?.find(
        (item) => item.recipe_id === result.recipe_id,
      );
      execution.scene_contract_digest = targetScene.contract_digest;
      execution.input_digest = computeTaxonomyTestInputDigest(
        trace,
        result,
        finding,
        taxonomyExample,
        recipe,
      );
      execution.output.digest = sha256Text(execution.output.content);
      execution.execution_digest = computeTaxonomyTestExecutionDigest({
        finding,
        result,
        taxonomy: taxonomyExample,
        recipe,
      });
    }
  }
  for (const record of [policy, trace, repair, run]) {
    record.provenance.taxonomy.version = taxonomyExample.taxonomy_version;
    record.provenance.taxonomy.digest = taxonomyDigest;
  }
  const policyPayload = {
    schema_version: policy.schema_version,
    mode: policy.mode,
    provenance: policy.provenance,
    ...(policy.supersedes_ref ? { supersedes_ref: policy.supersedes_ref } : {}),
    policy: policy.policy,
    actor_isolation: policy.actor_isolation,
    verification_protocol: policy.verification_protocol,
    promotion_lifecycle: policy.promotion_lifecycle,
    rollback_policy: policy.rollback_policy,
  };
  policy.policy_digest = sha256Json(policyPayload);
  for (const record of [trace, repair, run]) {
    record.policy_ref.digest = policy.policy_digest;
  }
  for (const candidateId of ["baseline", "candidate"]) {
    repair.candidates[candidateId].digest = sha256Text(
      repair.candidates[candidateId].content,
    );
    if (!preserveClaimedCandidateDigests) {
      run.candidates[candidateId].digest = repair.candidates[candidateId].digest;
    }
  }
  for (const trial of run.order_trials) {
    const requestDigest = computePreferenceRequestDigest(
      run,
      trial,
      { diagnostic_trace: trace, repair_attempt: repair },
    );
    if (requestDigest) trial.preference_request_digest = requestDigest;
  }
  for (const collectionName of [
    "evidence_checks",
    "target_failure_checks",
    "counterfactual_checks",
    "regression_checks",
  ]) {
    for (const check of run[collectionName]) {
      const judge = run.actor_profiles.audit_judges.find(
        (item) => item.id === check.judge_id,
      );
      if (!judge) continue;
      check.invocation_id ??=
        `invocation.audit.${collectionName}.${check.check_id}`;
      check.context_partition ??=
        `audit/${collectionName}/${check.check_id}/${check.judge_id}`;
      check.seed ??= computeAuditCheckSeed(
        judge.seed,
        collectionName,
        check.check_id,
      );
      const requestDigest = computeAuditRequestDigest(
        run,
        collectionName,
        check,
        { diagnostic_trace: trace, repair_attempt: repair },
      );
      if (requestDigest) check.audit_request_digest = requestDigest;
    }
  }
  for (const invocation of run.challenge_invocations) {
    const requestDigest =
      invocation.invocation_kind === "challenge_raiser"
        ? computeChallengeRequestDigest(run, invocation, {
            diagnostic_trace: trace,
            repair_attempt: repair,
          })
        : computeChallengeResolutionRequestDigest(run, invocation, {
            diagnostic_trace: trace,
            repair_attempt: repair,
          });
    if (requestDigest && invocation.invocation_kind === "challenge_raiser") {
      invocation.challenge_request_digest = requestDigest;
    } else if (requestDigest) {
      invocation.resolution_request_digest = requestDigest;
    }
  }
  Object.assign(run.promotion_artifact, {
    artifact_version: run.promotion_artifact.payload.case_version,
  });
  Object.assign(run.promotion_artifact.payload, {
    repair_id: repair.repair_id,
    candidate_digest: repair.candidates.candidate.digest,
    strategy_id: repair.repair_plan.strategy_id,
    strategy_version: repair.repair_plan.strategy_version,
    target_finding_ids: [...repair.target_finding_ids],
    hypothesis: repair.repair_plan.hypothesis,
    minimality_rule: repair.repair_plan.minimality_rule,
  });
  run.promotion_artifact.artifact_digest = sha256Json(
    run.promotion_artifact.payload,
  );

  const idFields = {
    evidence_checks: "check_id",
    target_failure_checks: "check_id",
  counterfactual_checks: "check_id",
  regression_checks: "check_id",
  order_trials: "trial_id",
};
  for (const [collection, idField] of Object.entries(idFields)) {
    run.evaluation_manifest.expected_case_ids[collection] = run[collection].map(
      (item) => item[idField],
    );
  }
  delete run.evaluation_manifest.expected_case_ids.challenges;
  run.evaluation_manifest.commitment_rule =
    "pre_execution_projection_sha256_rfc8785";
  run.evaluation_manifest.expected_case_digests =
    computeEvaluationCaseCommitments(run);
  const manifestPayload = { ...run.evaluation_manifest };
  delete manifestPayload.manifest_digest;
  run.evaluation_manifest.manifest_digest = sha256Json(manifestPayload);
  Object.assign(repair.verification_handoff.evaluation_manifest_commitment, {
    manifest_id: run.evaluation_manifest.manifest_id,
    manifest_version: run.evaluation_manifest.manifest_version,
    manifest_digest: run.evaluation_manifest.manifest_digest,
    frozen_at: run.evaluation_manifest.frozen_at,
    coverage_rule: run.evaluation_manifest.coverage_rule,
    commitment_rule: run.evaluation_manifest.commitment_rule,
  });

  const traceDigest = sha256Json(trace);
  repair.diagnostic_trace_ref.digest = traceDigest;
  run.diagnostic_trace_ref.digest = traceDigest;
  const repairDigest = sha256Json(repair);
  run.repair_attempt_ref.digest = repairDigest;
  run.promotion_artifact.source_ref.digest = repairDigest;
  const artifactBundle = {
    diagnostic_trace: trace,
    repair_attempt: repair,
    taxonomy: taxonomyExample,
  };
  const inputDigest = computeRepeatInputDigest(policy, run, artifactBundle);
  for (const repeat of run.repeat_manifest) {
    if (!preserveClaimedInputDigests) repeat.input_digest = inputDigest;
    if (!preserveClaimedRunDigests) {
      repeat.run_digest = computeRepeatRunDigest(run, repeat);
    }
  }
}

test("a canonical run with verified provenance is adopted", () => {
  const { policy, run } = inputs();
  const result = evaluatePromotion(policy, run);

  assert.equal(validateGateInputSchemas(policy, run).valid, true);
  assert.equal(result.status, "adopted", JSON.stringify(result, null, 2));
  assert.deepEqual(result.reason_codes, ["ALL_ADOPTION_GATES_PASSED"]);
  assert.equal(result.metrics.order_swap.complete_pairs, 4);
  assert.equal(result.metrics.order_swap.coverage_pass, true);
  assert.equal(result.metrics.check_references.pass, true);
  assert.equal(result.metrics.provenance.pass, true);
});

test("illustrative placeholder digests can never be promoted", () => {
  const { policy, run } = inputs({ verified: false });
  const result = evaluatePromotion(policy, run);
  assert.equal(result.status, "inconclusive");
  assert.ok(result.reason_codes.includes("UNVERIFIED_PROVENANCE"));
  assert.equal(result.metrics.provenance.pass, false);
});

test("formal schemas are mandatory and malformed regression items cannot pass", () => {
  const { policy, run } = inputs();
  run.regression_checks = [{}];

  const result = evaluatePromotion(policy, run);
  assert.equal(result.status, "inconclusive");
  assert.deepEqual(result.reason_codes, ["INVALID_VERIFICATION_RUN"]);
});

test("declared judges must cover the exact repeat Cartesian product", () => {
  const { policy, run } = inputs();
  run.order_trials = [];
  for (let repeat = 1; repeat <= 4; repeat += 1) {
    for (const order of ["AB", "BA"]) {
      run.order_trials.push({
        trial_id: `trial.fake-${repeat}.${order.toLowerCase()}`,
        repeat_id: `fake-${repeat}`,
        judge_id: "actor.judge-01",
        invocation_id: `invocation.fake-${repeat}.${order.toLowerCase()}`,
        context_partition: `fake/${repeat}/${order.toLowerCase()}`,
        seed: repeat * 10 + (order === "AB" ? 1 : 2),
        preference_request_digest: "0".repeat(64),
        executed_at: "2026-08-24T10:06:00Z",
        order,
        winner: "candidate",
        raw_choice: "B",
        rationale: "Adversarial coverage fixture.",
      });
    }
  }

  const result = evaluatePromotion(policy, run);
  assert.equal(result.status, "inconclusive");
  assert.ok(result.reason_codes.includes("REPEAT_RUN_COUNT_MISMATCH"));
  assert.ok(result.reason_codes.includes("ORDER_SWAP_MISSING"));
});

test("unknown trial judges and duplicate order slots are inconclusive", () => {
  const unknown = inputs();
  unknown.run.order_trials[0].judge_id = "actor.ghost-judge";
  const unknownResult = evaluatePromotion(unknown.policy, unknown.run);
  assert.equal(unknownResult.status, "inconclusive");
  assert.ok(unknownResult.reason_codes.includes("UNKNOWN_TRIAL_JUDGE"));

  const duplicate = inputs();
  duplicate.run.order_trials[1].order = "AB";
  const duplicateResult = evaluatePromotion(duplicate.policy, duplicate.run);
  assert.equal(duplicateResult.status, "inconclusive");
  assert.ok(duplicateResult.reason_codes.includes("DUPLICATE_ORDER_TRIAL"));
  assert.ok(duplicateResult.reason_codes.includes("ORDER_SWAP_MISSING"));
});

test("winner must be derived from the sealed blind alias and raw choice", () => {
  const { policy, run } = inputs();
  run.order_trials[0].raw_choice = run.candidates.baseline.blind_alias;

  const result = evaluatePromotion(policy, run);
  assert.equal(result.status, "inconclusive");
  assert.ok(result.reason_codes.includes("TRIAL_RESULT_MISMATCH"));
});

test("a consistently losing candidate is rejected", () => {
  const { policy, run } = inputs();
  for (const trial of run.order_trials) {
    trial.raw_choice = run.candidates.baseline.blind_alias;
    trial.winner = "baseline";
  }
  Object.assign(run.aggregation, {
    candidate_wins: 0,
    baseline_wins: 8,
    ties: 0,
    order_consistent_pairs: 4,
    winner: "baseline",
  });

  const result = evaluatePromotion(policy, run);
  assert.equal(result.status, "rejected");
  assert.ok(result.reason_codes.includes("CANDIDATE_NOT_PREFERRED"));
});

test("order swapping and candidate preference cannot be disabled", () => {
  const orderDisabled = inputs();
  orderDisabled.policy.policy.require_order_swap = false;
  assert.deepEqual(
    evaluatePromotion(orderDisabled.policy, orderDisabled.run).reason_codes,
    ["INVALID_POLICY"],
  );

  const preferenceDisabled = inputs();
  preferenceDisabled.policy.policy.require_candidate_preferred = false;
  assert.deepEqual(
    evaluatePromotion(preferenceDisabled.policy, preferenceDisabled.run)
      .reason_codes,
    ["INVALID_POLICY"],
  );
});

test("policy status, version binding, and promotion target are enforced", () => {
  const retired = inputs();
  retired.policy.policy.status = "rolled_back";
  assert.ok(
    evaluatePromotion(retired.policy, retired.run).reason_codes.includes(
      "POLICY_NOT_EXECUTABLE",
    ),
  );

  const wrongVersion = inputs();
  wrongVersion.run.policy_ref.policy_version = "9.9.9";
  assert.ok(
    evaluatePromotion(wrongVersion.policy, wrongVersion.run).reason_codes.includes(
      "POLICY_VERSION_MISMATCH",
    ),
  );

  const disallowedTarget = inputs();
  disallowedTarget.policy.policy.promotion_targets = ["critic_rule"];
  assert.ok(
    evaluatePromotion(disallowedTarget.policy, disallowedTarget.run)
      .reason_codes.includes("PROMOTION_TARGET_NOT_ALLOWED"),
  );
});

test("a single verified case cannot be promoted as a general repair strategy", () => {
  const { policy, run } = inputs();
  policy.policy.promotion_targets = ["repair_strategy"];
  const casePayload = run.promotion_artifact.payload;
  run.promotion_artifact = {
    ...run.promotion_artifact,
    target: "repair_strategy",
    artifact_id: casePayload.strategy_id,
    artifact_version: casePayload.strategy_version,
    schema_id:
      "https://yuqing-cai.github.io/cn-failure-atlas/schemas/verification-run.schema.json#/$defs/repairStrategyPayload",
    payload: {
      strategy_id: casePayload.strategy_id,
      candidate_digest: casePayload.candidate_digest,
      target_finding_ids: [...casePayload.target_finding_ids],
      hypothesis: casePayload.hypothesis,
      minimality_rule: casePayload.minimality_rule,
    },
  };
  run.promotion_artifact.artifact_digest = sha256Json(
    run.promotion_artifact.payload,
  );

  const result = evaluatePromotionRecord(policy, run);
  assert.notEqual(result.status, "adopted");
  assert.ok(result.reason_codes.includes("PROMOTION_TARGET_NOT_IMPLEMENTED"));
});

test("every check must reference a declared participating judge", () => {
  const { policy, run } = inputs();
  for (const field of [
    "evidence_checks",
    "counterfactual_checks",
    "regression_checks",
  ]) {
    for (const check of run[field]) check.judge_id = "actor.ghost-judge";
  }

  const result = evaluatePromotion(policy, run);
  assert.equal(result.status, "inconclusive");
  assert.ok(result.reason_codes.includes("UNKNOWN_CHECK_JUDGE"));
});

test("deployment names do not manufacture independent model origins", () => {
  const { policy, run } = inputs();
  setJudgeOrigin(run, 0, origin("same-model", "deployment-a"));
  setJudgeOrigin(run, 1, origin("same-model", "deployment-b"));

  const result = evaluatePromotion(policy, run);
  assert.equal(result.status, "inconclusive");
  assert.ok(result.reason_codes.includes("JUDGES_SHARE_ORIGIN"));
  assert.equal(result.metrics.independent_judges.observed, 1);
});

test("different fine-tune digests do not erase a shared model lineage", () => {
  const { policy, run } = inputs();
  setJudgeOrigin(run, 0, {
    ...origin("same-model", "deployment-a"),
    weights_digest: "a".repeat(64),
  });
  setJudgeOrigin(run, 1, {
    ...origin("same-model", "deployment-b"),
    weights_digest: "b".repeat(64),
  });

  const result = evaluatePromotion(policy, run);
  assert.equal(result.status, "inconclusive");
  assert.ok(result.reason_codes.includes("JUDGES_SHARE_ORIGIN"));
  assert.equal(result.metrics.independent_judges.observed, 1);
});

test("challenge outputs must match their frozen invocations", () => {
  const empty = inputs();
  empty.run.challenges = [];
  const emptyResult = evaluatePromotion(empty.policy, empty.run);
  assert.equal(emptyResult.status, "inconclusive");
  assert.ok(
    emptyResult.reason_codes.includes("CHALLENGE_INVOCATION_INVALID"),
  );

  const skipped = inputs();
  skipped.run.challenge_round_completed = false;
  const skippedResult = evaluatePromotion(skipped.policy, skipped.run);
  assert.equal(skippedResult.status, "inconclusive");
  assert.ok(skippedResult.reason_codes.includes("CHALLENGE_ROUND_INCOMPLETE"));
});

test("artifact mismatches quarantine and hard regression vetoes reject", () => {
  const identical = inputs();
  identical.run.candidates.candidate.digest =
    identical.run.candidates.baseline.digest;
  const identicalResult = evaluatePromotion(identical.policy, identical.run);
  assert.equal(identicalResult.status, "inconclusive");
  assert.ok(
    identicalResult.reason_codes.includes("CANDIDATE_ARTIFACT_UNCHANGED"),
  );
  assert.ok(identicalResult.reason_codes.includes("ARTIFACT_BUNDLE_INVALID"));

  const vetoed = inputs();
  vetoed.run.regression_checks[1].passed = false;
  vetoed.run.regression_checks[1].hard_veto = true;
  vetoed.run.aggregation.regression_failure_rate = 1 / 3;
  const vetoedResult = evaluatePromotion(vetoed.policy, vetoed.run);
  assert.equal(vetoedResult.status, "rejected");
  assert.ok(vetoedResult.reason_codes.includes("HARD_REGRESSION_VETO"));
});

test("all three blinding attestations must be true", () => {
  const { policy, run } = inputs();
  run.blinding.model_identity_hidden = false;

  const result = evaluatePromotion(policy, run);
  assert.equal(result.status, "inconclusive");
  assert.deepEqual(result.reason_codes, ["INVALID_VERIFICATION_RUN"]);
});

test("a clean run below the frozen repeat threshold remains a candidate", () => {
  const { policy, run } = inputs();
  run.repeat_runs = 1;
  run.repeat_manifest = run.repeat_manifest.filter(
    (entry) => entry.repeat_id === "repeat-001",
  );
  run.order_trials = run.order_trials.filter(
    (trial) => trial.repeat_id === "repeat-001",
  );
  run.aggregation.candidate_wins = 4;
  run.aggregation.order_consistent_pairs = 2;

  const result = evaluatePromotion(policy, run);
  assert.equal(result.status, "candidate");
  assert.deepEqual(result.reason_codes, ["INSUFFICIENT_REPEAT_RUNS"]);
});

test("an unresolved blocking challenge rejects", () => {
  const { policy, run } = inputs();
  run.challenges[0].resolved = false;
  run.challenges[0].response = "The counterexample remains unresolved.";
  delete run.challenges[0].resolved_by;
  delete run.challenges[0].resolution_check_ids;
  run.challenge_invocations = run.challenge_invocations.filter(
    (invocation) => invocation.invocation_kind !== "challenge_resolver",
  );

  const result = evaluatePromotion(policy, run);
  assert.equal(result.status, "rejected");
  assert.ok(
    result.reason_codes.includes("UNRESOLVED_HIGH_SEVERITY_CHALLENGE"),
  );
});

test("repeat manifests must exactly bind unique seeds and run digests", () => {
  const missing = inputs();
  missing.run.repeat_manifest.pop();
  const missingResult = evaluatePromotion(missing.policy, missing.run);
  assert.equal(missingResult.status, "inconclusive");
  assert.ok(missingResult.reason_codes.includes("REPEAT_MANIFEST_MISMATCH"));

  const duplicateSeed = inputs();
  duplicateSeed.run.repeat_manifest[1].seed =
    duplicateSeed.run.repeat_manifest[0].seed;
  const seedResult = evaluatePromotion(duplicateSeed.policy, duplicateSeed.run);
  assert.equal(seedResult.status, "inconclusive");
  assert.ok(seedResult.reason_codes.includes("DUPLICATE_REPEAT_SEED"));

  const duplicateDigest = inputs();
  duplicateDigest.run.repeat_manifest[1].run_digest =
    duplicateDigest.run.repeat_manifest[0].run_digest;
  const digestResult = evaluatePromotion(
    duplicateDigest.policy,
    duplicateDigest.run,
  );
  assert.equal(digestResult.status, "inconclusive");
  assert.ok(digestResult.reason_codes.includes("DUPLICATE_REPEAT_DIGEST"));
});

test("target failure evidence must be established and reduced", () => {
  const notEstablished = inputs();
  notEstablished.run.target_failure_checks[0].baseline_present = false;
  const notEstablishedResult = evaluatePromotion(
    notEstablished.policy,
    notEstablished.run,
  );
  assert.equal(notEstablishedResult.status, "inconclusive");
  assert.ok(
    notEstablishedResult.reason_codes.includes(
      "TARGET_FAILURE_NOT_ESTABLISHED",
    ),
  );

  const notReduced = inputs();
  notReduced.run.target_failure_checks[0].evidence_reduced = false;
  const notReducedResult = evaluatePromotion(notReduced.policy, notReduced.run);
  assert.equal(notReducedResult.status, "rejected");
  assert.ok(
    notReducedResult.reason_codes.includes("TARGET_FAILURE_NOT_REDUCED"),
  );

  const reducedButPresent = inputs();
  reducedButPresent.run.target_failure_checks[0].candidate_present = true;
  const reducedResult = evaluatePromotion(
    reducedButPresent.policy,
    reducedButPresent.run,
  );
  assert.equal(reducedResult.status, "rejected");
  assert.ok(reducedResult.reason_codes.includes("TARGET_FAILURE_PERSISTS"));
});

test("contaminated regressions and divergent aggregation are inconclusive", () => {
  const contaminated = inputs();
  contaminated.run.regression_checks[0].contamination_status = "contaminated";
  const contaminatedResult = evaluatePromotion(
    contaminated.policy,
    contaminated.run,
  );
  assert.equal(contaminatedResult.status, "inconclusive");
  assert.ok(
    contaminatedResult.reason_codes.includes(
      "CONTAMINATED_REGRESSION_EVIDENCE",
    ),
  );

  const divergent = inputs();
  divergent.run.aggregation.candidate_wins -= 1;
  const divergentResult = evaluatePromotion(divergent.policy, divergent.run);
  assert.equal(divergentResult.status, "inconclusive");
  assert.ok(divergentResult.reason_codes.includes("AGGREGATION_MISMATCH"));
});

test("duplicate checks cannot dilute another judge's failure", async (t) => {
  await t.test("counterfactual checks are thresholded per judge", () => {
    const { policy, run } = inputs();
    run.counterfactual_checks[0].passed = false;
    for (let index = 0; index < 20; index += 1) {
      const duplicateCheck = structuredClone(run.counterfactual_checks[1]);
      duplicateCheck.check_id = `counterfactual.dilution-${index}`;
      duplicateCheck.invocation_id = `invocation.audit.counterfactual.dilution-${index}`;
      duplicateCheck.context_partition = `audit/counterfactual/dilution-${index}`;
      duplicateCheck.seed = computeAuditCheckSeed(
        run.actor_profiles.audit_judges[1].seed,
        "counterfactual_checks",
        duplicateCheck.check_id,
      );
      duplicateCheck.audit_request_digest = "0".repeat(64);
      run.counterfactual_checks.push(duplicateCheck);
    }
    run.aggregation.counterfactual_pass_rate = 21 / 22;

    const result = evaluatePromotion(policy, run);
    assert.equal(result.status, "inconclusive");
    assert.ok(result.reason_codes.includes("DUPLICATE_SEMANTIC_CHECK"));
    assert.ok(
      result.reason_codes.includes("COUNTERFACTUAL_PASS_RATE_BELOW_MINIMUM"),
    );
    assert.equal(
      result.metrics.counterfactual_pass_rate.by_judge[
        "actor.audit-judge-01"
      ].pass,
      false,
    );
  });

  await t.test("regressions are thresholded per judge", () => {
    const { policy, run } = inputs();
    run.regression_checks[0].passed = false;
    for (let index = 0; index < 20; index += 1) {
      const duplicateCheck = structuredClone(run.regression_checks[1]);
      duplicateCheck.check_id = `regression.dilution-${index}`;
      duplicateCheck.invocation_id = `invocation.audit.regression.dilution-${index}`;
      duplicateCheck.context_partition = `audit/regression/dilution-${index}`;
      duplicateCheck.seed = computeAuditCheckSeed(
        run.actor_profiles.audit_judges[1].seed,
        "regression_checks",
        duplicateCheck.check_id,
      );
      duplicateCheck.audit_request_digest = "0".repeat(64);
      run.regression_checks.push(duplicateCheck);
    }
    run.aggregation.regression_failure_rate = 1 / 23;

    const result = evaluatePromotion(policy, run);
    assert.equal(result.status, "inconclusive");
    assert.ok(result.reason_codes.includes("DUPLICATE_SEMANTIC_CHECK"));
    assert.ok(
      result.reason_codes.includes("REGRESSION_FAILURE_RATE_EXCEEDED"),
    );
    assert.equal(
      result.metrics.regression_failure_rate.by_judge[
        "actor.audit-judge-01"
      ].pass,
      false,
    );
  });
});

test("challenge raisers must be declared participating judges or critics", () => {
  const { policy, run } = inputs();
  run.challenges[0].raised_by = "actor.ghost-critic";
  const result = evaluatePromotion(policy, run);
  assert.equal(result.status, "inconclusive");
  assert.ok(result.reason_codes.includes("UNKNOWN_CHALLENGE_RAISER"));
});

test("the CLI returns 64 for a structurally invalid canonical record", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-gate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { policy, run } = inputs();
  run.regression_checks = [{}];
  const policyPath = join(directory, "policy.json");
  const runPath = join(directory, "run.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  writeFileSync(runPath, JSON.stringify(run));

  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("scripts/evaluate-promotion.js", root)),
      "--policy",
      policyPath,
      "--run",
      runPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 64);
  assert.match(result.stderr, /schema validation failed/);
});

test("the default safety floor is frozen and canonical policy normalizes", () => {
  assert.ok(Object.isFrozen(DEFAULT_POLICY));
  assert.ok(Object.isFrozen(DEFAULT_POLICY.requirements));
  const normalized = normalizePolicy(policyExample);
  assert.equal(normalized.status, "promoted");
  assert.equal(normalized.requirements.order_swap, true);
  assert.equal(normalized.requirements.candidate_preferred, true);
});

function inputs({ verified = true } = {}) {
  const policy = structuredClone(policyExample);
  const run = structuredClone(runExample);
  delete run.promotion_gate;
  if (verified) {
    policy.provenance.digest_status = "verified";
    run.provenance.digest_status = "verified";
  }
  return { policy, run };
}

function setJudgeOrigin(run, index, value) {
  run.judges[index].origin = structuredClone(value);
  const profile = run.actor_profiles.judges.find(
    (actor) => actor.id === run.judges[index].id,
  );
  profile.origin = structuredClone(value);
}

function origin(model, deployment) {
  return {
    provider: "test-provider",
    model,
    model_version: "2026-08-24",
    deployment,
    endpoint_class: "hosted",
  };
}

function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}
