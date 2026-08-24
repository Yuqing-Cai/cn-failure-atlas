import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  sha256Json,
  sha256Text,
} from "../lib/content-integrity.js";
import {
  collectPromptBundleDescriptors,
  computeAuditCheckSeed,
  computeAuditRequestDigest,
  computeBlindingMappingDigest,
  computeBlindingProtocolDigest,
  computeChallengeRequestDigest,
  computeChallengeResolutionRequestDigest,
  computeEvaluationCaseCommitments,
  computeEvaluationInvocationPlanDigest,
  computeExperimentPlanDigest,
  computeGenerationInputDigest,
  computeJudgeActorSetDigest,
  computePreferenceRequestDigest,
  computeRepairInputDigest,
  computeRepeatInputDigest,
  computeRepeatPlanDigest,
  computeRepeatRunDigest,
  computeVerificationRunAttestationDigest,
  diagnosticPrecommitPayload,
  evaluatePromotion,
  generationPrecommitPayload,
  getLocalSchemaDescriptor,
  promotionRunCompletionPayload,
  promotionRunReceiptPayload,
  validateGateInputSchemas,
  verificationPrecommitPayload,
} from "../lib/evolution-gate.js";
import {
  computeTaxonomyTestExecutionDigest,
  computeTaxonomyTestInputDigest,
} from "../lib/diagnostic-artifact-validator.js";
import { validateMachineArtifacts } from "../lib/machine-artifact-validator.js";
import { inspectUntrustedStructure } from "../lib/untrusted-input.js";
import { REPOSITORY_ROOT } from "../validate.js";

const cliPath = fileURLToPath(
  new URL("../scripts/evaluate-promotion.js", import.meta.url),
);
const taxonomyExample = readJson(join(REPOSITORY_ROOT, "taxonomy.json"));
const symptomById = new Map(
  taxonomyExample.layers.flatMap((layer) =>
    layer.subcategories.flatMap((subcategory) =>
      subcategory.labels.map((label) => [label.id, label]),
    ),
  ),
);
const policyExample = readExample("evolution-policy.example.json");
const traceExample = readExample("diagnostic-trace.example.json");
const repairExample = readExample("repair-attempt.example.json");
const runExample = readExample("verification-run.example.json");
const schemas = loadFiles(join(REPOSITORY_ROOT, "schemas"), ".schema.json");
const {
  publicKey: TEST_PUBLIC_KEY_OBJECT,
  privateKey: TEST_PRIVATE_KEY,
} = generateKeyPairSync("ed25519");
const TEST_PUBLIC_KEY = TEST_PUBLIC_KEY_OBJECT.export({
  type: "spki",
  format: "pem",
});

test("evaluatePromotion requires a complete artifact bundle", () => {
  const { policy, run } = sealedBundle();
  const result = evaluatePromotion(policy, run);

  assert.equal(result.status, "inconclusive");
  assertReason(result, "ARTIFACT_BUNDLE_REQUIRED");
  assert.equal(result.metrics.artifact_bundle.available, false);
});

test("tampering a sealed policy is detected by its scoped policy_digest", () => {
  const bundle = sealedBundle();
  bundle.policy.policy.thresholds.min_evidence_coverage = 0.91;

  const result = evaluateBundle(bundle);
  assert.equal(result.status, "inconclusive");
  assertReason(result, "POLICY_DIGEST_MISMATCH");
  assert.equal(result.metrics.policy_digest.pass, false);
  assert.notEqual(
    result.metrics.policy_digest.computed_digest,
    result.metrics.policy_digest.declared_digest,
  );
});

test("a candidate cannot self-authorize a resealed policy past the pinned trust root", () => {
  const bundle = sealedBundle();
  const pinnedTrustRoot = structuredClone(bundle.trustRoot);
  bundle.policy.policy.thresholds.min_evidence_coverage = 0.91;
  resealBundle(bundle);
  bundle.trustRoot = pinnedTrustRoot;

  const result = evaluateBundle(bundle);
  assert.equal(result.status, "inconclusive");
  assertReason(result, "POLICY_TRUST_ROOT_MISMATCH");
  assert.equal(result.metrics.policy_digest.pass, true);
  assert.equal(result.metrics.policy_trust_root.pass, false);
});

test("malformed trust-root collections fail closed without crashing", async (t) => {
  const cases = [
    ["non-array runner collection", "trusted_runners", {}],
    ["null runner entry", "trusted_runners", [null]],
    ["null prompt entry", "trusted_prompt_bundles", [null]],
    ["null regression-suite entry", "trusted_regression_suites", [null]],
    ["null receipt-key entry", "receipt_public_keys", [null]],
  ];
  for (const [name, field, value] of cases) {
    await t.test(name, () => {
      const bundle = sealedBundle();
      bundle.trustRoot[field] = value;

      let result;
      assert.doesNotThrow(() => {
        result = evaluateBundle(bundle);
      });
      assert.notEqual(result.status, "adopted");
      assertReason(result, "POLICY_TRUST_ROOT_MISMATCH");
    });
  }
  await t.test("null regression-case entry", () => {
    const bundle = sealedBundle();
    bundle.trustRoot.trusted_regression_suites[0].cases = [null];

    let result;
    assert.doesNotThrow(() => {
      result = evaluateBundle(bundle);
    });
    assert.notEqual(result.status, "adopted");
    assertReason(result, "POLICY_TRUST_ROOT_MISMATCH");
    assertReason(result, "UNTRUSTED_REGRESSION_CASE");
  });
});

test("a trust root cannot assign one receipt key id to two keys", () => {
  const bundle = sealedBundle();
  const duplicate = structuredClone(bundle.trustRoot.receipt_public_keys[0]);
  duplicate.issuer_id = "issuer.conflicting-test";
  bundle.trustRoot.receipt_public_keys.push(duplicate);

  const result = evaluateBundle(bundle);
  assert.notEqual(result.status, "adopted");
  assertReason(result, "POLICY_TRUST_ROOT_MISMATCH");
  assert.ok(
    result.metrics.policy_trust_root.issues.includes(
      `duplicate_receipt_key_id:${duplicate.key_id}`,
    ),
  );
});

test("regression suite and case digests remain anchored outside the signed run", async (t) => {
  const attacks = [
    {
      name: "suite digest",
      mutate(check) {
        check.suite_digest = "f".repeat(64);
      },
      expectedIssue: "regression_suite_commitment_mismatch",
    },
    {
      name: "case digest",
      mutate(check) {
        check.case_digest = "e".repeat(64);
      },
      expectedIssue: "regression_case_commitment_mismatch",
    },
  ];

  for (const attack of attacks) {
    await t.test(attack.name, () => {
      const bundle = sealedBundle();
      const pinnedTrustRoot = structuredClone(bundle.trustRoot);
      attack.mutate(bundle.run.regression_checks[0]);
      resealBundle(bundle);
      bundle.trustRoot = pinnedTrustRoot;
      bundle.receipt = makeRunReceipt(bundle);

      const result = evaluateBundle(bundle);
      assert.notEqual(result.status, "adopted");
      assertReason(result, "UNTRUSTED_REGRESSION_CASE");
      assert.equal(result.metrics.artifact_bundle.pass, true);
      assert.equal(result.metrics.run_receipt.pass, true);
      assert.ok(
        result.metrics.regression_registry.issues.some((issue) =>
          issue.startsWith(`${attack.expectedIssue}:`),
        ),
      );
    });
  }
});

test("required registry cases cannot be omitted or downgraded", async (t) => {
  await t.test("a required case cannot disappear from the sealed run", () => {
    const bundle = sealedBundle();
    const pinnedTrustRoot = structuredClone(bundle.trustRoot);
    const unlinkedCheck = bundle.run.regression_checks.find(
      (check) => check.preservation_constraint_ids.length === 0,
    );
    assert.ok(unlinkedCheck);
    const requiredCase = pinnedTrustRoot.trusted_regression_suites
      .flatMap((suite) => suite.cases)
      .find((item) => item.case_id === unlinkedCheck.case_id);
    assert.ok(requiredCase);
    bundle.run.regression_checks = bundle.run.regression_checks.filter(
      (check) => check.case_id !== requiredCase.case_id,
    );
    resealBundle(bundle);
    bundle.trustRoot = pinnedTrustRoot;
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "UNTRUSTED_REGRESSION_CASE");
    assert.equal(result.metrics.artifact_bundle.pass, true);
    assert.equal(result.metrics.run_receipt.pass, true);
    assert.ok(
      result.metrics.regression_registry.issues.some((issue) =>
        issue.startsWith("required_regression_case_missing:"),
      ),
    );
  });

  await t.test("a required case cannot disable its hard veto", () => {
    const bundle = sealedBundle();
    const pinnedTrustRoot = structuredClone(bundle.trustRoot);
    const requiredCheck = bundle.run.regression_checks.find(
      (check) => check.preservation_constraint_ids.length === 0,
    );
    assert.ok(requiredCheck);
    requiredCheck.hard_veto = false;
    resealBundle(bundle);
    bundle.trustRoot = pinnedTrustRoot;
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "UNTRUSTED_REGRESSION_CASE");
    assert.equal(result.metrics.artifact_bundle.pass, true);
    assert.equal(result.metrics.run_receipt.pass, true);
    assert.ok(
      result.metrics.regression_registry.issues.includes(
        `registered_regression_not_hard_veto:${requiredCheck.check_id}`,
      ),
    );
  });
});

test("a frozen evaluation manifest rejects deleted, extra, and duplicate IDs", async (t) => {
  const cases = [
    {
      name: "deleted",
      collection: "evidence_checks",
      mutate(run) {
        run.evidence_checks.pop();
      },
    },
    {
      name: "extra",
      collection: "regression_checks",
      mutate(run) {
        run.regression_checks.push({
          ...structuredClone(run.regression_checks[0]),
          check_id: "regression.uncommitted-extra-001",
          executed_at: "2026-08-24T10:06:24Z",
          preservation_constraint_ids: [],
        });
      },
    },
    {
      name: "duplicate",
      collection: "target_failure_checks",
      mutate(run) {
        run.target_failure_checks[1].check_id =
          run.target_failure_checks[0].check_id;
      },
    },
  ];

  for (const attack of cases) {
    await t.test(attack.name, () => {
      const bundle = sealedBundle();
      attack.mutate(bundle.run);

      const result = evaluateBundle(bundle);
      assert.equal(result.status, "inconclusive");
      assertReason(result, "EVALUATION_MANIFEST_MISMATCH");
      assert.equal(result.metrics.artifact_bundle.pass, true);
      assert.ok(
        result.metrics.evaluation_manifest.issues.includes(
          `${attack.collection}_set_mismatch`,
        ),
      );
    });
  }
});

test("promotion artifact payload, source, and candidate bindings are sealed", async (t) => {
  await t.test("payload digest", () => {
    const bundle = sealedBundle();
    bundle.run.promotion_artifact.payload.hypothesis += " tampered";

    const result = evaluateBundle(bundle);
    assertReason(result, "PROMOTION_ARTIFACT_INVALID");
    assert.equal(result.metrics.artifact_bundle.pass, true);
    assert.ok(
      result.metrics.promotion_artifact.issues.includes(
        "payload_digest_mismatch",
      ),
    );
  });

  await t.test("source digest", () => {
    const bundle = sealedBundle();
    bundle.run.promotion_artifact.source_ref.digest = "0".repeat(64);

    const result = evaluateBundle(bundle);
    assertReason(result, "PROMOTION_ARTIFACT_INVALID");
    assert.equal(result.metrics.artifact_bundle.pass, true);
    assert.ok(
      result.metrics.promotion_artifact.issues.includes(
        "repair_case_source_mismatch",
      ),
    );
  });

  await t.test("candidate digest", () => {
    const bundle = sealedBundle();
    bundle.run.promotion_artifact.payload.candidate_digest = "0".repeat(64);
    bundle.run.promotion_artifact.artifact_digest = sha256Json(
      bundle.run.promotion_artifact.payload,
    );

    const result = evaluateBundle(bundle);
    assertReason(result, "PROMOTION_ARTIFACT_INVALID");
    assert.equal(result.metrics.artifact_bundle.pass, true);
    assert.ok(
      result.metrics.promotion_artifact.issues.includes(
        "repair_case_payload_mismatch",
      ),
    );
    assert.ok(
      !result.metrics.promotion_artifact.issues.includes(
        "payload_digest_mismatch",
      ),
    );
  });
});

test("experiment budgets cannot be exceeded by a consistently resealed bundle", () => {
  const bundle = sealedBundle();
  for (const record of [bundle.trace, bundle.repair, bundle.run]) {
    record.experiment_ledger.budget.candidate_attempts_used =
      record.experiment_ledger.budget.max_candidate_attempts + 1;
  }
  resealBundle(bundle);

  const result = evaluateBundle(bundle);
  assert.equal(result.status, "inconclusive");
  assertReason(result, "EXPERIMENT_LEDGER_INVALID");
  assert.equal(result.metrics.artifact_bundle.pass, true);
  assert.ok(
    result.metrics.experiment_ledger.issues.includes(
      "budget_exceeded_or_inconsistent",
    ),
  );
});

test("experiment ledgers enforce stage-relative candidate attempt counts", () => {
  const bundle = sealedBundle();
  for (const record of [bundle.trace, bundle.repair, bundle.run]) {
    record.experiment_ledger.attempt_index = 1;
    record.experiment_ledger.budget.candidate_attempts_used = 3;
  }
  resealBundle(bundle);

  const result = evaluateBundle(bundle);
  assert.equal(result.status, "inconclusive");
  assertReason(result, "EXPERIMENT_LEDGER_INVALID");
  assert.equal(result.metrics.artifact_bundle.pass, true);
  assert.ok(
    result.metrics.experiment_ledger.issues.includes(
      "budget_exceeded_or_inconsistent",
    ),
  );
  assert.ok(
    result.metrics.experiment_ledger.issues.includes(
      "diagnostic_trace_ledger_mismatch",
    ),
  );
  assert.ok(
    result.metrics.experiment_ledger.issues.includes(
      "repair_attempt_ledger_mismatch",
    ),
  );
});

