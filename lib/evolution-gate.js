import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const POLICY_SCHEMA_ID =
  "https://yuqing-cai.github.io/cn-failure-atlas/schemas/evolution-policy.schema.json";

const { validatePolicySchema, validateVerificationRunSchema } =
  compileGateSchemas();

export const DEFAULT_POLICY = deepFreeze({
  thresholds: {
    min_independent_judges: 2,
    min_evidence_coverage: 0.8,
    min_counterfactual_pass_rate: 0.8,
    max_regression_failure_rate: 0.05,
    min_repeat_runs: 2,
  },
  requirements: {
    generator_judge_origin_separation: true,
    distinct_judge_origins: true,
    order_swap: true,
    candidate_preferred: true,
    high_severity_levels: ["blocking", "major"],
  },
});

const REASON_ORDER = [
  "INVALID_POLICY",
  "INVALID_VERIFICATION_RUN",
  "POLICY_NOT_EXECUTABLE",
  "UNSUPPORTED_EXECUTION_MODE",
  "UNVERIFIED_PROVENANCE",
  "POLICY_REFERENCE_MISMATCH",
  "POLICY_VERSION_MISMATCH",
  "POLICY_SCHEMA_VERSION_MISMATCH",
  "PROMOTION_TARGET_NOT_ALLOWED",
  "ACTOR_PROFILE_MISMATCH",
  "DUPLICATE_JUDGE_ID",
  "MISSING_GENERATOR_IDENTITY",
  "JUDGE_ORIGIN_MISSING",
  "INSUFFICIENT_INDEPENDENT_JUDGES",
  "GENERATOR_AS_JUDGE",
  "GENERATOR_ORIGIN_AS_JUDGE",
  "JUDGES_SHARE_ORIGIN",
  "BLINDING_REQUIREMENTS_NOT_MET",
  "CANDIDATE_ARTIFACT_UNCHANGED",
  "REPEAT_MANIFEST_MISMATCH",
  "DUPLICATE_REPEAT_SEED",
  "DUPLICATE_REPEAT_DIGEST",
  "REPEAT_RUN_COUNT_MISMATCH",
  "UNKNOWN_TRIAL_JUDGE",
  "DUPLICATE_TRIAL_ID",
  "DUPLICATE_ORDER_TRIAL",
  "ORDER_SWAP_MISSING",
  "TRIAL_RESULT_MISMATCH",
  "ORDER_CONCLUSION_MISMATCH",
  "CANDIDATE_NOT_PREFERRED",
  "ORDER_RESULT_TIED",
  "UNKNOWN_CHECK_JUDGE",
  "DUPLICATE_CHECK_ID",
  "TARGET_FAILURE_NOT_ESTABLISHED",
  "TARGET_FAILURE_NOT_REDUCED",
  "TARGET_FAILURE_PERSISTS",
  "AGGREGATION_MISMATCH",
  "EVIDENCE_CHECKS_MISSING",
  "INSUFFICIENT_EVIDENCE_COVERAGE",
  "COUNTERFACTUAL_CHECKS_MISSING",
  "COUNTERFACTUAL_PASS_RATE_BELOW_MINIMUM",
  "REGRESSION_CHECKS_MISSING",
  "CONTAMINATED_REGRESSION_EVIDENCE",
  "HARD_REGRESSION_VETO",
  "REGRESSION_FAILURE_RATE_EXCEEDED",
  "CHALLENGE_ROUND_INCOMPLETE",
  "UNKNOWN_CHALLENGE_RAISER",
  "UNRESOLVED_HIGH_SEVERITY_CHALLENGE",
  "INSUFFICIENT_REPEAT_RUNS",
  "ALL_ADOPTION_GATES_PASSED",
];

const INCONCLUSIVE_REASONS = new Set([
  "INVALID_POLICY",
  "INVALID_VERIFICATION_RUN",
  "POLICY_NOT_EXECUTABLE",
  "UNSUPPORTED_EXECUTION_MODE",
  "UNVERIFIED_PROVENANCE",
  "POLICY_REFERENCE_MISMATCH",
  "POLICY_VERSION_MISMATCH",
  "POLICY_SCHEMA_VERSION_MISMATCH",
  "PROMOTION_TARGET_NOT_ALLOWED",
  "ACTOR_PROFILE_MISMATCH",
  "DUPLICATE_JUDGE_ID",
  "MISSING_GENERATOR_IDENTITY",
  "JUDGE_ORIGIN_MISSING",
  "INSUFFICIENT_INDEPENDENT_JUDGES",
  "BLINDING_REQUIREMENTS_NOT_MET",
  "REPEAT_MANIFEST_MISMATCH",
  "DUPLICATE_REPEAT_SEED",
  "DUPLICATE_REPEAT_DIGEST",
  "REPEAT_RUN_COUNT_MISMATCH",
  "UNKNOWN_TRIAL_JUDGE",
  "DUPLICATE_TRIAL_ID",
  "DUPLICATE_ORDER_TRIAL",
  "ORDER_SWAP_MISSING",
  "TRIAL_RESULT_MISMATCH",
  "UNKNOWN_CHECK_JUDGE",
  "DUPLICATE_CHECK_ID",
  "TARGET_FAILURE_NOT_ESTABLISHED",
  "AGGREGATION_MISMATCH",
  "EVIDENCE_CHECKS_MISSING",
  "INSUFFICIENT_EVIDENCE_COVERAGE",
  "COUNTERFACTUAL_CHECKS_MISSING",
  "REGRESSION_CHECKS_MISSING",
  "CONTAMINATED_REGRESSION_EVIDENCE",
  "CHALLENGE_ROUND_INCOMPLETE",
  "UNKNOWN_CHALLENGE_RAISER",
]);

