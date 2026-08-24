import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_POLICY,
  evaluatePromotion,
  normalizePolicy,
  validateGateInputSchemas,
} from "../lib/evolution-gate.js";

const root = new URL("../", import.meta.url);
const policyExample = readJson(
  new URL("examples/machine-only/evolution-policy.example.json", root),
);
const runExample = readJson(
  new URL("examples/machine-only/verification-run.example.json", root),
);

test("a canonical run with verified provenance is adopted", () => {
  const { policy, run } = inputs();
  const result = evaluatePromotion(policy, run);

  assert.equal(validateGateInputSchemas(policy, run).valid, true);
  assert.equal(result.status, "adopted");
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

test("different weights digests take precedence over a shared model label", () => {
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
  assert.equal(result.status, "adopted");
  assert.equal(result.metrics.independent_judges.observed, 2);
});

test("an empty completed challenge round is valid but a skipped round is not", () => {
  const empty = inputs();
  empty.run.challenges = [];
  assert.equal(evaluatePromotion(empty.policy, empty.run).status, "adopted");

  const skipped = inputs();
  skipped.run.challenge_round_completed = false;
  const skippedResult = evaluatePromotion(skipped.policy, skipped.run);
  assert.equal(skippedResult.status, "inconclusive");
  assert.ok(skippedResult.reason_codes.includes("CHALLENGE_ROUND_INCOMPLETE"));
});

test("identical candidate artifacts and hard regression vetoes reject", () => {
  const identical = inputs();
  identical.run.candidates.candidate.digest =
    identical.run.candidates.baseline.digest;
  const identicalResult = evaluatePromotion(identical.policy, identical.run);
  assert.equal(identicalResult.status, "rejected");
  assert.ok(
    identicalResult.reason_codes.includes("CANDIDATE_ARTIFACT_UNCHANGED"),
  );

  const vetoed = inputs();
  vetoed.policy.policy.thresholds.max_regression_failure_rate = 1;
  vetoed.run.regression_checks[0].passed = false;
  vetoed.run.regression_checks[0].hard_veto = true;
  vetoed.run.aggregation.regression_failure_rate = 0.5;
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
  run.challenges = [
    {
      challenge_id: "challenge.blocking-001",
      raised_by: "actor.judge-01",
      severity: "blocking",
      claim: "The repair violates a frozen scene boundary.",
      response: "The counterexample remains unresolved.",
      resolved: false,
    },
  ];

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

  const persists = inputs();
  persists.run.target_failure_checks[0].candidate_present = true;
  const persistsResult = evaluatePromotion(persists.policy, persists.run);
  assert.equal(persistsResult.status, "rejected");
  assert.ok(persistsResult.reason_codes.includes("TARGET_FAILURE_PERSISTS"));
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