test("visible model invocations are a hard lower bound on the signed ledger", () => {
  const bundle = sealedBundle();
  const visibleLowerBound =
    bundle.receipt.generation_precommits.length +
    bundle.receipt.diagnostic_precommits.length +
    1 +
    bundle.trace.findings.reduce(
      (count, finding) =>
        count +
        finding.taxonomy_test_results.filter(
          (result) => result.execution && typeof result.execution === "object",
        ).length,
      0,
    );
  assert.equal(
    visibleLowerBound,
    bundle.trace.experiment_ledger.budget.model_calls_used,
    "the baseline must account for the contract-critic call",
  );
  bundle.trace.experiment_ledger.budget.model_calls_used =
    visibleLowerBound - 1;
  resealBundle(bundle);
  bundle.receipt = makeRunReceipt(bundle);

  const result = evaluateBundle(bundle);
  assert.notEqual(result.status, "adopted");
  assertReason(result, "EXPERIMENT_LEDGER_INVALID");
  assert.equal(result.metrics.artifact_bundle.pass, true);
  assert.equal(result.metrics.run_receipt.pass, true);
  assert.ok(
    result.metrics.experiment_ledger.issues.includes(
      "diagnostic_trace_model_call_lower_bound_invalid",
    ),
  );
  assert.equal(
    result.metrics.experiment_ledger.visible_model_call_lower_bounds
      .diagnostic_trace,
    visibleLowerBound,
  );
});

test("model-call ledgers are cumulative across diagnostic, repair, and verification stages", () => {
  const bundle = sealedBundle();
  bundle.trace.experiment_ledger.budget.model_calls_used = 31;
  bundle.repair.experiment_ledger.budget.model_calls_used = 6;
  bundle.run.experiment_ledger.budget.model_calls_used = 31;
  resealBundle(bundle);
  bundle.receipt = makeRunReceipt(bundle);

  const result = evaluateBundle(bundle);
  assert.notEqual(result.status, "adopted");
  assertReason(result, "EXPERIMENT_LEDGER_INVALID");
  assert.equal(result.metrics.artifact_bundle.pass, true);
  assert.equal(result.metrics.run_receipt.pass, true);
  assert.ok(
    result.metrics.experiment_ledger.issues.includes(
      "repair_attempt_model_call_cumulative_invalid",
    ),
  );
});

test("the deterministic aggregation stage is not misreported as a model call", () => {
  const bundle = sealedBundle();
  const visibleLowerBound =
    bundle.repair.experiment_ledger.budget.model_calls_used +
    bundle.run.order_trials.length +
    bundle.run.evidence_checks.length +
    bundle.run.target_failure_checks.length +
    bundle.run.counterfactual_checks.length +
    bundle.run.regression_checks.length +
    bundle.run.challenge_invocations.length;
  assert.equal(
    bundle.run.experiment_ledger.budget.model_calls_used,
    visibleLowerBound,
    "the local deterministic aggregator is not a generative model call",
  );

  const result = evaluateBundle(bundle);
  assert.equal(result.status, "adopted", JSON.stringify(result.reason_codes));
  assert.equal(
    result.metrics.experiment_ledger.visible_model_call_lower_bounds
      .verification_run,
    visibleLowerBound,
  );
});

test("repeat runs must preserve one exact input digest", () => {
  const bundle = sealedBundle();
  bundle.run.repeat_manifest[1].input_digest = "0".repeat(64);

  const result = evaluateBundle(bundle);
  assert.equal(result.status, "inconclusive");
  assertReason(result, "REPEAT_INPUT_MISMATCH");
  assert.equal(result.metrics.artifact_bundle.pass, true);
  assert.equal(result.metrics.repeat_manifest.input_digests_match, false);
});

test("a completed five-stage receipt is mandatory and bound to the frozen run", async (t) => {
  await t.test("missing receipt", () => {
    const bundle = sealedBundle();
    bundle.receipt = null;
    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "RUN_RECEIPT_MISSING");
  });

  await t.test("forged signature", () => {
    const bundle = sealedBundle();
    const signature = bundle.receipt.signature.value;
    bundle.receipt.signature.value = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "RUN_RECEIPT_INVALID");
  });

  await t.test("manifest changed after receipt issuance", () => {
    const bundle = sealedBundle();
    bundle.run.regression_checks[0].protected_behavior =
      "A post-receipt rewrite must invalidate the external commitment.";
    resealBundle(bundle);
    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "RUN_RECEIPT_INVALID");
  });

  await t.test("candidate content changed after completion signature", () => {
    const bundle = sealedBundle();
    bundle.repair.candidates.candidate.content += "（签名后篡改）";
    resealBundle(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "RUN_RECEIPT_INVALID");
  });

  await t.test("synchronized experiment ledgers changed after request signature", () => {
    const bundle = sealedBundle();
    for (const record of [bundle.trace, bundle.repair, bundle.run]) {
      record.experiment_ledger.budget.model_calls_used += 1;
    }
    resealBundle(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "RUN_RECEIPT_INVALID");
  });

  await t.test("trusted-looking provenance cannot bypass a stale completion", () => {
    const bundle = sealedBundle();
    bundle.trace.provenance.runner.commit = "abcdef0";
    resealBundle(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "RUN_RECEIPT_INVALID");
  });
});

test("a post-precommit alias swap cannot flip the blind mapping", () => {
  const bundle = sealedBundle();
  const committedMappingDigest =
    bundle.receipt.verification_precommit.blinding_mapping_digest;
  const baseline = bundle.run.candidates.baseline;
  const candidate = bundle.run.candidates.candidate;
  [baseline.blind_alias, candidate.blind_alias] = [
    candidate.blind_alias,
    baseline.blind_alias,
  ];
  for (const trial of bundle.run.order_trials) {
    if (trial.raw_choice === "A") trial.raw_choice = "B";
    else if (trial.raw_choice === "B") trial.raw_choice = "A";
  }
  resealBundle(bundle);
  assert.notEqual(bundle.run.blinding.mapping_digest, committedMappingDigest);

  Object.assign(bundle.receipt.completion, {
    diagnostic_trace_digest: sha256Json(bundle.trace),
    repair_attempt_digest: sha256Json(bundle.repair),
    verification_run_digest: computeVerificationRunAttestationDigest(
      bundle.run,
    ),
    candidate_digest: bundle.repair.candidates.candidate.digest,
  });
  bundle.receipt.completion.signature = {
    key_id: "key.test.ed25519.v1",
    algorithm: "Ed25519",
    value: signPayload(
      null,
      Buffer.from(
        canonicalJson(promotionRunCompletionPayload(bundle.receipt)),
        "utf8",
      ),
      TEST_PRIVATE_KEY,
    ).toString("base64"),
  };

  const result = evaluateBundle(bundle);
  assert.notEqual(result.status, "adopted");
  assertReason(result, "RUN_RECEIPT_INVALID");
  assert.ok(
    result.metrics.run_receipt.issues.includes(
      "verification_precommit_binding_invalid",
    ),
  );
  assert.ok(
    !result.metrics.run_receipt.issues.includes(
      "completion_signature_invalid",
    ),
  );
});

test("order trials require fresh contexts and deterministically derived seeds", async (t) => {
  await t.test("two trials cannot reuse one context partition", () => {
    const bundle = sealedBundle();
    bundle.run.order_trials[1].context_partition =
      bundle.run.order_trials[0].context_partition;
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "TRIAL_CONTEXT_ISOLATION_INVALID");
    assert.ok(
      result.metrics.order_swap.duplicate_context_partitions.length > 0,
    );
  });

  await t.test("a trial seed cannot diverge from its frozen derivation", () => {
    const bundle = sealedBundle();
    bundle.run.order_trials[0].seed =
      (bundle.run.order_trials[0].seed + 1) >>> 0;
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "TRIAL_CONTEXT_ISOLATION_INVALID");
    assert.deepEqual(result.metrics.order_swap.seed_mismatches, [
      bundle.run.order_trials[0].trial_id,
    ]);
  });
});

test("order trials cannot alias any other explicit invocation or actor context", async (t) => {
  const attacks = [
    {
      name: "challenge invocation ID",
      field: "invocation_id",
      select(bundle) {
        return bundle.run.challenge_invocations[0].invocation_id;
      },
      metric: "duplicate_invocation_ids",
    },
    {
      name: "challenge invocation seed",
      field: "seed",
      select(bundle) {
        return bundle.run.challenge_invocations[0].seed;
      },
      metric: "duplicate_trial_seeds",
    },
    {
      name: "challenge invocation context",
      field: "context_partition",
      select(bundle) {
        return bundle.run.challenge_invocations[0].context_partition;
      },
      metric: "duplicate_context_partitions",
    },
    {
      name: "run actor-profile context",
      field: "context_partition",
      select(bundle) {
        return bundle.run.actor_profiles.generator.context_partition;
      },
      metric: "duplicate_context_partitions",
    },
    {
      name: "diagnostic upstream context",
      field: "context_partition",
      select(bundle) {
        return bundle.trace.actors.contract_critic.context_partition;
      },
      metric: "duplicate_context_partitions",
    },
    {
      name: "repair upstream context",
      field: "context_partition",
      select(bundle) {
        return bundle.repair.actors.critic.context_partition;
      },
      metric: "duplicate_context_partitions",
    },
  ];
  for (const attack of attacks) {
    await t.test(attack.name, () => {
      const bundle = sealedBundle();
      const reusedValue = attack.select(bundle);
      bundle.run.order_trials[0][attack.field] = reusedValue;
      resealBundle(bundle);
      bundle.receipt = makeRunReceipt(bundle);

      const result = evaluateBundle(bundle);
      assert.notEqual(result.status, "adopted");
      assertReason(result, "TRIAL_CONTEXT_ISOLATION_INVALID");
      const expectedValue =
        attack.field === "context_partition"
          ? reusedValue.normalize("NFKC").trim().toLocaleLowerCase("en-US")
          : reusedValue;
      assert.ok(result.metrics.order_swap[attack.metric].includes(expectedValue));
      assert.equal(result.metrics.artifact_bundle.pass, true);
      assert.equal(result.metrics.run_receipt.pass, true);
    });
  }
});

test("audit invocations cannot reuse any execution identity", async (t) => {
  const contextAttacks = [
    {
      name: "preference trial context",
      select(bundle) {
        return bundle.run.order_trials[0].context_partition;
      },
    },
    {
      name: "challenge invocation context",
      select(bundle) {
        return bundle.run.challenge_invocations[0].context_partition;
      },
    },
    {
      name: "run actor-profile context",
      select(bundle) {
        const check = bundle.run.evidence_checks[0];
        return bundle.run.actor_profiles.audit_judges.find(
          (actor) => actor.id === check.judge_id,
        ).context_partition;
      },
    },
    {
      name: "diagnostic upstream context",
      select(bundle) {
        return bundle.trace.actors.critic.context_partition;
      },
    },
    {
      name: "repair upstream context",
      select(bundle) {
        return bundle.repair.actors.critic.context_partition;
      },
    },
  ];
  for (const attack of contextAttacks) {
    await t.test(attack.name, () => {
      const bundle = sealedBundle();
      const reusedContext = attack.select(bundle);
      bundle.run.evidence_checks[0].context_partition = reusedContext;
      resealBundle(bundle, { preserveAuditInvocationPlan: true });
      bundle.receipt = makeRunReceipt(bundle);

      const result = evaluateBundle(bundle);
      assert.notEqual(result.status, "adopted");
      assertReason(result, "AUDIT_REQUEST_BINDING_INVALID");
      assert.ok(
        result.metrics.check_references.duplicate_context_partitions.includes(
          reusedContext.normalize("NFKC").trim().toLocaleLowerCase("en-US"),
        ),
      );
      assert.equal(result.metrics.artifact_bundle.pass, true);
      assert.equal(result.metrics.run_receipt.pass, true);
    });
  }

  const invocationIdAttacks = [
    {
      name: "preference invocation ID",
      select(bundle) {
        return bundle.run.order_trials[0].invocation_id;
      },
    },
    {
      name: "challenge invocation ID",
      select(bundle) {
        return bundle.run.challenge_invocations[0].invocation_id;
      },
    },
  ];
  for (const attack of invocationIdAttacks) {
    await t.test(attack.name, () => {
      const bundle = sealedBundle();
      const reusedInvocationId = attack.select(bundle);
      bundle.run.evidence_checks[0].invocation_id = reusedInvocationId;
      resealBundle(bundle, { preserveAuditInvocationPlan: true });
      bundle.receipt = makeRunReceipt(bundle);

      const result = evaluateBundle(bundle);
      assert.notEqual(result.status, "adopted");
      assertReason(result, "AUDIT_REQUEST_BINDING_INVALID");
      assert.ok(
        result.metrics.check_references.duplicate_invocation_ids.includes(
          reusedInvocationId,
        ),
      );
      assert.equal(result.metrics.artifact_bundle.pass, true);
      assert.equal(result.metrics.run_receipt.pass, true);
    });
  }

  await t.test("challenge invocation seed", () => {
    const bundle = sealedBundle();
    const reusedSeed = bundle.run.challenge_invocations[0].seed;
    bundle.run.evidence_checks[0].seed = reusedSeed;
    resealBundle(bundle, { preserveAuditInvocationPlan: true });
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "AUDIT_REQUEST_BINDING_INVALID");
    assert.ok(
      result.metrics.check_references.duplicate_invocation_seeds.includes(
        reusedSeed,
      ),
    );
    assert.equal(result.metrics.artifact_bundle.pass, true);
    assert.equal(result.metrics.run_receipt.pass, true);
  });
});