const REJECTION_REASONS = new Set([
  "GENERATOR_AS_JUDGE",
  "GENERATOR_ORIGIN_AS_JUDGE",
  "JUDGES_SHARE_ORIGIN",
  "CANDIDATE_ARTIFACT_UNCHANGED",
  "TARGET_FAILURE_NOT_REDUCED",
  "TARGET_FAILURE_PERSISTS",
  "ORDER_CONCLUSION_MISMATCH",
  "CANDIDATE_NOT_PREFERRED",
  "ORDER_RESULT_TIED",
  "COUNTERFACTUAL_PASS_RATE_BELOW_MINIMUM",
  "HARD_REGRESSION_VETO",
  "REGRESSION_FAILURE_RATE_EXCEEDED",
  "UNRESOLVED_HIGH_SEVERITY_CHALLENGE",
]);

export function validateGateInputSchemas(policyInput, verificationRunInput) {
  const policy = runSchemaValidator(validatePolicySchema, policyInput);
  const verificationRun = runSchemaValidator(
    validateVerificationRunSchema,
    verificationRunInput,
  );
  return {
    valid: policy.valid && verificationRun.valid,
    policy,
    verification_run: verificationRun,
  };
}

export function normalizePolicy(input) {
  const validation = runSchemaValidator(validatePolicySchema, input);
  if (!validation.valid) {
    const error = new TypeError(
      `policy does not satisfy evolution-policy.schema.json: ${formatSchemaErrors(validation.errors)}`,
    );
    error.schema_errors = validation.errors;
    throw error;
  }
  return normalizeValidatedPolicy(input);
}