test("record-local actor isolation and baseline generator identity are enforced", async (t) => {
  await t.test("ghost actor pairs are invalid", () => {
    const bundle = sealedBundle();
    bundle.trace.identity_isolation.pairs[0].right_actor_id = "actor.ghost";
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = validateArtifactBundle(bundle);
    assert.ok(
      result.errors.some((error) =>
        error.message.includes("identity_isolation 含无效或重复 actor pair"),
      ),
      JSON.stringify(result.errors, null, 2),
    );
    const gateResult = evaluateBundle(bundle);
    assert.notEqual(gateResult.status, "adopted");
    assertReason(gateResult, "ARTIFACT_BUNDLE_INVALID");
  });

  await t.test("two trace roles cannot alias one actor id", () => {
    const bundle = sealedBundle();
    const oldContractCriticId = bundle.trace.actors.contract_critic.id;
    const criticId = bundle.trace.actors.critic.id;
    bundle.trace.actors.contract_critic.id = criticId;
    for (const contract of [
      bundle.trace.scene_contract,
      ...bundle.trace.subject.scenes.map((scene) => scene.contract),
    ]) {
      for (const grounding of contract.grounding ?? []) {
        if (grounding.validated_by_actor_id === oldContractCriticId) {
          grounding.validated_by_actor_id = criticId;
        }
      }
    }
    for (const pair of bundle.trace.identity_isolation.pairs) {
      if (pair.left_actor_id === oldContractCriticId) {
        pair.left_actor_id = criticId;
      }
      if (pair.right_actor_id === oldContractCriticId) {
        pair.right_actor_id = criticId;
      }
    }
    const observedPairs = new Set();
    bundle.trace.identity_isolation.pairs =
      bundle.trace.identity_isolation.pairs.filter((pair) => {
        const key = [pair.left_actor_id, pair.right_actor_id].sort().join("<->");
        if (observedPairs.has(key)) return false;
        observedPairs.add(key);
        return true;
      });
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("record_actor_id_duplicate"),
      ),
    );
  });

  await t.test("renaming a cloned critic does not create isolation", () => {
    const bundle = sealedBundle();
    const criticId = bundle.trace.actors.critic.id;
    bundle.trace.actors.critic = {
      ...structuredClone(bundle.trace.actors.generator),
      id: criticId,
      role: "critic",
    };
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("record_identity_isolation_invalid"),
      ),
    );
  });

  for (const sourceRole of ["critic", "test_judge"]) {
    await t.test(
      `a contract critic cannot reuse the ${sourceRole} execution context`,
      () => {
        const bundle = sealedBundle();
        const contractCritic = bundle.trace.actors.contract_critic;
        const sourceActor = bundle.trace.actors[sourceRole];
        bundle.trace.actors.contract_critic = {
          ...structuredClone(sourceActor),
          id: contractCritic.id,
          role: "contract_critic",
        };
        resealBundle(bundle);
        bundle.receipt = makeRunReceipt(bundle);

        const result = evaluateBundle(bundle);
        assert.notEqual(result.status, "adopted");
        assertReason(result, "ARTIFACT_BUNDLE_INVALID");
        assert.ok(
          result.metrics.artifact_bundle.issues.some((item) =>
            item.includes("record_identity_isolation_invalid"),
          ),
          JSON.stringify(result.metrics.artifact_bundle.issues, null, 2),
        );
      },
    );
  }

  await t.test("repair baseline generator must preserve trace identity", () => {
    const bundle = sealedBundle();
    bundle.repair.actors.baseline_generator.origin.model = "impostor-model";
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = validateArtifactBundle(bundle);
    assert.ok(
      result.errors.some((error) =>
        error.message.includes("baseline_generator 必须与 diagnostic_trace.generator 完全一致"),
      ),
      JSON.stringify(result.errors, null, 2),
    );
    const gateResult = evaluateBundle(bundle);
    assert.notEqual(gateResult.status, "adopted");
    assertReason(gateResult, "ARTIFACT_BUNDLE_INVALID");
  });

  await t.test("verification generator must preserve repair identity", () => {
    const bundle = sealedBundle();
    bundle.repair.actors.repair_generator.origin.model = "impostor-repairer";
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const gateResult = evaluateBundle(bundle);
    assert.notEqual(gateResult.status, "adopted");
    assertReason(gateResult, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      gateResult.metrics.artifact_bundle.issues.some((item) =>
        item.includes("repair_generator_identity_mismatch"),
      ),
    );
  });

  await t.test("candidate producer roles cannot be swapped", () => {
    const bundle = sealedBundle();
    bundle.repair.candidates.candidate.producer_actor_id =
      bundle.repair.actors.critic.id;
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = validateArtifactBundle(bundle);
    assert.ok(
      result.errors.some((error) =>
        error.message.includes("candidate 必须由声明的 repair_generator 产生"),
      ),
      JSON.stringify(result.errors, null, 2),
    );
    const gateResult = evaluateBundle(bundle);
    assert.notEqual(gateResult.status, "adopted");
    assertReason(gateResult, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      gateResult.metrics.artifact_bundle.issues.some((item) =>
        item.includes("candidate_producer_role_mismatch"),
      ),
    );
  });
});

test("critic unresolved challenges survive the verification handoff", async (t) => {
  await t.test("an inherited challenge cannot be replaced by an unrelated one", () => {
    const bundle = sealedBundle();
    bundle.run.challenges[0] = {
      ...bundle.run.challenges[0],
      challenge_id: "challenge.unrelated-001",
      severity: "informational",
      claim: "Unrelated low-cost observation.",
    };
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("critic_challenge_handoff_missing"),
      ),
    );
  });

  await t.test("an inherited challenge cannot be silently softened", () => {
    const bundle = sealedBundle();
    bundle.run.challenges[0].severity = "informational";
    bundle.run.challenges[0].claim = "Softened after the repair critic handoff.";
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("critic_challenge_handoff_metadata_mismatch"),
      ),
    );
  });
});

test("verification cannot launder upstream actors into independent roles", async (t) => {
  await t.test("a diagnostic actor cannot be renamed as a preference judge", () => {
    const bundle = sealedBundle();
    const oldJudgeId = bundle.run.actor_profiles.judges[0].id;
    const upstreamActor = bundle.trace.actors.test_judge;
    bundle.run.actor_profiles.judges[0] = {
      ...structuredClone(upstreamActor),
      role: "judge",
    };
    bundle.run.judges[0] = {
      id: upstreamActor.id,
      origin: structuredClone(upstreamActor.origin),
    };
    for (const trial of bundle.run.order_trials) {
      if (trial.judge_id === oldJudgeId) trial.judge_id = upstreamActor.id;
    }
    for (const pair of bundle.run.identity_isolation.pairs) {
      if (pair.left_actor_id === oldJudgeId) {
        pair.left_actor_id = upstreamActor.id;
        pair.mechanisms = [
          "separate_context",
          "separate_prompt",
          "fresh_seed",
          "no_shared_scratchpad",
        ];
      }
      if (pair.right_actor_id === oldJudgeId) {
        pair.right_actor_id = upstreamActor.id;
        pair.mechanisms = [
          "separate_context",
          "separate_prompt",
          "fresh_seed",
          "no_shared_scratchpad",
        ];
      }
    }
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("preference_judge_upstream_actor_reuse"),
      ),
    );
  });

  await t.test("a diagnostic actor cannot be renamed as an audit judge", () => {
    const bundle = sealedBundle();
    const oldJudgeId = bundle.run.actor_profiles.audit_judges[0].id;
    const upstreamActor = bundle.trace.actors.test_judge;
    bundle.run.actor_profiles.audit_judges[0] = {
      ...structuredClone(upstreamActor),
      role: "judge",
    };
    for (const checks of [
      bundle.run.evidence_checks,
      bundle.run.target_failure_checks,
      bundle.run.counterfactual_checks,
      bundle.run.regression_checks,
    ]) {
      for (const check of checks) {
        if (check.judge_id === oldJudgeId) check.judge_id = upstreamActor.id;
      }
    }
    for (const pair of bundle.run.identity_isolation.pairs) {
      if (pair.left_actor_id === oldJudgeId) {
        pair.left_actor_id = upstreamActor.id;
        pair.mechanisms = [
          "separate_context",
          "separate_prompt",
          "fresh_seed",
          "no_shared_scratchpad",
        ];
      }
      if (pair.right_actor_id === oldJudgeId) {
        pair.right_actor_id = upstreamActor.id;
        pair.mechanisms = [
          "separate_context",
          "separate_prompt",
          "fresh_seed",
          "no_shared_scratchpad",
        ];
      }
    }
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("audit_judge_upstream_actor_reuse"),
      ),
    );
  });

  await t.test("a decoy run critic cannot replace the repair critic", () => {
    const bundle = sealedBundle();
    const repairCriticId = bundle.repair.actors.critic.id;
    const runCritic = bundle.run.actor_profiles.critics.find(
      (critic) => critic.id === repairCriticId,
    );
    assert.ok(runCritic);
    const decoyCriticId = "actor.critic-decoy-01";
    runCritic.id = decoyCriticId;
    for (const pair of bundle.run.identity_isolation.pairs) {
      if (pair.left_actor_id === repairCriticId) {
        pair.left_actor_id = decoyCriticId;
      }
      if (pair.right_actor_id === repairCriticId) {
        pair.right_actor_id = decoyCriticId;
      }
    }
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("repair_critic_verification_handoff_missing"),
      ),
    );
  });
});

test("claimed judge-to-aggregator separation must match the actor profiles", () => {
  const bundle = sealedBundle();
  const secondJudge = bundle.run.actor_profiles.judges[1];
  const aggregator = bundle.run.actor_profiles.aggregator;
  secondJudge.prompt = structuredClone(aggregator.prompt);
  secondJudge.context_partition = aggregator.context_partition;
  secondJudge.seed = aggregator.seed;
  secondJudge.temperature = aggregator.temperature;
  resealBundle(bundle);
  bundle.receipt = makeRunReceipt(bundle);

  const result = evaluateBundle(bundle);
  assert.notEqual(result.status, "adopted");
  assertReason(result, "IDENTITY_ISOLATION_INVALID");
  assert.ok(result.metrics.identity_isolation.invalid_pairs.length > 0);
});

test("verification roles cannot collapse behind one actor id", () => {
  const bundle = sealedBundle();
  const generatorId = bundle.run.actor_profiles.generator.id;
  const oldAggregatorId = bundle.run.actor_profiles.aggregator.id;
  bundle.run.actor_profiles.aggregator.id = generatorId;
  bundle.run.aggregation.aggregator_id = generatorId;
  for (const pair of bundle.run.identity_isolation.pairs) {
    if (pair.left_actor_id === oldAggregatorId) pair.left_actor_id = generatorId;
    if (pair.right_actor_id === oldAggregatorId) pair.right_actor_id = generatorId;
  }
  const observedPairs = new Set();
  bundle.run.identity_isolation.pairs =
    bundle.run.identity_isolation.pairs.filter((pair) => {
      const key = [pair.left_actor_id, pair.right_actor_id].sort().join("<->");
      if (observedPairs.has(key)) return false;
      observedPairs.add(key);
      return true;
    });
  resealBundle(bundle);
  bundle.receipt = makeRunReceipt(bundle);

  const result = evaluateBundle(bundle);
  assert.notEqual(result.status, "adopted");
  assertReason(result, "ACTOR_PROFILE_MISMATCH");
  assert.deepEqual(result.metrics.actor_profiles.duplicate_profile_ids, [
    generatorId,
  ]);
});

test("direct Gate enforces the signed repair-chain handoff", async (t) => {
  await t.test("repair generator cannot sign its own critic approval", () => {
    const bundle = sealedBundle();
    bundle.repair.critic_check.critic_id =
      bundle.repair.actors.repair_generator.id;
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const validation = validateArtifactBundle(bundle);
    assert.ok(
      validation.errors.some((error) =>
        error.message.includes("critic_check.critic_id 必须精确引用声明的 critic"),
      ),
      JSON.stringify(validation.errors, null, 2),
    );
    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("critic_check_actor_mismatch"),
      ),
    );
  });

  await t.test("critic must explicitly approve the blind handoff", () => {
    const bundle = sealedBundle();
    bundle.repair.critic_check.ready_for_blind_verification = false;
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("critic_check_not_ready"),
      ),
    );
  });

  await t.test("critic cannot approve while reporting a new present failure", () => {
    const bundle = sealedBundle();
    bundle.repair.critic_check.new_failure_scan[0].status = "present";
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("critic_check_new_failure_present"),
      ),
    );
  });

  await t.test("handoff cannot name a different blinding protocol", () => {
    const bundle = sealedBundle();
    bundle.repair.verification_handoff.blinding_protocol_digest = "a".repeat(64);
    resealBundle(bundle, { preserveBlindingProtocolDigest: true });
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("blinding_protocol_handoff_mismatch"),
      ),
    );
  });

  await t.test("repair edit cannot cite refuting evidence", () => {
    const bundle = sealedBundle();
    bundle.repair.repair_plan.edits[0].source_evidence_ids = [
      "evidence.closure-counter-001",
    ];
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("repair_edit_non_supporting_evidence"),
      ),
    );
  });

  await t.test("repair target must remain a present symptom", () => {
    const bundle = sealedBundle();
    bundle.trace.findings[0].status = "uncertain";
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("repair_target_not_present_symptom"),
      ),
    );
  });

  await t.test("a preservation constraint cannot borrow an unrelated pass", () => {
    const bundle = sealedBundle();
    const constraint =
      bundle.repair.repair_plan.preservation_contract[0];
    const unrelatedCheck = bundle.run.regression_checks.find(
      (check) => check.preservation_constraint_ids.length === 0,
    );
    assert.ok(unrelatedCheck);
    constraint.verification_check_ids = [unrelatedCheck.check_id];
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("preservation_contract_check_invalid"),
      ),
    );
  });
});

test("direct Gate evidence coverage requires owned supporting evidence", async (t) => {
  await t.test("refuting evidence cannot count as covered", () => {
    const bundle = sealedBundle();
    bundle.run.evidence_checks[0].evidence_ids = [
      "evidence.closure-counter-001",
    ];
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("evidence_check_non_supporting_evidence"),
      ),
    );
  });

  await t.test("another finding's supporting evidence cannot be borrowed", () => {
    const bundle = sealedBundle();
    const foreignFinding = structuredClone(bundle.trace.findings[0]);
    foreignFinding.finding_id = "finding.foreign-evidence-001";
    foreignFinding.status = "absent";
    delete foreignFinding.taxonomy_test_results;
    delete foreignFinding.neighboring_label_rebuttals;
    for (const evidence of foreignFinding.evidence) {
      evidence.evidence_id = `${evidence.evidence_id}.foreign`;
    }
    bundle.trace.findings.push(foreignFinding);
    bundle.run.evidence_checks[0].evidence_ids = [
      "evidence.closure-001.foreign",
    ];
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("evidence_check_finding_mismatch"),
      ),
    );
  });

  await t.test("every supporting span on the target turn must be checked", () => {
    const bundle = sealedBundle();
    const targetFinding = bundle.trace.findings.find((finding) =>
      bundle.repair.target_finding_ids.includes(finding.finding_id),
    );
    const targetTurn = bundle.trace.subject.turns.find(
      (turn) => turn.turn_id === bundle.repair.target_turn_id,
    );
    const originalSupport = targetFinding.evidence.find(
      (evidence) =>
        evidence.stance === "supports" &&
        evidence.turn_id === bundle.repair.target_turn_id,
    );
    assert.ok(targetFinding && targetTurn && originalSupport);
    const codepoints = [...targetTurn.content];
    const originalEnd = originalSupport.span.end;
    const splitAt = Math.floor(
      (originalSupport.span.start + originalEnd) / 2,
    );
    const secondSupport = {
      ...structuredClone(originalSupport),
      evidence_id: "evidence.closure-002",
      span: {
        start: splitAt,
        end: originalEnd,
        unit: "unicode_codepoint",
      },
      quote: codepoints.slice(splitAt, originalEnd).join(""),
      rationale:
        "The second half independently identifies the target-turn closure claim.",
    };
    originalSupport.span.end = splitAt;
    originalSupport.quote = codepoints
      .slice(originalSupport.span.start, splitAt)
      .join("");
    targetFinding.evidence.push(secondSupport);
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.equal(result.metrics.run_receipt.pass, true);
    assert.ok(
      result.metrics.artifact_bundle.issues.some((item) =>
        item.includes("evidence_check_support_set_mismatch"),
      ),
    );
  });
});

test("a target failure cannot remain present behind a reduced-evidence claim", () => {
  const bundle = sealedBundle();
  for (const check of bundle.run.target_failure_checks) {
    check.candidate_present = true;
    check.evidence_reduced = true;
  }
  resealBundle(bundle);
  bundle.receipt = makeRunReceipt(bundle);

  const result = evaluateBundle(bundle);
  assert.notEqual(
    result.status,
    "adopted",
    "candidate_present=true must veto adoption even when the same judge claims evidence_reduced=true",
  );
  assertReason(result, "TARGET_FAILURE_PERSISTS");
  assert.deepEqual(
    result.metrics.target_failure_reduction.failure_persists,
    bundle.run.target_failure_checks.map((check) => check.check_id).sort(),
  );
});

test("an empty challenge round cannot discard a repair critic challenge", () => {
  const bundle = sealedBundle();
  bundle.run.challenges = [];
  resealBundle(bundle);
  bundle.receipt = makeRunReceipt(bundle);

  const result = evaluateBundle(bundle);
  assert.equal(result.status, "inconclusive");
  assertReason(result, "ARTIFACT_BUNDLE_INVALID");
  assert.equal(result.metrics.artifact_bundle.pass, false);
  assert.ok(
    result.metrics.artifact_bundle.issues.some((item) =>
      item.includes("critic_challenge_handoff_missing"),
    ),
  );
  assert.equal(result.metrics.run_receipt.pass, true);
  assert.equal(result.metrics.evaluation_manifest.pass, true);
  assert.equal(result.metrics.challenge_round.completed, true);
  assert.equal(result.metrics.challenge_round.pass, true);
  assert.equal(result.metrics.challenge_round.challenges_observed, 0);
});

test("challenge resolution requires an exact resolver invocation", async (t) => {
  await t.test("the resolver invocation cannot be deleted", () => {
    const bundle = sealedBundle();
    const challenge = bundle.run.challenges.find((item) => item.resolved);
    bundle.run.challenge_invocations = bundle.run.challenge_invocations.filter(
      (invocation) => invocation.actor_id !== challenge.resolved_by,
    );
    resealBundle(bundle, { preserveChallengeInvocations: true });
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "CHALLENGE_INVOCATION_INVALID");
    assert.ok(
      result.metrics.challenge_round.issues.includes(
        `challenge_resolution_unsubstantiated:${challenge.challenge_id}`,
      ),
    );
    assert.equal(result.metrics.run_receipt.pass, true);
  });

  await t.test("a different audit actor cannot claim the resolution", () => {
    const bundle = sealedBundle();
    const challenge = bundle.run.challenges.find((item) => item.resolved);
    const resolverInvocation = bundle.run.challenge_invocations.find(
      (invocation) =>
        invocation.resolved_challenge_ids.includes(challenge.challenge_id),
    );
    const wrongActor = bundle.run.actor_profiles.audit_judges.find(
      (actor) => actor.id !== challenge.resolved_by,
    );
    Object.assign(resolverInvocation, {
      actor_id: wrongActor.id,
      context_partition: wrongActor.context_partition,
      seed: wrongActor.seed,
    });
    resealBundle(bundle, { preserveChallengeInvocations: true });
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "CHALLENGE_INVOCATION_INVALID");
    assert.ok(
      result.metrics.challenge_round.issues.includes(
        `challenge_resolver_mismatch:${challenge.challenge_id}`,
      ),
    );
    assert.equal(result.metrics.run_receipt.pass, true);
  });

  await t.test("the resolver invocation cannot replace the challenge ID", () => {
    const bundle = sealedBundle();
    const challenge = bundle.run.challenges.find((item) => item.resolved);
    const resolverInvocation = bundle.run.challenge_invocations.find(
      (invocation) =>
        invocation.resolved_challenge_ids.includes(challenge.challenge_id),
    );
    resolverInvocation.resolved_challenge_ids = ["challenge.unrelated-001"];
    resealBundle(bundle, { preserveChallengeInvocations: true });
    bundle.receipt = makeRunReceipt(bundle);
    assert.equal(
      validateGateInputSchemas(bundle.policy, bundle.run).valid,
      true,
      "the attack must remain schema-valid and reach challenge semantics",
    );

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "CHALLENGE_INVOCATION_INVALID");
    assert.ok(
      result.metrics.challenge_round.issues.includes(
        `challenge_resolution_unsubstantiated:${challenge.challenge_id}`,
      ),
    );
    assert.equal(result.metrics.run_receipt.pass, true);
  });
});

test("challenge invocations cannot reuse another challenge execution identity", async (t) => {
  for (const attack of [
    {
      name: "context partition",
      field: "context_partition",
      issuePrefix: "global_duplicate_context_partition:",
    },
    {
      name: "explicit seed",
      field: "seed",
      issuePrefix: "global_duplicate_invocation_seed:",
    },
  ]) {
    await t.test(attack.name, () => {
      const bundle = sealedBundle();
      assert.ok(bundle.run.challenge_invocations.length >= 2);
      const reusedValue = bundle.run.challenge_invocations[0][attack.field];
      bundle.run.challenge_invocations[1][attack.field] = reusedValue;
      resealBundle(bundle, { preserveChallengeInvocations: true });
      bundle.receipt = makeRunReceipt(bundle);

      const result = evaluateBundle(bundle);
      assert.notEqual(result.status, "adopted");
      assertReason(result, "CHALLENGE_INVOCATION_INVALID");
      const expectedValue =
        attack.field === "context_partition"
          ? reusedValue.normalize("NFKC").trim().toLocaleLowerCase("en-US")
          : reusedValue;
      assert.ok(
        result.metrics.challenge_round.issues.includes(
          `${attack.issuePrefix}${expectedValue}`,
        ),
        JSON.stringify(result.metrics.challenge_round.issues, null, 2),
      );
      assert.equal(result.metrics.artifact_bundle.pass, true);
      assert.equal(result.metrics.run_receipt.pass, true);
    });
  }
});

test("challenge requests and type-specific resolution evidence are bound", async (t) => {
  await t.test("a raiser request digest cannot be forged", () => {
    const bundle = sealedBundle();
    const raiser = bundle.run.challenge_invocations.find(
      (invocation) => invocation.invocation_kind === "challenge_raiser",
    );
    raiser.challenge_request_digest = "0".repeat(64);
    resealBundle(bundle, {
      preserveChallengeInvocations: true,
      preserveChallengeRequestDigests: true,
    });
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "CHALLENGE_INVOCATION_INVALID");
    assert.ok(
      result.metrics.challenge_round.issues.includes(
        `challenge_request_binding_invalid:${raiser.invocation_id}`,
      ),
    );
    assert.equal(result.metrics.artifact_bundle.pass, true);
    assert.equal(result.metrics.run_receipt.pass, true);
  });

  await t.test("a resolver request digest cannot be forged", () => {
    const bundle = sealedBundle();
    const resolver = bundle.run.challenge_invocations.find(
      (invocation) => invocation.invocation_kind === "challenge_resolver",
    );
    resolver.resolution_request_digest = "f".repeat(64);
    resealBundle(bundle, {
      preserveChallengeInvocations: true,
      preserveChallengeRequestDigests: true,
    });
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "CHALLENGE_INVOCATION_INVALID");
    assert.ok(
      result.metrics.challenge_round.issues.includes(
        `resolution_request_binding_invalid:${resolver.invocation_id}`,
      ),
    );
    assert.equal(result.metrics.artifact_bundle.pass, true);
    assert.equal(result.metrics.run_receipt.pass, true);
  });

  await t.test("an unrelated check type cannot resolve a blocking challenge", () => {
    const bundle = sealedBundle();
    const challenge = bundle.run.challenges.find((item) => item.resolved);
    assert.equal(
      challenge.challenge_kind,
      "diagnostic_counterfactual_invalid",
    );
    const unrelatedCheck = bundle.run.target_failure_checks.find(
      (check) =>
        check.judge_id === challenge.resolved_by &&
        challenge.target_finding_ids.includes(check.finding_id),
    );
    assert.ok(unrelatedCheck);
    challenge.resolution_check_ids = [unrelatedCheck.check_id];
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "CHALLENGE_INVOCATION_INVALID");
    assert.ok(
      result.metrics.challenge_round.issues.includes(
        `challenge_resolution_unsubstantiated:${challenge.challenge_id}`,
      ),
    );
    assert.equal(result.metrics.artifact_bundle.pass, true);
    assert.equal(result.metrics.run_receipt.pass, true);
  });

  for (const attack of [
    {
      name: "an extra same-type check cannot be added to the frozen resolution set",
      mutate(challenge, alternativeCheckId) {
        challenge.resolution_check_ids = [
          ...challenge.required_resolution_check_ids,
          alternativeCheckId,
        ];
      },
    },
    {
      name: "a required check cannot be replaced by another same-type check",
      mutate(challenge, alternativeCheckId) {
        challenge.resolution_check_ids = [alternativeCheckId];
      },
    },
  ]) {
    await t.test(attack.name, () => {
      const bundle = sealedBundle();
      const challenge = bundle.run.challenges.find((item) => item.resolved);
      const alternativeCheck = bundle.run.counterfactual_checks.find(
        (check) =>
          !challenge.required_resolution_check_ids.includes(check.check_id),
      );
      assert.ok(alternativeCheck);
      attack.mutate(challenge, alternativeCheck.check_id);
      resealBundle(bundle);
      bundle.receipt = makeRunReceipt(bundle);

      const result = evaluateBundle(bundle);
      assert.notEqual(result.status, "adopted");
      assertReason(result, "CHALLENGE_INVOCATION_INVALID");
      assert.ok(
        result.metrics.challenge_round.issues.includes(
          `challenge_resolution_unsubstantiated:${challenge.challenge_id}`,
        ),
      );
      assert.equal(result.metrics.artifact_bundle.pass, true);
      assert.equal(result.metrics.run_receipt.pass, true);
    });
  }

  await t.test("challenge response remains resolver output, not request input", () => {
    const bundle = sealedBundle();
    const challenge = bundle.run.challenges.find((item) => item.resolved);
    const resolver = bundle.run.challenge_invocations.find(
      (invocation) => invocation.invocation_kind === "challenge_resolver",
    );
    const requestDigestBefore = resolver.resolution_request_digest;
    challenge.response += " The resolver records an expanded signed response.";
    const requestDigestAfter = computeChallengeResolutionRequestDigest(
      bundle.run,
      resolver,
      {
        diagnostic_trace: bundle.trace,
        repair_attempt: bundle.repair,
      },
    );
    assert.equal(requestDigestAfter, requestDigestBefore);
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.equal(
      result.status,
      "adopted",
      JSON.stringify(result.reason_codes, null, 2),
    );
    const resealedResolver = bundle.run.challenge_invocations.find(
      (invocation) => invocation.invocation_kind === "challenge_resolver",
    );
    assert.equal(
      resealedResolver.resolution_request_digest,
      requestDigestBefore,
    );
    assert.equal(result.metrics.run_receipt.pass, true);
  });

  await t.test("a check executed before the challenge cannot resolve it", () => {
    const bundle = sealedBundle();
    const challenge = bundle.run.challenges.find((item) => item.resolved);
    const resolutionCheck = [
      ...bundle.run.evidence_checks,
      ...bundle.run.target_failure_checks,
      ...bundle.run.counterfactual_checks,
      ...bundle.run.regression_checks,
    ].find((check) => challenge.resolution_check_ids.includes(check.check_id));
    assert.ok(resolutionCheck);
    resolutionCheck.executed_at = "2026-08-24T10:05:35Z";
    resealBundle(bundle, {
      preserveChallengeInvocations: true,
      preserveVerificationExecutionTimes: true,
    });
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "CHALLENGE_INVOCATION_INVALID");
    assert.ok(
      result.metrics.challenge_round.issues.includes(
        `challenge_resolution_unsubstantiated:${challenge.challenge_id}`,
      ),
    );
    assert.equal(result.metrics.artifact_bundle.pass, true);
    assert.equal(result.metrics.run_receipt.pass, true);
  });

  await t.test("the repair critic cannot be replaced as challenge raiser", () => {
    const bundle = sealedBundle();
    const challenge = bundle.run.challenges.find((item) => item.resolved);
    challenge.raised_by = bundle.run.actor_profiles.audit_judges[0].id;
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.some((issue) =>
        issue.includes("critic_challenge_handoff_metadata_mismatch"),
      ),
      JSON.stringify(result.metrics.artifact_bundle.issues, null, 2),
    );
    assert.equal(result.metrics.run_receipt.pass, true);
  });
});

test("the CLI adopts a full sealed bundle but never a two-file invocation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-full-bundle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = sealedBundle();
  const combinedPath = join(directory, "bundle.json");
  const policyPath = join(directory, "policy.json");
  const runPath = join(directory, "run.json");
  const trustRootPath = join(directory, "trust-root.json");
  const receiptPath = join(directory, "run-receipt.json");
  writeFileSync(
    combinedPath,
    JSON.stringify({
      policy: bundle.policy,
      diagnostic_trace: bundle.trace,
      repair_attempt: bundle.repair,
      verification_run: bundle.run,
      taxonomy: bundle.taxonomy,
    }),
  );
  writeFileSync(policyPath, JSON.stringify(bundle.policy));
  writeFileSync(runPath, JSON.stringify(bundle.run));
  writeFileSync(trustRootPath, JSON.stringify(bundle.trustRoot));
  writeFileSync(receiptPath, JSON.stringify(bundle.receipt));

  const full = spawnSync(
    process.execPath,
    [
      cliPath,
      "--input",
      combinedPath,
      "--trust-root",
      trustRootPath,
      "--run-receipt",
      receiptPath,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CN_FAILURE_ATLAS_TRUST_ROOT_SHA256: sha256Json(bundle.trustRoot),
      },
    },
  );
  assert.equal(full.status, 0, full.stderr);
  assert.equal(JSON.parse(full.stdout).status, "adopted");

  const unpinnedRoot = spawnSync(
    process.execPath,
    [
      cliPath,
      "--input",
      combinedPath,
      "--trust-root",
      trustRootPath,
      "--run-receipt",
      receiptPath,
    ],
    { encoding: "utf8", env: { ...process.env, CN_FAILURE_ATLAS_TRUST_ROOT_SHA256: "" } },
  );
  assert.equal(unpinnedRoot.status, 64, unpinnedRoot.stderr);
  assert.match(unpinnedRoot.stderr, /CN_FAILURE_ATLAS_TRUST_ROOT_SHA256/);

  const twoFile = spawnSync(
    process.execPath,
    [cliPath, "--policy", policyPath, "--run", runPath],
    { encoding: "utf8" },
  );
  assert.equal(twoFile.status, 4, twoFile.stderr);
  const result = JSON.parse(twoFile.stdout);
  assert.equal(result.status, "inconclusive");
  assertReason(result, "ARTIFACT_BUNDLE_REQUIRED");
});