export function evaluatePromotion(policyInput, verificationRunInput) {
  const schemaValidation = validateGateInputSchemas(
    policyInput,
    verificationRunInput,
  );
  if (!schemaValidation.policy.valid) {
    return invalidDecision(
      "INVALID_POLICY",
      schemaValidation.policy.errors,
      policyInput,
      verificationRunInput,
    );
  }

  const policy = normalizeValidatedPolicy(policyInput);
  if (!schemaValidation.verification_run.valid) {
    return invalidDecision(
      "INVALID_VERIFICATION_RUN",
      schemaValidation.verification_run.errors,
      policyInput,
      verificationRunInput,
      policy,
    );
  }

  const run = verificationRunInput;
  const reasons = new Set();
  if (policy.status !== "promoted") reasons.add("POLICY_NOT_EXECUTABLE");
  if (
    policy.mode !== "machine_only" ||
    run.mode !== "machine_only" ||
    run.mode !== policy.mode
  ) {
    reasons.add("UNSUPPORTED_EXECUTION_MODE");
  }
  const policyProvenanceVerified =
    policyInput.provenance.digest_status === "verified";
  const runProvenanceVerified = run.provenance.digest_status === "verified";
  const provenanceVerified =
    policyProvenanceVerified && runProvenanceVerified;
  if (!provenanceVerified) reasons.add("UNVERIFIED_PROVENANCE");

  const policyReference = run.policy_ref;
  const policyIdMatches = policyReference.record_id === policy.id;
  const policyVersionMatches = policyReference.policy_version === policy.version;
  const policySchemaVersionMatches =
    policyReference.schema_version === policy.schema_version &&
    policyReference.schema_id === POLICY_SCHEMA_ID;
  if (!policyIdMatches) reasons.add("POLICY_REFERENCE_MISMATCH");
  if (!policyVersionMatches) reasons.add("POLICY_VERSION_MISMATCH");
  if (!policySchemaVersionMatches) reasons.add("POLICY_SCHEMA_VERSION_MISMATCH");

  const targetAllowed = policy.promotion_targets.includes(run.promotion_target);
  if (!targetAllowed) reasons.add("PROMOTION_TARGET_NOT_ALLOWED");

  const generator = run.generator;
  const judges = [...run.judges].sort(compareActors);
  const judgeIds = judges.map((judge) => judge.id);
  const duplicateJudgeIds = findDuplicates(judgeIds);
  if (duplicateJudgeIds.length > 0) reasons.add("DUPLICATE_JUDGE_ID");
  if (!generator.id || !generator.origin) reasons.add("MISSING_GENERATOR_IDENTITY");

  const judgesMissingOrigin = judges
    .filter((judge) => !judge.origin)
    .map((judge) => judge.id || "<missing-id>")
    .sort();
  if (judgesMissingOrigin.length > 0) reasons.add("JUDGE_ORIGIN_MISSING");

  const actorProfileMetric = analyzeActorProfiles(run, generator, judges);
  if (!actorProfileMetric.pass) reasons.add("ACTOR_PROFILE_MISMATCH");

  const generatorIdConflicts = judges
    .filter((judge) => judge.id === generator.id)
    .map((judge) => judge.id)
    .sort();
  if (generatorIdConflicts.length > 0) reasons.add("GENERATOR_AS_JUDGE");

  const generatorOriginConflicts = judges
    .filter((judge) => originsEquivalent(generator.origin, judge.origin))
    .map((judge) => judge.id)
    .sort();
  if (generatorOriginConflicts.length > 0) reasons.add("GENERATOR_ORIGIN_AS_JUDGE");

  const originComponents = groupActorsByOrigin(judges);
  const sharedJudgeOrigins = originComponents
    .filter((component) => component.length > 1)
    .map((component) => ({
      origin: describeOriginGroup(component.map((actor) => actor.origin)),
      judge_ids: component.map((actor) => actor.id).sort(),
    }))
    .sort((left, right) => left.origin.localeCompare(right.origin));
  if (sharedJudgeOrigins.length > 0) reasons.add("JUDGES_SHARE_ORIGIN");

  const independentJudgeCount = originComponents.length;
  if (independentJudgeCount < policy.thresholds.min_independent_judges) {
    reasons.add("INSUFFICIENT_INDEPENDENT_JUDGES");
  }

  const blindingMetric = {
    pass:
      run.blinding.candidate_origin_hidden === true &&
      run.blinding.model_identity_hidden === true &&
      run.blinding.judge_contexts_reset_between_orders === true,
    candidate_origin_hidden: run.blinding.candidate_origin_hidden,
    model_identity_hidden: run.blinding.model_identity_hidden,
    judge_contexts_reset_between_orders:
      run.blinding.judge_contexts_reset_between_orders,
  };
  if (!blindingMetric.pass) reasons.add("BLINDING_REQUIREMENTS_NOT_MET");

  const candidateDistinct =
    run.candidates.baseline.digest !== run.candidates.candidate.digest;
  if (!candidateDistinct) reasons.add("CANDIDATE_ARTIFACT_UNCHANGED");

  const orderMetric = analyzeOrderTrials(run, judgeIds);
  const repeatManifestMetric = analyzeRepeatManifest(
    run.repeat_manifest,
    orderMetric.actual_repeat_ids,
    run.repeat_runs,
  );
  if (!repeatManifestMetric.ids_match || !repeatManifestMetric.count_matches) {
    reasons.add("REPEAT_MANIFEST_MISMATCH");
  }
  if (repeatManifestMetric.duplicate_seeds.length > 0) {
    reasons.add("DUPLICATE_REPEAT_SEED");
  }
  if (repeatManifestMetric.duplicate_run_digests.length > 0) {
    reasons.add("DUPLICATE_REPEAT_DIGEST");
  }
  if (!orderMetric.repeat_count_matches) reasons.add("REPEAT_RUN_COUNT_MISMATCH");
  if (orderMetric.unknown_judge_ids.length > 0) reasons.add("UNKNOWN_TRIAL_JUDGE");
  if (orderMetric.duplicate_trial_ids.length > 0) reasons.add("DUPLICATE_TRIAL_ID");
  if (orderMetric.duplicate_slots.length > 0) reasons.add("DUPLICATE_ORDER_TRIAL");
  if (orderMetric.missing_slots.length > 0) reasons.add("ORDER_SWAP_MISSING");
  if (orderMetric.result_mismatches.length > 0) reasons.add("TRIAL_RESULT_MISMATCH");
  if (orderMetric.inconsistent_pairs.length > 0) reasons.add("ORDER_CONCLUSION_MISMATCH");
  if (orderMetric.baseline_pairs.length > 0) reasons.add("CANDIDATE_NOT_PREFERRED");
  if (orderMetric.tie_pairs.length > 0) reasons.add("ORDER_RESULT_TIED");
  if (orderMetric.actual_repeat_count < policy.thresholds.min_repeat_runs) {
    reasons.add("INSUFFICIENT_REPEAT_RUNS");
  }

  const checkReferenceMetric = analyzeCheckReferences(
    run,
    new Set(judgeIds),
    new Set(orderMetric.participating_judge_ids),
  );
  if (checkReferenceMetric.unknown_or_inactive.length > 0) reasons.add("UNKNOWN_CHECK_JUDGE");
  if (checkReferenceMetric.duplicate_check_ids.length > 0) reasons.add("DUPLICATE_CHECK_ID");

  const targetFailureMetric = analyzeTargetFailureChecks(
    run.target_failure_checks,
  );
  if (targetFailureMetric.baseline_not_established.length > 0) {
    reasons.add("TARGET_FAILURE_NOT_ESTABLISHED");
  }
  if (targetFailureMetric.evidence_not_reduced.length > 0) {
    reasons.add("TARGET_FAILURE_NOT_REDUCED");
  }
  if (targetFailureMetric.failure_persists.length > 0) {
    reasons.add("TARGET_FAILURE_PERSISTS");
  }

  const evidenceMetric = measureBooleanRatio(
    run.evidence_checks,
    "covered",
    policy.thresholds.min_evidence_coverage,
    "minimum",
  );
  if (!evidenceMetric.available) reasons.add("EVIDENCE_CHECKS_MISSING");
  else if (!evidenceMetric.pass) reasons.add("INSUFFICIENT_EVIDENCE_COVERAGE");

  const counterfactualMetric = measureBooleanRatio(
    run.counterfactual_checks,
    "passed",
    policy.thresholds.min_counterfactual_pass_rate,
    "minimum",
  );
  if (!counterfactualMetric.available) reasons.add("COUNTERFACTUAL_CHECKS_MISSING");
  else if (!counterfactualMetric.pass) reasons.add("COUNTERFACTUAL_PASS_RATE_BELOW_MINIMUM");

  const regressionMetric = measureRegressionRatio(
    run.regression_checks,
    policy.thresholds.max_regression_failure_rate,
  );
  if (!regressionMetric.available) reasons.add("REGRESSION_CHECKS_MISSING");
  else if (!regressionMetric.pass) reasons.add("REGRESSION_FAILURE_RATE_EXCEEDED");
  const hardRegressionFailures = run.regression_checks
    .filter((check) => check.hard_veto && !check.passed)
    .map((check) => check.check_id)
    .sort();
  if (hardRegressionFailures.length > 0) reasons.add("HARD_REGRESSION_VETO");
  const contaminatedRegressionChecks = run.regression_checks
    .filter((check) => check.contamination_status === "contaminated")
    .map((check) => check.check_id)
    .sort();
  if (contaminatedRegressionChecks.length > 0) {
    reasons.add("CONTAMINATED_REGRESSION_EVIDENCE");
  }

  const aggregationMetric = analyzeAggregation(
    run,
    orderMetric,
    evidenceMetric,
    counterfactualMetric,
    regressionMetric,
  );
  if (!aggregationMetric.pass) reasons.add("AGGREGATION_MISMATCH");

  const challengeRoundMetric = {
    completed: run.challenge_round_completed === true,
    pass: run.challenge_round_completed === true,
    challenges_observed: run.challenges.length,
  };
  if (!challengeRoundMetric.pass) reasons.add("CHALLENGE_ROUND_INCOMPLETE");

  const participatingJudges = new Set(orderMetric.participating_judge_ids);
  const declaredCritics = new Set(
    (run.actor_profiles.critics ?? []).map((critic) => critic.id),
  );
  const unknownChallengeRaisers = [
    ...new Set(
      run.challenges
        .map((challenge) => challenge.raised_by)
        .filter(
          (actorId) =>
            !participatingJudges.has(actorId) && !declaredCritics.has(actorId),
        ),
    ),
  ].sort();
  if (unknownChallengeRaisers.length > 0) {
    reasons.add("UNKNOWN_CHALLENGE_RAISER");
  }

  const highSeveritySet = new Set(DEFAULT_POLICY.requirements.high_severity_levels);
  const unresolvedHighSeverityChallenges = run.challenges
    .filter(
      (challenge) =>
        highSeveritySet.has(challenge.severity) && challenge.resolved === false,
    )
    .map((challenge) => challenge.challenge_id)
    .sort();
  if (unresolvedHighSeverityChallenges.length > 0) {
    reasons.add("UNRESOLVED_HIGH_SEVERITY_CHALLENGE");
  }

  const orderedReasons = sortReasonCodes(reasons);
  const status = chooseStatus(orderedReasons);
  const reasonCodes = status === "adopted" ? ["ALL_ADOPTION_GATES_PASSED"] : orderedReasons;

  return {
    decision_version: "1.0.0",
    run_id: run.verification_id,
    policy_id: policy.id,
    status,
    reason_codes: reasonCodes,
    metrics: {
      provenance: {
        pass: provenanceVerified,
        policy_digest_status: policyInput.provenance.digest_status,
        verification_digest_status: run.provenance.digest_status,
      },
      policy_binding: {
        pass:
          policy.status === "promoted" &&
          policyIdMatches &&
          policyVersionMatches &&
          policySchemaVersionMatches &&
          targetAllowed,
        executable_status: policy.status,
        policy_id_matches: policyIdMatches,
        policy_version_matches: policyVersionMatches,
        policy_schema_version_matches: policySchemaVersionMatches,
        promotion_target: run.promotion_target,
        promotion_target_allowed: targetAllowed,
      },
      actor_profiles: actorProfileMetric,
      generator_judge_separation: {
        pass:
          generatorIdConflicts.length === 0 &&
          generatorOriginConflicts.length === 0,
        generator_id_conflicts: [...new Set(generatorIdConflicts)].sort(),
        generator_origin_conflicts: [...new Set(generatorOriginConflicts)].sort(),
      },
      independent_judges: {
        observed: independentJudgeCount,
        required: policy.thresholds.min_independent_judges,
        pass:
          independentJudgeCount >= policy.thresholds.min_independent_judges &&
          sharedJudgeOrigins.length === 0 &&
          judgesMissingOrigin.length === 0 &&
          duplicateJudgeIds.length === 0,
        missing_origin_judge_ids: judgesMissingOrigin,
        duplicate_judge_ids: duplicateJudgeIds,
        shared_origins: sharedJudgeOrigins,
      },
      blinding: blindingMetric,
      candidate_distinct: { pass: candidateDistinct },
      order_swap: orderMetric,
      repeat_manifest: repeatManifestMetric,
      check_references: checkReferenceMetric,
      target_failure_reduction: targetFailureMetric,
      evidence_coverage: evidenceMetric,
      counterfactual_pass_rate: counterfactualMetric,
      regression_failure_rate: regressionMetric,
      hard_regression_veto: {
        pass: hardRegressionFailures.length === 0,
        failed_check_ids: hardRegressionFailures,
      },
      regression_contamination: {
        pass: contaminatedRegressionChecks.length === 0,
        contaminated_check_ids: contaminatedRegressionChecks,
      },
      aggregation_consistency: aggregationMetric,
      repeat_runs: {
        observed: orderMetric.actual_repeat_count,
        declared: run.repeat_runs,
        required: policy.thresholds.min_repeat_runs,
        pass:
          orderMetric.repeat_count_matches &&
          orderMetric.actual_repeat_count >= policy.thresholds.min_repeat_runs,
        ids: orderMetric.actual_repeat_ids,
      },
      challenge_round: challengeRoundMetric,
      challenge_raisers: {
        pass: unknownChallengeRaisers.length === 0,
        unknown_actor_ids: unknownChallengeRaisers,
      },
      unresolved_high_severity_challenges: {
        observed: unresolvedHighSeverityChallenges.length,
        required: 0,
        pass: unresolvedHighSeverityChallenges.length === 0,
        challenge_ids: unresolvedHighSeverityChallenges,
      },
    },
  };
}