test("the CLI rejects a trust root embedded in the candidate-writable bundle", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-embedded-root-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = sealedBundle();
  const combinedPath = join(directory, "bundle.json");
  const trustRootPath = join(directory, "trust-root.json");
  writeFileSync(
    combinedPath,
    JSON.stringify({
      policy: bundle.policy,
      diagnostic_trace: bundle.trace,
      repair_attempt: bundle.repair,
      verification_run: bundle.run,
      taxonomy: bundle.taxonomy,
      trust_root: bundle.trustRoot,
    }),
  );
  writeFileSync(trustRootPath, JSON.stringify(bundle.trustRoot));

  const result = spawnSync(
    process.execPath,
    [cliPath, "--input", combinedPath, "--trust-root", trustRootPath],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 64);
  assert.match(result.stderr, /must not come from.*--input bundle/);
});

test("ancestor and descendant symptoms count as one causal support group", () => {
  const bundle = sealedBundle();
  addTurn(bundle.trace, "turn.test-parent", "甲乙");
  addTurn(bundle.trace, "turn.test-child", "丙丁");
  addTurn(bundle.trace, "turn.test-causal", "戊己");
  const parent = makeSymptomFinding({
    findingId: "finding.test-parent",
    labelId: "subtext_blindness",
    turnId: "turn.test-parent",
    content: "甲乙",
  });
  const child = makeSymptomFinding({
    findingId: "finding.test-child",
    labelId: "irony_blindness",
    turnId: "turn.test-child",
    content: "丙丁",
  });
  bundle.trace.findings.push(
    parent,
    child,
    makeCausalFinding({
      findingId: "finding.test-causal-ancestry",
      supportingFindingIds: [parent.finding_id, child.finding_id],
      turnId: "turn.test-causal",
      content: "戊己",
    }),
  );
  resealBundle(bundle);

  assertIndependentSupportError(validateArtifactBundle(bundle));
});

test("symptoms citing the same source span count as one causal support group", () => {
  const bundle = sealedBundle();
  addTurn(bundle.trace, "turn.test-shared", "甲乙");
  addTurn(bundle.trace, "turn.test-causal", "丙丁");
  const first = makeSymptomFinding({
    findingId: "finding.test-shared-a",
    labelId: "subtext_blindness",
    turnId: "turn.test-shared",
    content: "甲乙",
  });
  const second = makeSymptomFinding({
    findingId: "finding.test-shared-b",
    labelId: "motivation_misread",
    turnId: "turn.test-shared",
    content: "甲乙",
  });
  bundle.trace.findings.push(
    first,
    second,
    makeCausalFinding({
      findingId: "finding.test-causal-shared-span",
      supportingFindingIds: [first.finding_id, second.finding_id],
      turnId: "turn.test-causal",
      content: "丙丁",
    }),
  );
  resealBundle(bundle);

  assertIndependentSupportError(validateArtifactBundle(bundle));
});

test("partially overlapping positive evidence counts as one causal support group", () => {
  const bundle = sealedBundle();
  addTurn(bundle.trace, "turn.test-overlap", "甲乙丙丁戊");
  addTurn(bundle.trace, "turn.test-causal", "己庚");
  const first = makeSymptomFinding({
    findingId: "finding.test-overlap-a",
    labelId: "therapist_mode_intrusion",
    turnId: "turn.test-overlap",
    content: "甲乙丙丁戊",
  });
  const second = makeSymptomFinding({
    findingId: "finding.test-overlap-b",
    labelId: "tension_premature_resolution",
    turnId: "turn.test-overlap",
    content: "甲乙丙丁戊",
  });
  Object.assign(first.evidence[0], {
    span: { start: 0, end: 1, unit: "unicode_codepoint" },
    quote: "甲",
  });
  Object.assign(first.evidence[1], {
    span: { start: 1, end: 3, unit: "unicode_codepoint" },
    quote: "乙丙",
  });
  Object.assign(second.evidence[0], {
    span: { start: 4, end: 5, unit: "unicode_codepoint" },
    quote: "戊",
  });
  Object.assign(second.evidence[1], {
    span: { start: 2, end: 4, unit: "unicode_codepoint" },
    quote: "丙丁",
  });
  bundle.trace.findings.push(
    first,
    second,
    makeCausalFinding({
      findingId: "finding.test-causal-overlap",
      labelId: "affect_manageability_bias",
      supportingFindingIds: [first.finding_id, second.finding_id],
      turnId: "turn.test-causal",
      content: "己庚",
    }),
  );
  resealBundle(bundle);

  assertIndependentSupportError(validateArtifactBundle(bundle));
});

test("a causal hypothesis rejects unrelated symptoms even when spans are independent", () => {
  const bundle = sealedBundle();
  addTurn(bundle.trace, "turn.test-unrelated-a", "甲乙");
  addTurn(bundle.trace, "turn.test-unrelated-b", "丙丁");
  addTurn(bundle.trace, "turn.test-causal", "戊己");
  const first = makeSymptomFinding({
    findingId: "finding.test-unrelated-a",
    labelId: "reference_boundary_failure",
    turnId: "turn.test-unrelated-a",
    content: "甲乙",
  });
  const second = makeSymptomFinding({
    findingId: "finding.test-unrelated-b",
    labelId: "pronoun_role_confusion",
    turnId: "turn.test-unrelated-b",
    content: "丙丁",
  });
  bundle.trace.findings.push(
    first,
    second,
    makeCausalFinding({
      findingId: "finding.test-causal-unrelated",
      labelId: "affect_manageability_bias",
      supportingFindingIds: [first.finding_id, second.finding_id],
      turnId: "turn.test-causal",
      content: "戊己",
    }),
  );
  resealBundle(bundle);

  const result = validateArtifactBundle(bundle);
  assert.ok(
    result.errors.some(
      (error) =>
        error.rule === "R10" &&
        error.message.includes("support_contract 不接受的症状"),
    ),
    JSON.stringify(result.errors, null, 2),
  );
});

test("a specified causal support contract accepts two admissible independent symptoms", () => {
  const bundle = sealedBundle();
  addTurn(bundle.trace, "turn.test-affect-a", "甲乙");
  addTurn(bundle.trace, "turn.test-affect-b", "丙丁");
  addTurn(bundle.trace, "turn.test-causal", "戊己");
  const first = makeSymptomFinding({
    findingId: "finding.test-affect-a",
    labelId: "therapist_mode_intrusion",
    turnId: "turn.test-affect-a",
    content: "甲乙",
  });
  const second = makeSymptomFinding({
    findingId: "finding.test-affect-b",
    labelId: "tension_premature_resolution",
    turnId: "turn.test-affect-b",
    content: "丙丁",
  });
  bundle.trace.findings.push(
    first,
    second,
    makeCausalFinding({
      findingId: "finding.test-causal-valid",
      labelId: "affect_manageability_bias",
      supportingFindingIds: [first.finding_id, second.finding_id],
      turnId: "turn.test-causal",
      content: "戊己",
    }),
  );
  resealBundle(bundle);

  const result = validateArtifactBundle(bundle);
  assert.ok(
    !result.errors.some(
      (error) =>
        error.rule === "R10" &&
        (error.message.includes("独立症状证据组") ||
          error.message.includes("support_contract")),
    ),
    JSON.stringify(result.errors, null, 2),
  );
});

test("an underspecified causal hypothesis cannot be marked present", () => {
  const bundle = sealedBundle();
  addTurn(bundle.trace, "turn.test-reader-a", "甲乙");
  addTurn(bundle.trace, "turn.test-reader-b", "丙丁");
  addTurn(bundle.trace, "turn.test-causal", "戊己");
  const first = makeSymptomFinding({
    findingId: "finding.test-reader-a",
    labelId: "therapist_mode_intrusion",
    turnId: "turn.test-reader-a",
    content: "甲乙",
  });
  const second = makeSymptomFinding({
    findingId: "finding.test-reader-b",
    labelId: "tension_premature_resolution",
    turnId: "turn.test-reader-b",
    content: "丙丁",
  });
  bundle.trace.findings.push(
    first,
    second,
    makeCausalFinding({
      findingId: "finding.test-causal-underspecified",
      labelId: "reader_comfort_alignment",
      supportingFindingIds: [first.finding_id, second.finding_id],
      turnId: "turn.test-causal",
      content: "戊己",
    }),
  );
  resealBundle(bundle);

  const result = validateArtifactBundle(bundle);
  assert.ok(
    result.errors.some(
      (error) =>
        error.rule === "R10" && error.message.includes("尚未指定，不得标为 present"),
    ),
    JSON.stringify(result.errors, null, 2),
  );
});

test("duplicate finding IDs and insufficient evidence scope are rejected", () => {
  const bundle = sealedBundle();
  const duplicate = structuredClone(bundle.trace.findings[0]);
  bundle.trace.findings.push(duplicate);
  addTurn(bundle.trace, "turn.test-scope", "甲乙");
  const narrow = makeSymptomFinding({
    findingId: "finding.test-scope",
    labelId: "microreaction_mechanization",
    turnId: "turn.test-scope",
    content: "甲乙",
  });
  narrow.scope = "turn";
  bundle.trace.findings.push(narrow);
  resealBundle(bundle);

  const result = validateArtifactBundle(bundle);
  assert.ok(
    result.errors.some((error) => error.message.includes("重复 finding_id")),
    JSON.stringify(result.errors, null, 2),
  );
  assert.ok(
    result.errors.some((error) => error.message.includes("低于 taxonomy 要求")),
    JSON.stringify(result.errors, null, 2),
  );
});

test("cross-scene scope must be attested by evidence from two explicit scenes", () => {
  const bundle = sealedBundle();
  const firstTurnId = "turn.cross-scene.one";
  addTurn(bundle.trace, firstTurnId, "甲乙", "scene.one");
  const finding = makeSymptomFinding({
    findingId: "finding.cross-scene",
    labelId: "microreaction_mechanization",
    turnId: firstTurnId,
    content: "甲乙",
  });
  finding.scope = "cross_scene";
  bundle.trace.findings.push(finding);
  resealBundle(bundle);

  let result = validateArtifactBundle(bundle);
  assert.ok(
    result.errors.some((error) => error.message.includes("generator output scene contract")),
    JSON.stringify(result.errors, null, 2),
  );

  const secondTurnId = "turn.cross-scene.two";
  addTurn(bundle.trace, secondTurnId, "丙丁", "scene.two");
  finding.evidence.push({
    evidence_id: "evidence.cross-scene.second.support",
    source_record_id: bundle.trace.subject.record_id,
    turn_id: secondTurnId,
    span: { start: 0, end: 1, unit: "unicode_codepoint" },
    quote: "丙",
    stance: "supports",
    rationale: "A second explicit scene is required for a cross-scene claim.",
  });
  resealBundle(bundle);

  result = validateArtifactBundle(bundle);
  assert.ok(
    !result.errors.some((error) => error.message.includes("generator output scene contract")),
    JSON.stringify(result.errors, null, 2),
  );

  bundle.trace.subject.turns.at(-1).speaker = "user";
  resealBundle(bundle);
  result = validateArtifactBundle(bundle);
  assert.ok(
    result.errors.some((error) => error.message.includes("generator output scene contract")),
    "user input must not attest a failure in model output",
  );
});

test("a frozen manifest binds case semantics, not only reusable IDs", () => {
  const bundle = sealedBundle();
  const frozenDigest = bundle.run.evaluation_manifest.manifest_digest;
  const check = bundle.run.regression_checks[0];

  check.case_digest = "0".repeat(64);
  check.suite_digest = "1".repeat(64);
  check.protected_behavior =
    "Attacker-substituted easy behavior under the already committed check_id.";

  assert.equal(bundle.run.evaluation_manifest.manifest_digest, frozenDigest);
  const result = evaluateBundle(bundle);
  assert.notEqual(
    result.status,
    "adopted",
    "changing a frozen case's identity and meaning must invalidate the manifest even when its check_id is unchanged",
  );
  assertReason(result, "EVALUATION_MANIFEST_MISMATCH");
});

test("a run cannot override the precommitted stop rule in its source records", () => {
  const bundle = sealedBundle();
  const runStopRule = structuredClone(bundle.run.experiment_ledger.stop_rule);
  for (const record of [bundle.trace, bundle.repair]) {
    Object.assign(record.experiment_ledger.stop_rule, {
      rule_id: "stop.precommitted.no-promotion",
      precommitted: true,
      condition: "The precommitted stopping condition has been met.",
      action_when_met: "halt_without_promotion",
      triggered: true,
    });
  }
  resealBundle(bundle);
  assert.deepEqual(bundle.run.experiment_ledger.stop_rule, runStopRule);

  const result = evaluateBundle(bundle);
  assert.notEqual(
    result.status,
    "adopted",
    "a promotable run-side stop rule must not override a source ledger that already requires halt_without_promotion",
  );
  assertReason(result, "EXPERIMENT_LEDGER_INVALID");
});

test("direct evaluatePromotion validates every bundled record and its semantics", async (t) => {
  await t.test("schema-invalid diagnostic trace", () => {
    const bundle = sealedBundle();
    delete bundle.trace.scene_contract;

    const machineValidation = validateArtifactBundle(bundle);
    assert.ok(machineValidation.errors.length > 0);
    const result = evaluateBundle(bundle);
    assert.notEqual(
      result.status,
      "adopted",
      "the library API must not adopt a bundle that the artifact schema rejects",
    );
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
  });

  await t.test("schema-valid but semantically invalid evidence quote", () => {
    const bundle = sealedBundle();
    bundle.trace.findings[0].evidence[0].quote =
      "This quote does not occur at the declared source span.";
    resealBundle(bundle);

    const machineValidation = validateArtifactBundle(bundle);
    assert.ok(
      machineValidation.errors.some((error) =>
        error.message.includes("span 与 quote/turn 内容不一致"),
      ),
      JSON.stringify(machineValidation.errors, null, 2),
    );
    const result = evaluateBundle(bundle);
    assert.notEqual(
      result.status,
      "adopted",
      "the library API must enforce semantic artifact validation, not only top-level policy/run schemas",
    );
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
  });

  await t.test("schema-invalid repair collections fail closed without throwing", () => {
    const bundle = sealedBundle();
    bundle.repair.target_finding_ids = {};
    let result;
    assert.doesNotThrow(() => {
      result = evaluateBundle(bundle);
    });
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
  });

  await t.test("lone UTF-16 surrogates fail closed without throwing", () => {
    const bundle = sealedBundle();
    bundle.run.challenges[0].claim = "\ud800";
    let result;
    assert.doesNotThrow(() => {
      result = evaluateBundle(bundle);
    });
    assert.notEqual(result.status, "adopted");
    assertReason(result, "INVALID_VERIFICATION_RUN");
  });

  await t.test("a 20k-deep artifact bundle fails closed without recursion", () => {
    const bundle = sealedBundle();
    let cursor = bundle.trace;
    for (let depth = 0; depth < 20_001; depth += 1) {
      cursor.untrusted_child = {};
      cursor = cursor.untrusted_child;
    }

    let result;
    assert.doesNotThrow(() => {
      result = evaluateBundle(bundle);
    });
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.equal(
      result.error?.message,
      "artifact bundle exceeds structural input limits",
    );
  });

  await t.test("an artifact bundle with over 20k nodes fails closed", () => {
    const bundle = sealedBundle();
    bundle.trace.untrusted_nodes = Array.from(
      { length: 20_001 },
      (_, index) => ({ index }),
    );

    let result;
    assert.doesNotThrow(() => {
      result = evaluateBundle(bundle);
    });
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.equal(
      result.error?.message,
      "artifact bundle exceeds structural input limits",
    );
  });

  for (const attack of [
    {
      name: "over-depth verification run",
      mutate(run) {
        let cursor = run;
        for (let depth = 0; depth < 129; depth += 1) {
          cursor.untrusted_child = {};
          cursor = cursor.untrusted_child;
        }
      },
    },
    {
      name: "over-node verification run",
      expectedMachineMessage: "structural input limits",
      mutate(run) {
        run.untrusted_nodes = Array.from(
          { length: 20_001 },
          (_, index) => ({ index }),
        );
      },
    },
    {
      name: "cyclic verification run",
      expectedMachineMessage: "cyclic object reference",
      mutate(run) {
        run.promotion_gate = structuredClone(runExample.promotion_gate);
        run.promotion_gate.metrics.self = run.promotion_gate.metrics;
      },
    },
  ]) {
    await t.test(`${attack.name} is rejected before schema evaluation`, () => {
      const bundle = sealedBundle();
      attack.mutate(bundle.run);

      let gateValidation;
      assert.doesNotThrow(() => {
        gateValidation = validateGateInputSchemas(bundle.policy, bundle.run);
      });
      assert.equal(gateValidation.valid, false);
      assert.ok(
        gateValidation.verification_run.errors.some(
          (error) => error.keyword === "structuralLimit",
        ),
        JSON.stringify(gateValidation, null, 2),
      );

      let machineValidation;
      assert.doesNotThrow(() => {
        machineValidation = validateArtifactBundle(bundle);
      });
      assert.ok(
        machineValidation.errors.some(
          (error) =>
            error.rule === "R8" &&
            error.message.includes(
              attack.expectedMachineMessage ?? "structural input limits",
            ),
        ),
        JSON.stringify(machineValidation.errors, null, 2),
      );

      let result;
      assert.doesNotThrow(() => {
        result = evaluateBundle(bundle);
      });
      assert.notEqual(result.status, "adopted");
      assertReason(result, "INVALID_VERIFICATION_RUN");
    });
  }

  await t.test("shared acyclic references are not mistaken for cycles", () => {
    const shared = { value: "shared" };
    const structure = inspectUntrustedStructure({ left: shared, right: shared });

    assert.equal(structure.pass, true, JSON.stringify(structure, null, 2));
    assert.equal(structure.cycle_detected, false);
  });
});

test("taxonomy authority is schema-validated and pinned outside the candidate bundle", async (t) => {
  await t.test("schema-invalid taxonomy", () => {
    const bundle = sealedBundle();
    bundle.taxonomy.layers[0].subcategories[0].labels[0].definition = 42;
    resealBundle(bundle);

    assert.equal(
      typeof bundle.taxonomy.layers[0].subcategories[0].labels[0].definition,
      "number",
      "attack fixture must violate the taxonomy definition string contract",
    );
    const result = evaluateBundle(bundle);
    assert.notEqual(
      result.status,
      "adopted",
      "self-consistent provenance hashes must not legitimize a schema-invalid taxonomy",
    );
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
  });

  await t.test("valid taxonomy rewrite under the same policy trust root", () => {
    const bundle = sealedBundle();
    const pinnedTrustRoot = structuredClone(bundle.trustRoot);
    const originalTaxonomyDigest = sha256Json(bundle.taxonomy);
    bundle.taxonomy.layers[0].subcategories[0].labels[0].definition +=
      " Attacker-authored replacement definition.";
    resealBundle(bundle);
    bundle.trustRoot = pinnedTrustRoot;

    assert.notEqual(sha256Json(bundle.taxonomy), originalTaxonomyDigest);
    const result = evaluateBundle(bundle);
    assert.notEqual(
      result.status,
      "adopted",
      "a candidate-controlled taxonomy and matching provenance hashes need an external taxonomy trust commitment",
    );
    assertReason(result, "POLICY_TRUST_ROOT_MISMATCH");
    assert.ok(
      result.metrics.policy_trust_root.issues.includes(
        "taxonomy_digest_mismatch",
      ),
    );
  });
});

test("verified provenance cannot be asserted with arbitrary placeholder digests", () => {
  const bundle = sealedBundle();
  bundle.policy.provenance.schema.digest = "0".repeat(64);
  bundle.run.provenance.prompt_bundle.digest = "1".repeat(64);
  bundle.policy.provenance.digest_status = "verified";
  bundle.run.provenance.digest_status = "verified";

  const result = evaluateBundle(bundle);
  assert.notEqual(
    result.status,
    "adopted",
    "digest_status=verified is only a claim until schema, prompt, runner, and taxonomy digests are checked against trusted artifacts",
  );
  assertReason(result, "UNVERIFIED_PROVENANCE");
});

test("repeat run digests are recomputed rather than accepted as arbitrary unique claims", () => {
  const bundle = sealedBundle();
  bundle.run.repeat_manifest[0].run_digest = "0".repeat(64);
  bundle.run.repeat_manifest[1].run_digest = "1".repeat(64);

  const result = evaluateBundle(bundle);
  assert.notEqual(
    result.status,
    "adopted",
    "two distinct strings do not prove that either digest commits to an executed repeat",
  );
});

test("manifest freezing must be strictly earlier than candidate generation", () => {
  const bundle = sealedBundle();
  bundle.run.evaluation_manifest.frozen_at =
    bundle.repair.provenance.created_at;
  resealBundle(bundle);

  const result = evaluateBundle(bundle);
  assert.notEqual(
    result.status,
    "adopted",
    "an equal timestamp does not establish that the manifest existed before candidate generation",
  );
  assertReason(result, "EVALUATION_MANIFEST_MISMATCH");
});

test("signed run chronology cannot place verification outside the candidate window", async (t) => {
  const cases = [
    {
      name: "repeat before candidate generation",
      mutate(bundle) {
        bundle.run.repeat_manifest[0].executed_at = "2026-08-23T10:06:00Z";
      },
    },
    {
      name: "repeat after completion",
      mutate(bundle) {
        bundle.run.repeat_manifest[0].executed_at = "2026-08-24T10:08:01Z";
      },
    },
    {
      name: "run record before candidate generation",
      mutate(bundle) {
        bundle.run.provenance.created_at = "2026-08-24T10:00:59Z";
      },
    },
    {
      name: "run record after completion",
      mutate(bundle) {
        bundle.run.provenance.created_at = "2026-08-24T10:08:01Z";
      },
    },
    {
      name: "repeat before run record instantiation",
      mutate(bundle) {
        bundle.run.provenance.created_at = "2026-08-24T10:06:30Z";
      },
    },
  ];

  for (const { name, mutate } of cases) {
    await t.test(name, () => {
      const bundle = sealedBundle();
      mutate(bundle);
      resealBundle(bundle);
      bundle.receipt = makeRunReceipt(bundle);

      const result = evaluateBundle(bundle);
      assert.notEqual(
        result.status,
        "adopted",
        "a fresh completion signature must not legitimize impossible chronology",
      );
      assertReason(result, "RUN_RECEIPT_INVALID");
      assert.ok(
        result.metrics.run_receipt.issues.includes("receipt_timeline_invalid"),
      );
    });
  }

  await t.test("verification precommit must precede audit and challenge execution", () => {
    const bundle = sealedBundle();
    const executionBeforePrecommit = "2026-08-24T10:05:29Z";
    bundle.run.evidence_checks[0].executed_at = executionBeforePrecommit;
    bundle.run.challenge_invocations[0].executed_at = executionBeforePrecommit;
    resealBundle(bundle, {
      preserveChallengeInvocations: true,
      preserveVerificationExecutionTimes: true,
    });
    bundle.receipt = makeRunReceipt(bundle);
    const schemaValidation = validateGateInputSchemas(
      bundle.policy,
      bundle.run,
    );
    assert.equal(
      schemaValidation.valid,
      true,
      JSON.stringify(schemaValidation, null, 2),
    );

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "RUN_RECEIPT_INVALID");
    assert.equal(result.metrics.artifact_bundle.pass, true);
    assert.ok(
      result.metrics.run_receipt.issues.includes(
        "verification_precommit_timeline_invalid",
      ),
    );
    assert.ok(
      !result.metrics.run_receipt.issues.some((issue) =>
        issue.includes("signature_invalid"),
      ),
      JSON.stringify(result.metrics.run_receipt.issues, null, 2),
    );
  });
});

test("every repair target must be checked by every participating judge", () => {
  const bundle = sealedBundle();
  const firstFinding = bundle.trace.findings[0];
  const secondFinding = structuredClone(firstFinding);
  secondFinding.finding_id = "finding.affective-closure-002";
  const evidenceIdMap = new Map();
  for (const evidence of secondFinding.evidence) {
    const previousId = evidence.evidence_id;
    evidence.evidence_id = `${previousId}.second`;
    evidenceIdMap.set(previousId, evidence.evidence_id);
  }
  for (const testResult of secondFinding.taxonomy_test_results) {
    testResult.evidence_ids = testResult.evidence_ids.map((evidenceId) =>
      evidenceIdMap.get(evidenceId),
    );
    if (testResult.execution) {
      testResult.execution.execution_id =
        `${testResult.execution.execution_id}.second`;
      for (const invariant of testResult.execution.judgment?.invariants ?? []) {
        if (Array.isArray(invariant.evidence_ids)) {
          invariant.evidence_ids = invariant.evidence_ids.map((evidenceId) =>
            evidenceIdMap.get(evidenceId),
          );
        }
      }
      const executionPayload = { ...testResult.execution };
      delete executionPayload.execution_digest;
      testResult.execution.execution_digest = sha256Json(executionPayload);
    }
  }
  for (const rebuttal of secondFinding.neighboring_label_rebuttals) {
    if (rebuttal.test_execution_id) {
      rebuttal.test_execution_id = `${rebuttal.test_execution_id}.second`;
    }
    rebuttal.evidence_ids = rebuttal.evidence_ids.map((evidenceId) =>
      evidenceIdMap.get(evidenceId),
    );
  }
  bundle.trace.findings.push(secondFinding);
  bundle.trace.disposition.priority_finding_ids.push(secondFinding.finding_id);
  bundle.repair.target_finding_ids.push(secondFinding.finding_id);
  const secondEdit = structuredClone(bundle.repair.repair_plan.edits[0]);
  secondEdit.edit_id = "edit.closure-002";
  secondEdit.target_finding_id = secondFinding.finding_id;
  secondEdit.source_evidence_ids = [
    evidenceIdMap.get("evidence.closure-001"),
  ];
  bundle.repair.repair_plan.edits.push(secondEdit);

  const [firstAuditJudgeId, secondAuditJudgeId] =
    bundle.run.actor_profiles.audit_judges.map((judge) => judge.id);
  const secondJudgeEvidenceCheck = bundle.run.evidence_checks.find(
    (check) => check.judge_id === secondAuditJudgeId,
  );
  secondJudgeEvidenceCheck.finding_id = secondFinding.finding_id;
  secondJudgeEvidenceCheck.evidence_ids = [
    evidenceIdMap.get("evidence.closure-001"),
  ];
  const secondJudgeTargetCheck = bundle.run.target_failure_checks.find(
    (check) => check.judge_id === secondAuditJudgeId,
  );
  secondJudgeTargetCheck.finding_id = secondFinding.finding_id;
  const secondJudgeCounterfactualCheck = bundle.run.counterfactual_checks.find(
    (check) => check.judge_id === secondAuditJudgeId,
  );
  secondJudgeCounterfactualCheck.finding_id = secondFinding.finding_id;
  delete secondJudgeCounterfactualCheck.source_execution_id;

  resealBundle(bundle);
  bundle.receipt = makeRunReceipt(bundle);
  const result = evaluateBundle(bundle);

  assert.notEqual(
    result.status,
    "adopted",
    "two judges reviewing disjoint targets must not impersonate independent coverage of both targets",
  );
  assertReason(result, "CHECK_JUDGE_COVERAGE_INCOMPLETE");
  assert.deepEqual(
    result.metrics.check_references.missing_target_judge_slots,
    [
      `counterfactual_checks:finding.affective-closure-001:${secondAuditJudgeId}`,
      `counterfactual_checks:finding.affective-closure-002:${firstAuditJudgeId}`,
      `evidence_checks:finding.affective-closure-001:${secondAuditJudgeId}`,
      `evidence_checks:finding.affective-closure-002:${firstAuditJudgeId}`,
      `target_failure_checks:finding.affective-closure-001:${secondAuditJudgeId}`,
      `target_failure_checks:finding.affective-closure-002:${firstAuditJudgeId}`,
    ].sort(),
  );
});