function compileGateSchemas() {
  const readSchema = (filename) =>
    JSON.parse(
      readFileSync(new URL(`../schemas/${filename}`, import.meta.url), "utf8"),
    );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(readSchema("common.schema.json"));
  return {
    validatePolicySchema: ajv.compile(readSchema("evolution-policy.schema.json")),
    validateVerificationRunSchema: ajv.compile(
      readSchema("verification-run.schema.json"),
    ),
  };
}

function runSchemaValidator(validator, value) {
  const valid = validator(value);
  return {
    valid,
    errors: valid
      ? []
      : (validator.errors ?? []).map((error) => ({
          instance_path: error.instancePath || "/",
          keyword: error.keyword,
          message: error.message ?? "schema validation failed",
          params: error.params,
        })),
  };
}

function formatSchemaErrors(errors) {
  return errors
    .map((error) => `${error.instance_path} ${error.message}`)
    .join("; ");
}

function normalizeValidatedPolicy(input) {
  return {
    id: input.policy.id,
    version: input.policy.version,
    schema_version: input.schema_version,
    status: input.policy.status,
    mode: input.mode,
    promotion_targets: [...input.policy.promotion_targets],
    thresholds: { ...input.policy.thresholds },
    requirements: { ...DEFAULT_POLICY.requirements },
  };
}