test("supersedes references cannot switch to another record schema", async (t) => {
  const cases = [
    ["policy", "evolution_policy", "policy.prior"],
    ["trace", "diagnostic_trace", "trace.prior"],
    ["repair", "repair_attempt", "repair.prior"],
    ["run", "verification_run", "verification.prior"],
  ];

  for (const [field, recordType, priorId] of cases) {
    await t.test(recordType, () => {
      const bundle = sealedBundle();
      bundle[field].supersedes_ref = {
        record_id: priorId,
        schema_id:
          "https://yuqing-cai.github.io/cn-failure-atlas/schemas/wrong.schema.json",
        schema_version: bundle[field].schema_version,
        uri: `${priorId}.json`,
        digest: "a".repeat(64),
      };
      resealBundle(bundle);
      bundle.receipt = makeRunReceipt(bundle);

      const result = evaluateBundle(bundle);
      assert.notEqual(result.status, "adopted");
      assertReason(result, "ARTIFACT_BUNDLE_INVALID");
      assert.ok(
        result.metrics.artifact_bundle.issues.includes(
          `${field}.supersedes_ref_schema_identity_mismatch`,
        ),
      );
    });
  }

  await t.test("policy history link is covered by policy_digest", () => {
    const bundle = sealedBundle();
    const descriptor = getLocalSchemaDescriptor("evolution_policy");
    bundle.policy.supersedes_ref = {
      record_id: "policy.machine-only.prior",
      schema_id: descriptor.id,
      schema_version: descriptor.version,
      uri: "policy.machine-only.prior.json",
      digest: "a".repeat(64),
    };
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);
    bundle.policy.supersedes_ref.digest = "b".repeat(64);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "POLICY_DIGEST_MISMATCH");
  });
});

test("promotion source identity and artifact version are sealed", async (t) => {
  await t.test("source schema identity is anchored to the local repair schema", () => {
    const bundle = sealedBundle();
    const forgedSourceIdentity = {
      schema_id: "https://attacker.invalid/forged-repair.schema.json",
      schema_version: "999.0.0",
      uri: "attacker-controlled-repair.json",
    };
    Object.assign(bundle.run.repair_attempt_ref, forgedSourceIdentity);
    Object.assign(
      bundle.run.promotion_artifact.source_ref,
      forgedSourceIdentity,
    );
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(
      result.status,
      "adopted",
      "mutually consistent and freshly signed forged schema metadata must not replace the locally authoritative schema identity",
    );
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.equal(
      result.metrics.promotion_artifact.pass,
      true,
      "the attack must reach the authoritative-schema check, not fail merely because source_ref differs from repair_attempt_ref",
    );
    assert.ok(
      result.metrics.artifact_bundle.issues.includes(
        "run.repair_attempt_ref_schema_identity_mismatch",
      ),
    );
  });

  await t.test("repair and verification trace refs use the local diagnostic schema", () => {
    const bundle = sealedBundle();
    const forgedTraceIdentity = {
      schema_id: "https://attacker.invalid/forged-trace.schema.json",
      schema_version: "999.0.0",
    };
    Object.assign(bundle.repair.diagnostic_trace_ref, forgedTraceIdentity);
    Object.assign(bundle.run.diagnostic_trace_ref, forgedTraceIdentity);
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.notEqual(result.status, "adopted");
    assertReason(result, "ARTIFACT_BUNDLE_INVALID");
    assert.ok(
      result.metrics.artifact_bundle.issues.includes(
        "repair.diagnostic_trace_ref_schema_identity_mismatch",
      ),
    );
    assert.ok(
      result.metrics.artifact_bundle.issues.includes(
        "run.diagnostic_trace_ref_schema_identity_mismatch",
      ),
    );
  });

  await t.test("a consistently relocated source URI remains valid", () => {
    const bundle = sealedBundle();
    const relocatedUri = "content-addressed/repair.scene-001.v1.json";
    bundle.run.repair_attempt_ref.uri = relocatedUri;
    bundle.run.promotion_artifact.source_ref.uri = relocatedUri;
    resealBundle(bundle);
    bundle.receipt = makeRunReceipt(bundle);

    const result = evaluateBundle(bundle);
    assert.equal(
      result.status,
      "adopted",
      `URI is a cross-reference locator, not an authoritative local constant: ${JSON.stringify(result.reason_codes)}`,
    );
  });

  await t.test("artifact version", () => {
    const bundle = sealedBundle();
    bundle.run.promotion_artifact.artifact_version = "999.0.0";

    const result = evaluateBundle(bundle);
    assert.notEqual(
      result.status,
      "adopted",
      "artifact_version must be committed by the payload or its authoritative source",
    );
    assertReason(result, "PROMOTION_ARTIFACT_INVALID");
  });
});

function sealedBundle() {
  const bundle = {
    policy: structuredClone(policyExample),
    trace: structuredClone(traceExample),
    repair: structuredClone(repairExample),
    run: structuredClone(runExample),
    taxonomy: structuredClone(taxonomyExample),
    trustRoot: null,
    receipt: null,
  };
  delete bundle.run.promotion_gate;
  for (const record of [
    bundle.policy,
    bundle.trace,
    bundle.repair,
    bundle.run,
  ]) {
    record.provenance.digest_status = "verified";
  }
  resealBundle(bundle);
  bundle.receipt = makeRunReceipt(bundle);
  const gateSchemaValidation = validateGateInputSchemas(
    bundle.policy,
    bundle.run,
  );
  assert.equal(
    gateSchemaValidation.valid,
    true,
    JSON.stringify(gateSchemaValidation, null, 2),
  );
  const baseline = evaluateBundle(bundle);
  assert.equal(
    baseline.status,
    "adopted",
    JSON.stringify({
      reason_codes: baseline.reason_codes,
      artifact_bundle_issues: baseline.metrics?.artifact_bundle?.issues,
    }),
  );
  return bundle;
}