function invalidDecision(
  reasonCode,
  schemaErrors,
  policyInput,
  runInput,
  normalizedPolicy = null,
) {
  return {
    decision_version: "1.0.0",
    run_id: nonEmptyString(runInput?.verification_id)
      ? runInput.verification_id
      : null,
    policy_id:
      normalizedPolicy?.id ??
      (nonEmptyString(policyInput?.policy?.id) ? policyInput.policy.id : null),
    status: "inconclusive",
    reason_codes: [reasonCode],
    metrics: {},
    error: {
      message: formatSchemaErrors(schemaErrors),
      schema_errors: schemaErrors,
    },
  };
}

function analyzeActorProfiles(run, generator, judges) {
  const profileGenerator = run.actor_profiles.generator;
  const profileJudges = run.actor_profiles.judges;
  const duplicateProfileIds = findDuplicates(
    profileJudges.map((profile) => profile.id),
  );
  const profileById = new Map(
    profileJudges.map((profile) => [profile.id, profile]),
  );
  const mismatchedIds = [];
  if (
    profileGenerator.id !== generator.id ||
    stableStringify(profileGenerator.origin) !== stableStringify(generator.origin)
  ) {
    mismatchedIds.push(generator.id);
  }
  for (const judge of judges) {
    const profile = profileById.get(judge.id);
    if (
      !profile ||
      stableStringify(profile.origin) !== stableStringify(judge.origin)
    ) {
      mismatchedIds.push(judge.id);
    }
  }
  const declaredIds = new Set(judges.map((judge) => judge.id));
  const unexpectedProfileIds = profileJudges
    .map((profile) => profile.id)
    .filter((id) => !declaredIds.has(id))
    .sort();
  return {
    pass:
      mismatchedIds.length === 0 &&
      duplicateProfileIds.length === 0 &&
      unexpectedProfileIds.length === 0,
    mismatched_actor_ids: [...new Set(mismatchedIds)].sort(),
    duplicate_profile_ids: duplicateProfileIds,
    unexpected_profile_ids: unexpectedProfileIds,
  };
}