function resealBundle(
  bundle,
  {
    preserveBlindingProtocolDigest = false,
    preserveChallengeInvocations = false,
    preserveChallengeRequestDigests = false,
    preserveAuditInvocationPlan = false,
    preserveVerificationExecutionTimes = false,
  } = {},
) {
  const { policy, trace, repair, run, taxonomy } = bundle;
  const primaryTurn = trace.subject.turns.find(
    (turn) => turn.turn_id === trace.subject.generator_output_turn_id,
  );
  const primaryScene = trace.subject.scenes.find(
    (scene) => scene.scene_id === primaryTurn?.scene_id,
  );
  primaryScene.contract = structuredClone(trace.scene_contract);
  for (const scene of trace.subject.scenes) {
    scene.contract_digest = sha256Json(scene.contract);
  }
  trace.subject.input_digest = computeGenerationInputDigest(
    trace,
    trace.subject.generator_output_turn_id,
  );
  const taxonomyDigest = sha256Json(taxonomy);
  for (const record of [policy, trace, repair, run]) {
    record.provenance.taxonomy.version = taxonomy.taxonomy_version;
    record.provenance.taxonomy.digest = taxonomyDigest;
    record.provenance.schema = getLocalSchemaDescriptor(record.record_type);
  }

  const taxonomyLabels = new Map(
    (taxonomy.layers ?? []).flatMap((layer) =>
      (layer.subcategories ?? []).flatMap((subcategory) =>
        (subcategory.labels ?? []).map((label) => [label.id, label]),
      ),
    ),
  );
  for (const finding of trace.findings ?? []) {
    for (const result of finding.taxonomy_test_results ?? []) {
      const execution = result.execution;
      if (!execution) continue;
      const targetTurn = trace.subject.turns.find(
        (turn) => turn.turn_id === execution.intervention.target_turn_id,
      );
      const scene = trace.subject.scenes.find(
        (item) => item.scene_id === targetTurn?.scene_id,
      );
      const recipe = taxonomyLabels
        .get(finding.label_id)
        ?.test_recipes?.find((item) => item.recipe_id === result.recipe_id);
      if (!targetTurn || !scene) continue;
      execution.scene_contract_digest = scene.contract_digest;
      execution.input_digest = computeTaxonomyTestInputDigest(
        trace,
        result,
        finding,
        taxonomy,
        recipe,
      );
      execution.output.digest = sha256Text(execution.output.content);
      execution.execution_digest = computeTaxonomyTestExecutionDigest({
        finding,
        result,
        taxonomy,
        recipe,
      });
    }
  }
  for (const check of run.counterfactual_checks ?? []) {
    const findingId =
      check.finding_id ?? repair.target_finding_ids?.[0];
    const finding = (trace.findings ?? []).find(
      (item) => item.finding_id === findingId,
    );
    const sourceResult = (finding?.taxonomy_test_results ?? []).find(
      (result) =>
        result.outcome === "passed" &&
        result.execution &&
        (!check.recipe_id || result.recipe_id === check.recipe_id) &&
        (!check.source_execution_id ||
          result.execution.execution_id === check.source_execution_id),
    );
    if (finding && sourceResult?.execution) {
      Object.assign(check, {
        finding_id: finding.finding_id,
        target_turn_id: repair.target_turn_id,
        recipe_id: sourceResult.recipe_id,
        source_execution_id: sourceResult.execution.execution_id,
        source_execution_digest: sourceResult.execution.execution_digest,
        intervention: structuredClone(sourceResult.execution.intervention),
        invariant_contract_paths: [
          ...new Set(
            (sourceResult.execution.judgment?.invariants ?? [])
              .filter(
                (invariant) =>
                  invariant.source_kind === "scene_contract" &&
                  invariant.status === "passed",
              )
              .flatMap((invariant) => invariant.contract_paths ?? []),
          ),
        ].sort(),
      });
    }
    delete check.transformation;
    delete check.expected_invariant;
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
  bundle.trustRoot = {
    record_type: "promotion_trust_root",
    schema_version: "1.0.0",
    trust_root_id: "trust-root.test.v1",
    policy_id: policy.policy.id,
    policy_version: policy.policy.version,
    policy_digest: policy.policy_digest,
    taxonomy_name: taxonomy.name,
    taxonomy_version: taxonomy.taxonomy_version,
    taxonomy_digest: taxonomyDigest,
    trusted_runners: [
      ...new Map(
        [policy, trace, repair, run].map((record) => [
          JSON.stringify(record.provenance.runner),
          structuredClone(record.provenance.runner),
        ]),
      ).values(),
    ],
    trusted_prompt_bundles: collectPromptBundleDescriptors([
      policy,
      trace,
      repair,
      run,
    ]),
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
  for (const record of [trace, repair, run]) {
    record.policy_ref.digest = policy.policy_digest;
  }

  for (const candidateId of ["baseline", "candidate"]) {
    const candidate = repair.candidates[candidateId];
    candidate.digest = sha256Text(candidate.content);
    run.candidates[candidateId].digest = candidate.digest;
  }
  if (!preserveBlindingProtocolDigest) {
    repair.verification_handoff.blinding_protocol_digest =
      computeBlindingProtocolDigest(run);
  }
  run.blinding.mapping_digest = computeBlindingMappingDigest(run);
  for (const trial of run.order_trials) {
    trial.preference_request_digest = computePreferenceRequestDigest(
      run,
      trial,
      {
        diagnostic_trace: trace,
        repair_attempt: repair,
      },
    );
  }
  if (!preserveChallengeInvocations) {
    const raisers = (run.actor_profiles.critics ?? []).map((actor) => ({
      invocation_id: `challenge-invocation.${actor.id}.raise`,
      invocation_kind: "challenge_raiser",
      actor_id: actor.id,
      context_partition: actor.context_partition,
      seed: actor.seed,
      completed: true,
      raised_challenge_ids: (run.challenges ?? [])
        .filter((challenge) => challenge.raised_by === actor.id)
        .map((challenge) => challenge.challenge_id)
        .sort(),
      resolved_challenge_ids: [],
    }));
    const resolverActorIds = new Set(
      (run.challenges ?? [])
        .filter((challenge) => challenge.resolved === true)
        .map((challenge) => challenge.resolved_by),
    );
    const resolvers = (run.actor_profiles.audit_judges ?? [])
      .filter((actor) => resolverActorIds.has(actor.id))
      .map((actor) => ({
        invocation_id: `challenge-invocation.${actor.id}.resolve`,
        invocation_kind: "challenge_resolver",
        actor_id: actor.id,
        context_partition: actor.context_partition,
        seed: actor.seed,
        completed: true,
        raised_challenge_ids: [],
        resolved_challenge_ids: (run.challenges ?? [])
          .filter(
            (challenge) =>
              challenge.resolved === true && challenge.resolved_by === actor.id,
          )
          .map((challenge) => challenge.challenge_id)
          .sort(),
      }));
    run.challenge_invocations = [...raisers, ...resolvers]
      .sort((left, right) =>
        left.invocation_id.localeCompare(right.invocation_id),
      );
  }
  for (const collectionName of [
    "evidence_checks",
    "target_failure_checks",
    "counterfactual_checks",
    "regression_checks",
  ]) {
    for (const check of run[collectionName] ?? []) {
      const judge = (run.actor_profiles.audit_judges ?? []).find(
        (actor) => actor.id === check.judge_id,
      );
      if (!judge) continue;
      if (!preserveAuditInvocationPlan) {
        check.invocation_id =
          `audit-invocation.${collectionName}.${check.check_id}`;
        check.context_partition =
          `${judge.context_partition}/${collectionName}/${check.check_id}`;
        check.seed = computeAuditCheckSeed(
          judge.seed,
          collectionName,
          check.check_id,
        );
      }
      check.audit_request_digest = computeAuditRequestDigest(
        run,
        collectionName,
        check,
        {
          diagnostic_trace: trace,
          repair_attempt: repair,
        },
      );
    }
  }
  if (!preserveVerificationExecutionTimes) {
    const repeatTimeById = new Map(
      (run.repeat_manifest ?? []).map((repeat) => [
        repeat.repeat_id,
        Date.parse(repeat.executed_at),
      ]),
    );
    const trialIndexByRepeat = new Map();
    for (const trial of run.order_trials ?? []) {
      const index = trialIndexByRepeat.get(trial.repeat_id) ?? 0;
      const repeatTime = repeatTimeById.get(trial.repeat_id);
      trial.executed_at = new Date(
        repeatTime - 10_000 + index * 1_000,
      ).toISOString();
      trialIndexByRepeat.set(trial.repeat_id, index + 1);
    }

    let auditIndex = 0;
    for (const collectionName of [
      "evidence_checks",
      "target_failure_checks",
      "counterfactual_checks",
      "regression_checks",
    ]) {
      for (const check of run[collectionName] ?? []) {
        check.executed_at = new Date(
          Date.parse("2026-08-24T10:06:05Z") + auditIndex * 1_000,
        ).toISOString();
        auditIndex += 1;
      }
    }

    let raiserIndex = 0;
    let resolverIndex = 0;
    let otherChallengeIndex = 0;
    for (const invocation of run.challenge_invocations ?? []) {
      if ((invocation.resolved_challenge_ids ?? []).length > 0) {
        invocation.executed_at = new Date(
          Date.parse("2026-08-24T10:06:40Z") + resolverIndex * 1_000,
        ).toISOString();
        resolverIndex += 1;
      } else if ((invocation.raised_challenge_ids ?? []).length > 0) {
        invocation.executed_at = new Date(
          Date.parse("2026-08-24T10:05:40Z") + raiserIndex * 1_000,
        ).toISOString();
        raiserIndex += 1;
      } else {
        invocation.executed_at = new Date(
          Date.parse("2026-08-24T10:06:30Z") +
            otherChallengeIndex * 1_000,
        ).toISOString();
        otherChallengeIndex += 1;
      }
    }
  }
  for (const invocation of run.challenge_invocations ?? []) {
    if (preserveChallengeRequestDigests) continue;
    if (invocation.invocation_kind === "challenge_raiser") {
      const digest = computeChallengeRequestDigest(run, invocation, {
        diagnostic_trace: trace,
        repair_attempt: repair,
      });
      if (digest !== null) invocation.challenge_request_digest = digest;
      delete invocation.resolution_request_digest;
    } else if (invocation.invocation_kind === "challenge_resolver") {
      const digest = computeChallengeResolutionRequestDigest(
        run,
        invocation,
        {
          diagnostic_trace: trace,
          repair_attempt: repair,
        },
      );
      if (digest !== null) invocation.resolution_request_digest = digest;
      delete invocation.challenge_request_digest;
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
  delete run.evaluation_manifest.expected_case_ids.challenges;
  delete run.evaluation_manifest.expected_case_digests.challenges;
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
    frozen_before_candidate_generation:
      run.evaluation_manifest.frozen_before_candidate_generation,
    coverage_rule: run.evaluation_manifest.coverage_rule,
    commitment_rule: run.evaluation_manifest.commitment_rule,
  });

  const traceDigest = sha256Json(trace);
  repair.diagnostic_trace_ref.digest = traceDigest;
  run.diagnostic_trace_ref.digest = traceDigest;
  policy.conformance_examples.diagnostic_trace.digest = traceDigest;

  const repairDigest = sha256Json(repair);
  run.repair_attempt_ref.digest = repairDigest;
  run.promotion_artifact.source_ref.digest = repairDigest;
  policy.conformance_examples.repair_attempt.digest = repairDigest;
  const inputDigest = computeRepeatInputDigest(policy, run, {
    diagnostic_trace: trace,
    repair_attempt: repair,
    taxonomy,
  });
  for (const repeat of run.repeat_manifest) {
    repeat.input_digest = inputDigest;
    repeat.run_digest = computeRepeatRunDigest(run, repeat);
  }
  policy.conformance_examples.verification_run.digest = sha256Json(run);
}

function evaluateBundle({
  policy,
  trace,
  repair,
  run,
  taxonomy,
  trustRoot,
  receipt,
}) {
  return evaluatePromotion(policy, run, {
    diagnostic_trace: trace,
    repair_attempt: repair,
    taxonomy,
  }, trustRoot, receipt);
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

function makeRunReceipt({
  policy,
  trace,
  repair,
  run,
  taxonomy,
  trustRoot,
}) {
  const sign = (payload) => ({
    key_id: "key.test.ed25519.v1",
    algorithm: "Ed25519",
    value: signPayload(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      TEST_PRIVATE_KEY,
    ).toString("base64"),
  });
  const traceIsolationDigest = sha256Json(trace.identity_isolation);
  const experimentPlanDigest = computeExperimentPlanDigest(
    trace.experiment_ledger,
  );
  const outputTurnIds = [...trace.subject.generator_output_turn_ids];
  const generationPrecommits = outputTurnIds.map((outputTurnId, index) => {
    const outputTurn = trace.subject.turns.find(
      (turn) => turn.turn_id === outputTurnId,
    );
    const scene = trace.subject.scenes.find(
      (item) => item.scene_id === outputTurn?.scene_id,
    );
    const precommit = {
      generation_request_id: `generation-request.test.${index + 1}`,
      single_use_nonce: sha256Text(`generation-nonce:${outputTurnId}`),
      subject_record_id: trace.subject.record_id,
      output_turn_id: outputTurnId,
      scene_id: scene.scene_id,
      input_digest: computeGenerationInputDigest(trace, outputTurnId),
      scene_contract_digest: scene.contract_digest,
      generator_actor_digest: sha256Json(trace.actors.generator),
      contract_critic_actor_digest: sha256Json(
        trace.actors.contract_critic,
      ),
      policy_digest: policy.policy_digest,
      taxonomy_digest: sha256Json(taxonomy),
      trust_root_id: trustRoot.trust_root_id,
      trust_root_digest: sha256Json(trustRoot),
      experiment_plan_digest: experimentPlanDigest,
      trace_identity_isolation_digest: traceIsolationDigest,
      issued_at: new Date(Date.parse(outputTurn.created_at) - 1_000).toISOString(),
      issuer_id: "orchestrator.test.v1",
    };
    precommit.signature = sign(generationPrecommitPayload(precommit));
    return precommit;
  });
  const generationByTurn = new Map(
    generationPrecommits.map((item) => [item.output_turn_id, item]),
  );
  const diagnosticPrecommits = outputTurnIds.map((outputTurnId, index) => {
    const outputTurn = trace.subject.turns.find(
      (turn) => turn.turn_id === outputTurnId,
    );
    const relevantTestTimes = (trace.findings ?? []).flatMap((finding) =>
      (finding.taxonomy_test_results ?? [])
        .filter(
          (result) =>
            result.execution?.intervention?.target_turn_id === outputTurnId,
        )
        .map((result) => Date.parse(result.execution.executed_at)),
    );
    const earliestTestAt = Math.min(...relevantTestTimes);
    const outputAt = Date.parse(outputTurn.created_at);
    const diagnosticAt = Number.isFinite(earliestTestAt)
      ? outputAt + Math.max(1, Math.floor((earliestTestAt - outputAt) / 2))
      : outputAt + 1;
    const precommit = {
      diagnostic_request_id: `diagnostic-request.test.${index + 1}`,
      single_use_nonce: sha256Text(`diagnostic-nonce:${outputTurnId}`),
      generation_request_id:
        generationByTurn.get(outputTurnId).generation_request_id,
      output_turn_id: outputTurnId,
      output_digest: sha256Text(outputTurn.content),
      critic_actor_digest: sha256Json(trace.actors.critic),
      test_judge_actor_digest: sha256Json(trace.actors.test_judge),
      taxonomy_digest: sha256Json(taxonomy),
      experiment_plan_digest: experimentPlanDigest,
      trace_identity_isolation_digest: traceIsolationDigest,
      issued_at: new Date(diagnosticAt).toISOString(),
      issuer_id: "orchestrator.test.v1",
    };
    precommit.signature = sign(diagnosticPrecommitPayload(precommit));
    return precommit;
  });
  const receipt = {
    record_type: "promotion_run_receipt",
    schema_version: "1.1.0",
    generation_precommits: generationPrecommits,
    diagnostic_precommits: diagnosticPrecommits,
    receipt_id: "receipt.test.v1",
    run_request_id: "request.test.v1",
    single_use_nonce: "c".repeat(64),
    policy_digest: policy.policy_digest,
    taxonomy_digest: sha256Json(taxonomy),
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
  receipt.signature = sign(promotionRunReceiptPayload(receipt));
  receipt.verification_precommit = {
    verification_request_id: "verification-request.test.v1",
    single_use_nonce: sha256Text("verification-nonce:test.v1"),
    repair_attempt_digest: sha256Json(repair),
    baseline_digest: repair.candidates.baseline.digest,
    candidate_digest: repair.candidates.candidate.digest,
    manifest_digest: run.evaluation_manifest.manifest_digest,
    repeat_input_digest: computeRepeatInputDigest(policy, run, {
      diagnostic_trace: trace,
      repair_attempt: repair,
      taxonomy,
    }),
    repeat_plan_digest: computeRepeatPlanDigest(run),
    judge_actor_set_digest: computeJudgeActorSetDigest(run),
    blinding_mapping_digest: run.blinding.mapping_digest,
    issued_at: "2026-08-24T10:05:30Z",
    issuer_id: "orchestrator.test.v1",
  };
  receipt.verification_precommit.signature = sign(
    verificationPrecommitPayload(receipt),
  );
  receipt.completion = {
    completed_at: "2026-08-24T10:08:00Z",
    diagnostic_trace_digest: sha256Json(trace),
    repair_attempt_digest: sha256Json(repair),
    verification_run_digest: computeVerificationRunAttestationDigest(run),
    candidate_digest: repair.candidates.candidate.digest,
  };
  receipt.completion.signature = sign(promotionRunCompletionPayload(receipt));
  assert.ok(Date.parse(receipt.issued_at) < Date.parse(repair.provenance.created_at));
  return receipt;
}

function validateArtifactBundle({
  policy,
  trace,
  repair,
  run,
  taxonomy,
  trustRoot,
  receipt,
}) {
  return validateMachineArtifacts({
    schemas: structuredClone(schemas),
    examples: [
      { filename: "policy.test.json", data: policy },
      { filename: "trace.test.json", data: trace },
      { filename: "repair.test.json", data: repair },
      { filename: "run.test.json", data: run },
    ],
    taxonomyVersion: taxonomy.taxonomy_version,
    taxonomy,
    trustRoot,
    runReceipt: receipt,
  });
}

function assertIndependentSupportError(result) {
  assert.ok(
    result.errors.some(
      (error) =>
        error.rule === "R10" && error.message.includes("独立症状证据组"),
    ),
    JSON.stringify(result.errors, null, 2),
  );
}

function makeSymptomFinding({ findingId, labelId, turnId, content }) {
  const evidence = makeEvidencePair(findingId, turnId, content);
  const taxonomyTest = symptomById.get(labelId)?.discriminating_tests?.[0];
  assert.ok(taxonomyTest, `Missing taxonomy discriminating test for ${labelId}`);
  const executionId = `testexec.${findingId}`;
  const taxonomyTestResult = {
    recipe_id: "synthetic_non_promoting_v1",
    taxonomy_test: taxonomyTest,
    outcome: "passed",
    rationale: "Synthetic fixture executes a schema-complete boundary test.",
    evidence_ids: [evidence[1].evidence_id],
    execution: {
      execution_id: executionId,
      method: "deterministic_text_edit",
      input_turn_ids: [turnId],
      input_digest: "0".repeat(64),
      scene_contract_digest: "0".repeat(64),
      judge_actor_id: "actor.test-judge-01",
      executed_at: "2026-08-24T10:00:00Z",
      intervention: {
        kind: "no_text_change",
        target_turn_id: turnId,
        instruction: taxonomyTest,
        replacement_text: "",
      },
      output: {
        content,
        digest: sha256Text(content),
      },
      judgment: {
        target_status_before: "present",
        target_status_after: "absent",
        neighbor_statuses_before: [
          {
            label_id: "premature_affective_closure",
            status: "absent",
            rationale: "Synthetic schema-complete neighboring-label status.",
          },
        ],
        invariants: [
          {
            invariant_id: `invariant.${findingId}`,
            claim: "The cited synthetic evidence remains addressable.",
            status: "passed",
            source_kind: "finding_evidence",
            evidence_ids: [evidence[1].evidence_id],
          },
        ],
        rationale: "Synthetic schema-complete judgment.",
      },
      execution_digest: "0".repeat(64),
    },
  };
  const finding = {
    finding_id: findingId,
    label_id: labelId,
    label_kind: "symptom",
    status: "present",
    scope: "turn",
    confidence: 0.9,
    evidence,
    taxonomy_test_results: [taxonomyTestResult],
    neighboring_label_rebuttals: [
      {
        label_id: "premature_affective_closure",
        verdict: "rebutted",
        reason: "Synthetic validator fixture with a distinct neighboring label.",
        discriminating_test: "The neighboring label should not explain this fixture.",
        test_execution_id: executionId,
        evidence_ids: [evidence[1].evidence_id],
      },
    ],
    failure_mechanism: "Synthetic observable failure mechanism.",
    repair_objective: "Preserve the source while correcting the synthetic failure.",
  };
  taxonomyTestResult.execution.execution_digest =
    computeTaxonomyTestExecutionDigest({
      finding,
      result: taxonomyTestResult,
      taxonomy: taxonomyExample,
      recipe: null,
    });
  return finding;
}

function makeCausalFinding({
  findingId,
  labelId = "closure_drive",
  supportingFindingIds,
  turnId,
  content,
}) {
  const evidence = makeEvidencePair(findingId, turnId, content);
  return {
    finding_id: findingId,
    label_id: labelId,
    label_kind: "causal_hypothesis",
    status: "present",
    scope: "conversation",
    confidence: 0.8,
    evidence,
    supporting_finding_ids: supportingFindingIds,
    failure_mechanism: "Synthetic causal hypothesis for support grouping.",
    repair_objective: "Do not promote a causal claim from dependent symptoms.",
  };
}

function makeEvidencePair(prefix, turnId, content) {
  const codepoints = [...content];
  assert.ok(codepoints.length >= 2);
  return [
    {
      evidence_id: `evidence.${prefix}.refute`,
      source_record_id: "subject.scene-001",
      turn_id: turnId,
      span: { start: 0, end: 1, unit: "unicode_codepoint" },
      quote: codepoints[0],
      stance: "refutes",
      rationale: "Synthetic counterevidence for schema-complete validation.",
    },
    {
      evidence_id: `evidence.${prefix}.support`,
      source_record_id: "subject.scene-001",
      turn_id: turnId,
      span: { start: 1, end: 2, unit: "unicode_codepoint" },
      quote: codepoints[1],
      stance: "supports",
      rationale: "Synthetic supporting evidence for schema-complete validation.",
    },
  ];
}

function addTurn(trace, turnId, content, sceneId = "scene.scene-001") {
  trace.subject.turns.push({
    turn_id: turnId,
    scene_id: sceneId,
    speaker: "assistant",
    content,
    created_at: "2026-08-24T09:59:59Z",
  });
  trace.subject.generator_output_turn_ids.push(turnId);
  let scene = trace.subject.scenes.find((item) => item.scene_id === sceneId);
  if (!scene) {
    const contract = structuredClone(trace.scene_contract);
    contract.intent = `${contract.intent} [${sceneId}]`;
    scene = {
      scene_id: sceneId,
      contract,
      contract_digest: sha256Json(contract),
      turn_ids: [],
    };
    trace.subject.scenes.push(scene);
  }
  scene.turn_ids.push(turnId);
}

function assertReason(result, reason) {
  assert.ok(
    result.reason_codes.includes(reason),
    `Expected ${reason}; observed ${result.reason_codes.join(", ")}`,
  );
}

function readExample(filename) {
  return readJson(
    join(REPOSITORY_ROOT, "examples", "machine-only", filename),
  );
}

function loadFiles(directory, suffix) {
  return readdirSync(directory)
    .filter((filename) => filename.endsWith(suffix))
    .map((filename) => ({
      filename,
      data: readJson(join(directory, filename)),
    }));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