function analyzeOrderTrials(run, judgeIds) {
  const trials = run.order_trials.map((trial) => ({
    ...trial,
    derived_winner: deriveWinner(trial.raw_choice, run.candidates),
  }));
  const declaredJudgeIds = new Set(judgeIds);
  const actualRepeatIds = [
    ...new Set(trials.map((trial) => trial.repeat_id)),
  ].sort();
  const unknownJudgeIds = [
    ...new Set(
      trials
        .map((trial) => trial.judge_id)
        .filter((judgeId) => !declaredJudgeIds.has(judgeId)),
    ),
  ].sort();
  const duplicateTrialIds = findDuplicates(
    trials.map((trial) => trial.trial_id),
  );
  const participatingJudgeIds = [
    ...new Set(
      trials
        .map((trial) => trial.judge_id)
        .filter((judgeId) => declaredJudgeIds.has(judgeId)),
    ),
  ].sort();
  const resultMismatches = trials
    .filter((trial) => trial.winner !== trial.derived_winner)
    .map((trial) => trial.trial_id)
    .sort();

  const slots = groupBy(
    trials.filter((trial) => declaredJudgeIds.has(trial.judge_id)),
    (trial) => `${trial.repeat_id}\u0000${trial.judge_id}\u0000${trial.order}`,
  );
  const missingSlots = [];
  const duplicateSlots = [];
  const inconsistentPairs = [];
  const candidatePairs = [];
  const baselinePairs = [];
  const tiePairs = [];
  let completePairs = 0;

  for (const repeatId of actualRepeatIds) {
    for (const judgeId of [...judgeIds].sort()) {
      const pairId = `${repeatId}:${judgeId}`;
      const ab = slots.get(`${repeatId}\u0000${judgeId}\u0000AB`) ?? [];
      const ba = slots.get(`${repeatId}\u0000${judgeId}\u0000BA`) ?? [];
      if (ab.length === 0) missingSlots.push(`${pairId}:AB`);
      if (ba.length === 0) missingSlots.push(`${pairId}:BA`);
      if (ab.length > 1) duplicateSlots.push(`${pairId}:AB`);
      if (ba.length > 1) duplicateSlots.push(`${pairId}:BA`);
      if (ab.length !== 1 || ba.length !== 1) continue;
      completePairs += 1;
      if (ab[0].derived_winner !== ba[0].derived_winner) {
        inconsistentPairs.push(pairId);
        continue;
      }
      const winner = ab[0].derived_winner;
      if (winner === "candidate") candidatePairs.push(pairId);
      else if (winner === "baseline") baselinePairs.push(pairId);
      else tiePairs.push(pairId);
    }
  }

  const expectedPairs = actualRepeatIds.length * judgeIds.length;
  const expectedTrials = expectedPairs * 2;
  const repeatCountMatches = actualRepeatIds.length === run.repeat_runs;
  const coveragePass =
    repeatCountMatches &&
    unknownJudgeIds.length === 0 &&
    duplicateTrialIds.length === 0 &&
    missingSlots.length === 0 &&
    duplicateSlots.length === 0 &&
    trials.length === expectedTrials;
  const conclusionPass =
    coveragePass &&
    resultMismatches.length === 0 &&
    inconsistentPairs.length === 0 &&
    baselinePairs.length === 0 &&
    tiePairs.length === 0 &&
    candidatePairs.length === expectedPairs &&
    expectedPairs > 0;

  return {
    required: true,
    trials_observed: trials.length,
    trials_expected: expectedTrials,
    expected_pairs: expectedPairs,
    complete_pairs: completePairs,
    coverage_rate: safeRate(completePairs, expectedPairs),
    coverage_pass: coveragePass,
    conclusion_pass: conclusionPass,
    actual_repeat_count: actualRepeatIds.length,
    actual_repeat_ids: actualRepeatIds,
    repeat_count_matches: repeatCountMatches,
    participating_judge_ids: participatingJudgeIds,
    unknown_judge_ids: unknownJudgeIds,
    duplicate_trial_ids: duplicateTrialIds,
    missing_slots: missingSlots.sort(),
    duplicate_slots: duplicateSlots.sort(),
    result_mismatches: resultMismatches,
    inconsistent_pairs: inconsistentPairs.sort(),
    candidate_pairs: candidatePairs.sort(),
    baseline_pairs: baselinePairs.sort(),
    tie_pairs: tiePairs.sort(),
  };
}

function deriveWinner(rawChoice, candidates) {
  if (rawChoice === "tie") return "tie";
  if (rawChoice === candidates.candidate.blind_alias) return "candidate";
  if (rawChoice === candidates.baseline.blind_alias) return "baseline";
  return null;
}

function analyzeCheckReferences(run, declaredJudgeIds, participatingJudgeIds) {
  const collections = [
    ["evidence_checks", run.evidence_checks],
    ["target_failure_checks", run.target_failure_checks],
    ["counterfactual_checks", run.counterfactual_checks],
    ["regression_checks", run.regression_checks],
  ];
  const checkIds = [];
  const unknownOrInactive = [];
  for (const [collectionName, checks] of collections) {
    for (const check of checks) {
      checkIds.push(check.check_id);
      if (
        !declaredJudgeIds.has(check.judge_id) ||
        !participatingJudgeIds.has(check.judge_id)
      ) {
        unknownOrInactive.push(
          `${collectionName}:${check.check_id}:${check.judge_id}`,
        );
      }
    }
  }
  const duplicateCheckIds = findDuplicates(checkIds);
  return {
    pass: unknownOrInactive.length === 0 && duplicateCheckIds.length === 0,
    unknown_or_inactive: unknownOrInactive.sort(),
    duplicate_check_ids: duplicateCheckIds,
  };
}

function analyzeRepeatManifest(manifest, actualRepeatIds, declaredRepeatCount) {
  const manifestIds = manifest.map((entry) => entry.repeat_id).sort();
  const duplicateIds = findDuplicates(manifestIds);
  const duplicateSeeds = findDuplicates(manifest.map((entry) => entry.seed));
  const duplicateRunDigests = findDuplicates(
    manifest.map((entry) => entry.run_digest),
  );
  const idsMatch =
    duplicateIds.length === 0 &&
    stableStringify(manifestIds) === stableStringify(actualRepeatIds);
  const countMatches =
    manifest.length === declaredRepeatCount &&
    actualRepeatIds.length === declaredRepeatCount;
  return {
    pass:
      idsMatch &&
      countMatches &&
      duplicateSeeds.length === 0 &&
      duplicateRunDigests.length === 0,
    ids_match: idsMatch,
    count_matches: countMatches,
    manifest_ids: manifestIds,
    actual_trial_repeat_ids: actualRepeatIds,
    duplicate_repeat_ids: duplicateIds,
    duplicate_seeds: duplicateSeeds,
    duplicate_run_digests: duplicateRunDigests,
  };
}

function analyzeTargetFailureChecks(checks) {
  const baselineNotEstablished = checks
    .filter((check) => !check.baseline_present)
    .map((check) => check.check_id)
    .sort();
  const evidenceNotReduced = checks
    .filter((check) => !check.evidence_reduced)
    .map((check) => check.check_id)
    .sort();
  const failurePersists = checks
    .filter((check) => check.candidate_present)
    .map((check) => check.check_id)
    .sort();
  return {
    pass:
      baselineNotEstablished.length === 0 &&
      evidenceNotReduced.length === 0 &&
      failurePersists.length === 0,
    baseline_not_established: baselineNotEstablished,
    evidence_not_reduced: evidenceNotReduced,
    failure_persists: failurePersists,
  };
}

function measureBooleanRatio(input, positiveField, threshold, direction) {
  const total = input.length;
  const positive = input.filter((item) => item[positiveField] === true).length;
  const available = total > 0;
  const rate = safeRate(positive, total);
  return {
    positive,
    total,
    rate,
    threshold,
    direction,
    available,
    pass:
      available &&
      (direction === "minimum" ? rate >= threshold : rate <= threshold),
  };
}

function measureRegressionRatio(input, threshold) {
  const total = input.length;
  const positive = input.filter((item) => item.passed === false).length;
  const available = total > 0;
  const rate = safeRate(positive, total);
  return {
    positive,
    total,
    rate,
    threshold,
    direction: "maximum",
    available,
    pass: available && rate <= threshold,
  };
}

function analyzeAggregation(
  run,
  orderMetric,
  evidenceMetric,
  counterfactualMetric,
  regressionMetric,
) {
  const candidateWins = run.order_trials.filter(
    (trial) => deriveWinner(trial.raw_choice, run.candidates) === "candidate",
  ).length;
  const baselineWins = run.order_trials.filter(
    (trial) => deriveWinner(trial.raw_choice, run.candidates) === "baseline",
  ).length;
  const ties = run.order_trials.filter(
    (trial) => deriveWinner(trial.raw_choice, run.candidates) === "tie",
  ).length;
  const orderConsistentPairs =
    orderMetric.candidate_pairs.length +
    orderMetric.baseline_pairs.length +
    orderMetric.tie_pairs.length;
  let winner = "inconclusive";
  if (
    orderMetric.inconsistent_pairs.length === 0 &&
    orderMetric.missing_slots.length === 0 &&
    orderMetric.duplicate_slots.length === 0
  ) {
    if (candidateWins > baselineWins && candidateWins > ties) winner = "candidate";
    else if (baselineWins > candidateWins && baselineWins > ties) winner = "baseline";
    else if (ties > 0 || candidateWins === baselineWins) winner = "tie";
  }
  const expected = {
    aggregator_id: run.actor_profiles.aggregator.id,
    candidate_wins: candidateWins,
    baseline_wins: baselineWins,
    ties,
    order_consistent_pairs: orderConsistentPairs,
    evidence_coverage: evidenceMetric.rate,
    counterfactual_pass_rate: counterfactualMetric.rate,
    regression_failure_rate: regressionMetric.rate,
    winner,
  };
  const mismatchedFields = Object.keys(expected)
    .filter((field) => run.aggregation[field] !== expected[field])
    .sort();
  return {
    pass: mismatchedFields.length === 0,
    mismatched_fields: mismatchedFields,
    expected,
  };
}

function groupActorsByOrigin(actors) {
  const parents = actors.map((_, index) => index);
  const find = (index) => {
    let current = index;
    while (parents[current] !== current) current = parents[current];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = current;
      index = next;
    }
    return current;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  for (let left = 0; left < actors.length; left += 1) {
    for (let right = left + 1; right < actors.length; right += 1) {
      if (originsEquivalent(actors[left].origin, actors[right].origin)) {
        union(left, right);
      }
    }
  }
  const components = new Map();
  for (let index = 0; index < actors.length; index += 1) {
    const root = find(index);
    const members = components.get(root) ?? [];
    members.push(actors[index]);
    components.set(root, members);
  }
  return [...components.values()].sort((left, right) =>
    left[0].id.localeCompare(right[0].id),
  );
}

function originsEquivalent(left, right) {
  if (!isRecord(left) || !isRecord(right)) return false;
  if (left.weights_digest && right.weights_digest) {
    return left.weights_digest === right.weights_digest;
  }
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.model_version === right.model_version
  );
}

function describeOriginGroup(origins) {
  const weights = [
    ...new Set(origins.map((origin) => origin.weights_digest).filter(Boolean)),
  ];
  if (weights.length === 1 && origins.every((origin) => origin.weights_digest)) {
    return `weights:${weights[0]}`;
  }
  const origin = origins[0];
  return `model:${origin.provider}/${origin.model}/${origin.model_version}`;
}

function chooseStatus(reasonCodes) {
  if (reasonCodes.some((code) => INCONCLUSIVE_REASONS.has(code))) {
    return "inconclusive";
  }
  if (reasonCodes.some((code) => REJECTION_REASONS.has(code))) {
    return "rejected";
  }
  if (reasonCodes.includes("INSUFFICIENT_REPEAT_RUNS")) return "candidate";
  return "adopted";
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  }
  return [...duplicates].sort();
}

function groupBy(values, keyFunction) {
  const result = new Map();
  for (const value of values) {
    const key = keyFunction(value);
    const bucket = result.get(key) ?? [];
    bucket.push(value);
    result.set(key, bucket);
  }
  return result;
}

function compareActors(left, right) {
  return left.id.localeCompare(right.id);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeRate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function sortReasonCodes(reasons) {
  const rank = new Map(REASON_ORDER.map((reason, index) => [reason, index]));
  return [...reasons].sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
