import { readFileSync } from "node:fs";
import { verify as verifySignature } from "node:crypto";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  canonicalJson,
  digestMatchesText,
  sha256Json,
  sha256Text,
} from "./content-integrity.js";
import { validateDiagnosticArtifact } from "./diagnostic-artifact-validator.js";
import {
  validateIdentityIsolationPair,
  validateMachineBundleIntegrity,
} from "./machine-bundle-integrity.js";
import { validateTaxonomySemantics } from "./taxonomy-semantic-validator.js";
import {
  describeStructureFailure,
  inspectUntrustedStructure,
} from "./untrusted-input.js";

const POLICY_SCHEMA_ID =
  "https://yuqing-cai.github.io/cn-failure-atlas/schemas/evolution-policy.schema.json";
// The current evidence bundle validates one frozen repair case. It does not
// establish that the underlying strategy generalizes to unseen cases.
const IMPLEMENTED_PROMOTION_TARGETS = new Set(["repair_case"]);
const RECORD_SCHEMA_FILES = {
  evolution_policy: "evolution-policy.schema.json",
  diagnostic_trace: "diagnostic-trace.schema.json",
  repair_attempt: "repair-attempt.schema.json",
  verification_run: "verification-run.schema.json",
};
const LOCAL_RECORD_SCHEMAS = new Map(
  Object.entries(RECORD_SCHEMA_FILES).map(([recordType, filename]) => {
    const schema = JSON.parse(
      readFileSync(new URL(`../schemas/${filename}`, import.meta.url), "utf8"),
    );
    return [
      recordType,
      {
        id: schema.$id,
        version: schema.properties?.schema_version?.const,
        digest: sha256Json(schema),
      },
    ];
  }),
);

const {
  validatePolicySchema,
  validateVerificationRunSchema,
  validateDiagnosticTraceSchema,
  validateRepairAttemptSchema,
  validateTaxonomySchema,
  validateTrustRootSchema,
  validateRunReceiptSchema,
} = compileGateSchemas();

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
  "ARTIFACT_BUNDLE_REQUIRED",
  "ARTIFACT_BUNDLE_INVALID",
  "POLICY_REFERENCE_MISMATCH",
  "POLICY_VERSION_MISMATCH",
  "POLICY_SCHEMA_VERSION_MISMATCH",
  "POLICY_BELOW_SAFETY_FLOOR",
  "POLICY_DIGEST_MISMATCH",
  "POLICY_TRUST_ROOT_MISSING",
  "POLICY_TRUST_ROOT_MISMATCH",
  "UNTRUSTED_REGRESSION_CASE",
  "RUN_RECEIPT_MISSING",
  "RUN_RECEIPT_INVALID",
  "PROMOTION_TARGET_NOT_ALLOWED",
  "PROMOTION_TARGET_NOT_IMPLEMENTED",
  "PROMOTION_ARTIFACT_UNBOUND",
  "PROMOTION_ARTIFACT_INVALID",
  "EVALUATION_MANIFEST_MISMATCH",
  "EXPERIMENT_LEDGER_INVALID",
  "ACTOR_PROFILE_MISMATCH",
  "DUPLICATE_JUDGE_ID",
  "DUPLICATE_AUDIT_JUDGE_ID",
  "MISSING_GENERATOR_IDENTITY",
  "JUDGE_ORIGIN_MISSING",
  "INSUFFICIENT_INDEPENDENT_JUDGES",
  "INSUFFICIENT_INDEPENDENT_AUDIT_JUDGES",
  "GENERATOR_AS_JUDGE",
  "GENERATOR_ORIGIN_AS_JUDGE",
  "JUDGES_SHARE_ORIGIN",
  "AUDIT_JUDGES_SHARE_ORIGIN",
  "IDENTITY_ISOLATION_INVALID",
  "BLINDING_REQUIREMENTS_NOT_MET",
  "CANDIDATE_ARTIFACT_UNCHANGED",
  "REPEAT_MANIFEST_MISMATCH",
  "DUPLICATE_REPEAT_SEED",
  "DUPLICATE_REPEAT_DIGEST",
  "REPEAT_INPUT_MISMATCH",
  "REPEAT_RUN_COUNT_MISMATCH",
  "UNKNOWN_TRIAL_JUDGE",
  "DUPLICATE_TRIAL_ID",
  "DUPLICATE_ORDER_TRIAL",
  "ORDER_SWAP_MISSING",
  "TRIAL_RESULT_MISMATCH",
  "TRIAL_CONTEXT_ISOLATION_INVALID",
  "PREFERENCE_REQUEST_BINDING_INVALID",
  "AUDIT_REQUEST_BINDING_INVALID",
  "ORDER_CONCLUSION_MISMATCH",
  "CANDIDATE_NOT_PREFERRED",
  "ORDER_RESULT_TIED",
  "UNKNOWN_CHECK_JUDGE",
  "DUPLICATE_CHECK_ID",
  "DUPLICATE_SEMANTIC_CHECK",
  "CHECK_JUDGE_COVERAGE_INCOMPLETE",
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
  "CHALLENGE_INVOCATION_INVALID",
  "CHALLENGE_EVIDENCE_MISSING",
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
  "ARTIFACT_BUNDLE_REQUIRED",
  "ARTIFACT_BUNDLE_INVALID",
  "POLICY_REFERENCE_MISMATCH",
  "POLICY_VERSION_MISMATCH",
  "POLICY_SCHEMA_VERSION_MISMATCH",
  "POLICY_BELOW_SAFETY_FLOOR",
  "POLICY_DIGEST_MISMATCH",
  "POLICY_TRUST_ROOT_MISSING",
  "POLICY_TRUST_ROOT_MISMATCH",
  "UNTRUSTED_REGRESSION_CASE",
  "RUN_RECEIPT_MISSING",
  "RUN_RECEIPT_INVALID",
  "PROMOTION_TARGET_NOT_ALLOWED",
  "PROMOTION_TARGET_NOT_IMPLEMENTED",
  "PROMOTION_ARTIFACT_UNBOUND",
  "PROMOTION_ARTIFACT_INVALID",
  "EVALUATION_MANIFEST_MISMATCH",
  "EXPERIMENT_LEDGER_INVALID",
  "ACTOR_PROFILE_MISMATCH",
  "DUPLICATE_JUDGE_ID",
  "DUPLICATE_AUDIT_JUDGE_ID",
  "MISSING_GENERATOR_IDENTITY",
  "JUDGE_ORIGIN_MISSING",
  "INSUFFICIENT_INDEPENDENT_JUDGES",
  "INSUFFICIENT_INDEPENDENT_AUDIT_JUDGES",
  "IDENTITY_ISOLATION_INVALID",
  "AUDIT_JUDGES_SHARE_ORIGIN",
  "BLINDING_REQUIREMENTS_NOT_MET",
  "REPEAT_MANIFEST_MISMATCH",
  "DUPLICATE_REPEAT_SEED",
  "DUPLICATE_REPEAT_DIGEST",
  "REPEAT_INPUT_MISMATCH",
  "REPEAT_RUN_COUNT_MISMATCH",
  "UNKNOWN_TRIAL_JUDGE",
  "DUPLICATE_TRIAL_ID",
  "DUPLICATE_ORDER_TRIAL",
  "ORDER_SWAP_MISSING",
  "TRIAL_RESULT_MISMATCH",
  "TRIAL_CONTEXT_ISOLATION_INVALID",
  "PREFERENCE_REQUEST_BINDING_INVALID",
  "AUDIT_REQUEST_BINDING_INVALID",
  "ORDER_CONCLUSION_MISMATCH",
  "ORDER_RESULT_TIED",
  "UNKNOWN_CHECK_JUDGE",
  "DUPLICATE_CHECK_ID",
  "DUPLICATE_SEMANTIC_CHECK",
  "CHECK_JUDGE_COVERAGE_INCOMPLETE",
  "TARGET_FAILURE_NOT_ESTABLISHED",
  "AGGREGATION_MISMATCH",
  "EVIDENCE_CHECKS_MISSING",
  "INSUFFICIENT_EVIDENCE_COVERAGE",
  "COUNTERFACTUAL_CHECKS_MISSING",
  "REGRESSION_CHECKS_MISSING",
  "CONTAMINATED_REGRESSION_EVIDENCE",
  "CHALLENGE_ROUND_INCOMPLETE",
  "CHALLENGE_INVOCATION_INVALID",
  "CHALLENGE_EVIDENCE_MISSING",
  "UNKNOWN_CHALLENGE_RAISER",
]);

const REJECTION_REASONS = new Set([
  "GENERATOR_AS_JUDGE",
  "GENERATOR_ORIGIN_AS_JUDGE",
  "JUDGES_SHARE_ORIGIN",
  "CANDIDATE_ARTIFACT_UNCHANGED",
  "TARGET_FAILURE_NOT_REDUCED",
  "TARGET_FAILURE_PERSISTS",
  "CANDIDATE_NOT_PREFERRED",
  "COUNTERFACTUAL_PASS_RATE_BELOW_MINIMUM",
  "HARD_REGRESSION_VETO",
  "REGRESSION_FAILURE_RATE_EXCEEDED",
  "UNRESOLVED_HIGH_SEVERITY_CHALLENGE",
]);

export function validateGateInputSchemas(policyInput, verificationRunInput) {
  const preflight = (value, label) => {
    const structure = inspectUntrustedStructure(value);
    return structure.pass
      ? null
      : {
          valid: false,
          errors: [
            {
              instance_path: "/",
              keyword: "structuralLimit",
              message: describeStructureFailure(structure, label),
              params: structure,
            },
          ],
        };
  };
  // Scan every untrusted root before invoking either recursive AJV validator.
  // This keeps an oversized second argument from reaching AJV merely because
  // the first argument happened to be schema-valid.
  const policyPreflight = preflight(policyInput, "policy");
  const verificationRunPreflight = preflight(
    verificationRunInput,
    "verification_run",
  );
  const policy =
    policyPreflight ?? runSchemaValidator(validatePolicySchema, policyInput);
  const verificationRun =
    verificationRunPreflight ??
    runSchemaValidator(validateVerificationRunSchema, verificationRunInput);
  return {
    valid: policy.valid && verificationRun.valid,
    policy,
    verification_run: verificationRun,
  };
}

export function getLocalSchemaDescriptor(recordType) {
  const descriptor = LOCAL_RECORD_SCHEMAS.get(recordType);
  return descriptor ? { ...descriptor } : null;
}

export function collectPromptBundleDescriptors(records) {
  const descriptors = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (
      typeof value.bundle_id === "string" &&
      typeof value.version === "string" &&
      typeof value.digest === "string"
    ) {
      descriptors.push({
        id: value.bundle_id,
        version: value.version,
        digest: value.digest,
      });
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  for (const record of records) {
    const provenancePrompt = record?.provenance?.prompt_bundle;
    if (provenancePrompt) {
      descriptors.push({
        id: provenancePrompt.id,
        version: provenancePrompt.version,
        digest: provenancePrompt.digest,
      });
    }
    visit(record?.actors);
    visit(record?.actor_profiles);
  }
  const byKey = new Map(
    descriptors.map((item) => [stableStringify(item), item]),
  );
  return [...byKey.values()].sort((left, right) =>
    stableStringify(left).localeCompare(stableStringify(right)),
  );
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

export function computeEvaluationCaseCommitments(run) {
  const projectionFields = {
    evidence_checks: [
      "check_id",
      "finding_id",
      "target_turn_id",
      "evidence_ids",
      "judge_id",
      "invocation_id",
      "context_partition",
      "seed",
    ],
    target_failure_checks: [
      "check_id",
      "finding_id",
      "target_turn_id",
      "judge_id",
      "invocation_id",
      "context_partition",
      "seed",
    ],
    counterfactual_checks: [
      "check_id",
      "finding_id",
      "target_turn_id",
      "recipe_id",
      "source_execution_id",
      "source_execution_digest",
      "intervention",
      "invariant_contract_paths",
      "judge_id",
      "invocation_id",
      "context_partition",
      "seed",
    ],
    regression_checks: [
      "check_id",
      "suite_id",
      "suite_version",
      "suite_digest",
      "case_id",
      "case_digest",
      "judge_id",
      "preservation_constraint_ids",
      "protected_behavior",
      "hard_veto",
      "invocation_id",
      "context_partition",
      "seed",
    ],
    order_trials: [
      "trial_id",
      "repeat_id",
      "judge_id",
      "invocation_id",
      "context_partition",
      "seed",
      "order",
    ],
  };
  const idFields = {
    evidence_checks: "check_id",
    target_failure_checks: "check_id",
    counterfactual_checks: "check_id",
    regression_checks: "check_id",
    order_trials: "trial_id",
  };
  return Object.fromEntries(
    Object.entries(projectionFields).map(([collection, fields]) => [
      collection,
      (run?.[collection] ?? []).map((item) => {
        const projection = Object.fromEntries(
          fields.map((field) => [field, item[field]]),
        );
        let digest = null;
        try {
          digest = sha256Json(projection);
        } catch {
          // A schema-invalid case must be quarantined by the caller, never crash
          // the deterministic Gate while it is computing diagnostics.
        }
        return {
          item_id: item[idFields[collection]],
          digest,
        };
      }),
    ]),
  );
}

export function computeRepeatInputDigest(policyInput, run, artifactBundle) {
  const trace =
    artifactBundle?.diagnostic_trace ?? artifactBundle?.diagnosticTrace;
  const repair = artifactBundle?.repair_attempt ?? artifactBundle?.repairAttempt;
  const taxonomy = artifactBundle?.taxonomy;
  if (!trace || !repair || !taxonomy) return null;
  const judgeInputs = (run?.actor_profiles?.judges ?? [])
    .map((judge) => ({
      id: judge.id,
      origin: judge.origin,
      prompt: judge.prompt,
      temperature: judge.temperature,
      context_partition: judge.context_partition,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256Json({
    policy_digest: policyInput.policy_digest,
    taxonomy_digest: sha256Json(taxonomy),
    diagnostic_trace_digest: sha256Json(trace),
    repair_attempt_digest: sha256Json(repair),
    evaluation_manifest_digest: run.evaluation_manifest.manifest_digest,
    baseline_digest: run.candidates.baseline.digest,
    candidate_digest: run.candidates.candidate.digest,
    blinding_mapping_digest: run.blinding.mapping_digest,
    blinding_mapping: [
      {
        blind_alias: run.candidates.baseline.blind_alias,
        candidate_id: run.candidates.baseline.candidate_id,
        candidate_digest: run.candidates.baseline.digest,
      },
      {
        blind_alias: run.candidates.candidate.blind_alias,
        candidate_id: run.candidates.candidate.candidate_id,
        candidate_digest: run.candidates.candidate.digest,
      },
    ].sort((left, right) =>
      left.blind_alias.localeCompare(right.blind_alias),
    ),
    judge_inputs: judgeInputs,
    preference_request_digests: (run?.order_trials ?? [])
      .map((trial) => ({
        trial_id: trial.trial_id,
        preference_request_digest: trial.preference_request_digest,
      }))
      .sort((left, right) => left.trial_id.localeCompare(right.trial_id)),
    audit_request_digests: [
      ...(run?.evidence_checks ?? []).map((check) => ({
        collection: "evidence_checks",
        check_id: check.check_id,
        audit_request_digest: check.audit_request_digest,
      })),
      ...(run?.target_failure_checks ?? []).map((check) => ({
        collection: "target_failure_checks",
        check_id: check.check_id,
        audit_request_digest: check.audit_request_digest,
      })),
      ...(run?.counterfactual_checks ?? []).map((check) => ({
        collection: "counterfactual_checks",
        check_id: check.check_id,
        audit_request_digest: check.audit_request_digest,
      })),
      ...(run?.regression_checks ?? []).map((check) => ({
        collection: "regression_checks",
        check_id: check.check_id,
        audit_request_digest: check.audit_request_digest,
      })),
    ].sort((left, right) =>
      `${left.collection}\u0000${left.check_id}`.localeCompare(
        `${right.collection}\u0000${right.check_id}`,
      ),
    ),
    challenge_request_digests: (run?.challenge_invocations ?? [])
      .filter((invocation) => invocation.invocation_kind === "challenge_raiser")
      .map((invocation) => ({
        invocation_id: invocation.invocation_id,
        challenge_request_digest: invocation.challenge_request_digest,
      }))
      .sort((left, right) =>
        left.invocation_id.localeCompare(right.invocation_id),
      ),
  });
}

export function computePreferenceRequestDigest(run, trial, artifactBundle) {
  const trace =
    artifactBundle?.diagnostic_trace ?? artifactBundle?.diagnosticTrace;
  const repair =
    artifactBundle?.repair_attempt ?? artifactBundle?.repairAttempt;
  const targetTurnId = repair?.target_turn_id;
  const turns = trace?.subject?.turns ?? [];
  const targetIndex = turns.findIndex((turn) => turn.turn_id === targetTurnId);
  const targetTurn = turns[targetIndex];
  const targetScene = (trace?.subject?.scenes ?? []).find(
    (scene) => scene.scene_id === targetTurn?.scene_id,
  );
  const judge = (run?.actor_profiles?.judges ?? []).find(
    (item) => item.id === trial?.judge_id,
  );
  if (
    targetIndex < 0 ||
    !targetScene ||
    !judge ||
    !["AB", "BA"].includes(trial?.order) ||
    !isRecord(run?.candidates?.baseline) ||
    !isRecord(run?.candidates?.candidate) ||
    !isRecord(repair?.candidates?.baseline) ||
    !isRecord(repair?.candidates?.candidate)
  ) {
    return null;
  }
  const contentByAlias = new Map([
    [
      run.candidates.baseline.blind_alias,
      {
        content: repair.candidates.baseline.content,
        content_digest: repair.candidates.baseline.digest,
      },
    ],
    [
      run.candidates.candidate.blind_alias,
      {
        content: repair.candidates.candidate.content,
        content_digest: repair.candidates.candidate.digest,
      },
    ],
  ]);
  const orderedAliases = trial.order === "AB" ? ["A", "B"] : ["B", "A"];
  if (orderedAliases.some((alias) => !contentByAlias.has(alias))) return null;
  try {
    return sha256Json({
      request_version: "1.1.0",
      scene: {
        scene_id: targetScene.scene_id,
        contract: targetScene.contract,
        contract_digest: targetScene.contract_digest,
      },
      context_turns: turns.slice(0, targetIndex).map((turn) => ({
        turn_id: turn.turn_id,
        speaker: turn.speaker,
        content: turn.content,
      })),
      rubric_prompt: judge.prompt,
      comparison: orderedAliases.map((blindAlias, index) => ({
        position: index + 1,
        blind_alias: blindAlias,
        ...contentByAlias.get(blindAlias),
      })),
      disclosure_contract: {
        candidate_origin_hidden: true,
        model_identity_hidden: true,
        diagnosis_hidden: true,
        repair_rationale_hidden: true,
      },
    });
  } catch {
    return null;
  }
}

export function computeAuditCheckSeed(actorSeed, collectionName, checkId) {
  if (
    !Number.isInteger(actorSeed) ||
    !nonEmptyString(collectionName) ||
    !nonEmptyString(checkId)
  ) {
    return null;
  }
  return Number.parseInt(
    sha256Text(`${actorSeed}\u0000${collectionName}\u0000${checkId}`).slice(0, 8),
    16,
  );
}

export function computeAuditRequestDigest(
  run,
  collectionName,
  check,
  artifactBundle,
) {
  const allowedCollections = new Set([
    "evidence_checks",
    "target_failure_checks",
    "counterfactual_checks",
    "regression_checks",
  ]);
  if (!allowedCollections.has(collectionName) || !isRecord(check)) return null;
  const trace =
    artifactBundle?.diagnostic_trace ?? artifactBundle?.diagnosticTrace;
  const repair =
    artifactBundle?.repair_attempt ?? artifactBundle?.repairAttempt;
  const judge = (run?.actor_profiles?.audit_judges ?? []).find(
    (item) => item.id === check.judge_id,
  );
  const targetTurnId =
    check.target_turn_id ?? repair?.target_turn_id ?? null;
  const turns = trace?.subject?.turns ?? [];
  const targetIndex = turns.findIndex((turn) => turn.turn_id === targetTurnId);
  const targetTurn = targetIndex >= 0 ? turns[targetIndex] : null;
  const targetScene = (trace?.subject?.scenes ?? []).find(
    (scene) => scene.scene_id === targetTurn?.scene_id,
  );
  const finding = (trace?.findings ?? []).find(
    (item) => item.finding_id === check.finding_id,
  );
  if (
    !trace ||
    !repair ||
    !judge ||
    !targetTurn ||
    !targetScene ||
    !isRecord(repair?.candidates?.baseline) ||
    !isRecord(repair?.candidates?.candidate) ||
    !nonEmptyString(check.invocation_id) ||
    !nonEmptyString(check.context_partition) ||
    !Number.isInteger(check.seed) ||
    (collectionName !== "regression_checks" && !finding)
  ) {
    return null;
  }

  const projectionFields = {
    evidence_checks: [
      "check_id",
      "finding_id",
      "target_turn_id",
      "evidence_ids",
      "judge_id",
    ],
    target_failure_checks: [
      "check_id",
      "finding_id",
      "target_turn_id",
      "judge_id",
    ],
    counterfactual_checks: [
      "check_id",
      "finding_id",
      "target_turn_id",
      "recipe_id",
      "source_execution_id",
      "source_execution_digest",
      "intervention",
      "invariant_contract_paths",
      "judge_id",
    ],
    regression_checks: [
      "check_id",
      "suite_id",
      "suite_version",
      "suite_digest",
      "case_id",
      "case_digest",
      "judge_id",
      "preservation_constraint_ids",
      "protected_behavior",
      "hard_veto",
    ],
  };
  const checkSpec = Object.fromEntries(
    projectionFields[collectionName].map((field) => [field, check[field]]),
  );
  const evidenceIds =
    collectionName === "evidence_checks"
      ? check.evidence_ids ?? []
      : (finding?.evidence ?? [])
          .filter((item) => item.stance === "supports")
          .map((item) => item.evidence_id);
  const evidenceById = new Map(
    (trace?.findings ?? [])
      .flatMap((item) => item.evidence ?? [])
      .map((item) => [item.evidence_id, item]),
  );
  const evidence = evidenceIds.map((id) => evidenceById.get(id));
  if (evidence.some((item) => !isRecord(item))) return null;

  try {
    return sha256Json({
      request_version: "1.0.0",
      collection: collectionName,
      invocation: {
        invocation_id: check.invocation_id,
        judge_id: check.judge_id,
        context_partition: check.context_partition,
        seed: check.seed,
      },
      audit_judge: {
        id: judge.id,
        origin: judge.origin,
        prompt: judge.prompt,
        temperature: judge.temperature,
      },
      subject: {
        record_id: trace.subject.record_id,
        conversation_id: trace.subject.conversation_id,
        context_turns: turns.slice(0, targetIndex).map((turn) => ({
          turn_id: turn.turn_id,
          speaker: turn.speaker,
          content: turn.content,
        })),
        target_turn: {
          turn_id: targetTurn.turn_id,
          speaker: targetTurn.speaker,
          content: targetTurn.content,
        },
        scene: {
          scene_id: targetScene.scene_id,
          contract: targetScene.contract,
          contract_digest: targetScene.contract_digest,
        },
      },
      candidates: {
        baseline: {
          content: repair.candidates.baseline.content,
          digest: repair.candidates.baseline.digest,
        },
        candidate: {
          content: repair.candidates.candidate.content,
          digest: repair.candidates.candidate.digest,
        },
        disclosure_contract: {
          baseline_candidate_roles_visible: true,
          producer_identity_hidden: true,
          model_identity_hidden: true,
        },
      },
      finding: finding ?? null,
      evidence,
      preservation_contract: repair.repair_plan?.preservation_contract ?? [],
      check_spec: checkSpec,
    });
  } catch {
    return null;
  }
}

export function computeChallengeRequestDigest(run, invocation, artifactBundle) {
  const trace =
    artifactBundle?.diagnostic_trace ?? artifactBundle?.diagnosticTrace;
  const repair =
    artifactBundle?.repair_attempt ?? artifactBundle?.repairAttempt;
  const actor = (run?.actor_profiles?.critics ?? []).find(
    (item) => item.id === invocation?.actor_id,
  );
  const turns = trace?.subject?.turns ?? [];
  const targetIndex = turns.findIndex(
    (turn) => turn.turn_id === repair?.target_turn_id,
  );
  const targetTurn = targetIndex >= 0 ? turns[targetIndex] : null;
  const targetScene = (trace?.subject?.scenes ?? []).find(
    (scene) => scene.scene_id === targetTurn?.scene_id,
  );
  const findingById = new Map(
    (trace?.findings ?? []).map((finding) => [finding.finding_id, finding]),
  );
  const targetFindings = (repair?.target_finding_ids ?? []).map((findingId) =>
    findingById.get(findingId),
  );
  if (
    invocation?.invocation_kind !== "challenge_raiser" ||
    !actor ||
    !targetTurn ||
    !targetScene ||
    targetFindings.length === 0 ||
    targetFindings.some((finding) => !isRecord(finding)) ||
    !isRecord(repair?.candidates?.baseline) ||
    !isRecord(repair?.candidates?.candidate)
  ) {
    return null;
  }
  try {
    return sha256Json({
      request_version: "1.0.0",
      invocation: {
        invocation_id: invocation.invocation_id,
        invocation_kind: invocation.invocation_kind,
        actor_id: invocation.actor_id,
        context_partition: invocation.context_partition,
        seed: invocation.seed,
      },
      critic: {
        id: actor.id,
        origin: actor.origin,
        prompt: actor.prompt,
        temperature: actor.temperature,
      },
      subject: {
        record_id: trace.subject.record_id,
        conversation_id: trace.subject.conversation_id,
        context_turns: turns.slice(0, targetIndex).map((turn) => ({
          turn_id: turn.turn_id,
          speaker: turn.speaker,
          content: turn.content,
        })),
        target_turn: {
          turn_id: targetTurn.turn_id,
          speaker: targetTurn.speaker,
          content: targetTurn.content,
        },
        scene: {
          scene_id: targetScene.scene_id,
          contract: targetScene.contract,
          contract_digest: targetScene.contract_digest,
        },
      },
      candidates: {
        baseline: {
          content: repair.candidates.baseline.content,
          digest: repair.candidates.baseline.digest,
        },
        candidate: {
          content: repair.candidates.candidate.content,
          digest: repair.candidates.candidate.digest,
        },
      },
      target_findings: targetFindings,
      inherited_challenges: repair.critic_check?.unresolved_challenges ?? [],
      preservation_contract: repair.repair_plan?.preservation_contract ?? [],
      disclosure_contract: {
        baseline_candidate_roles_visible: true,
        producer_identity_hidden: true,
        model_identity_hidden: true,
      },
    });
  } catch {
    return null;
  }
}

export function computeChallengeResolutionRequestDigest(
  run,
  invocation,
  artifactBundle,
) {
  const trace =
    artifactBundle?.diagnostic_trace ?? artifactBundle?.diagnosticTrace;
  const repair =
    artifactBundle?.repair_attempt ?? artifactBundle?.repairAttempt;
  const actor = (run?.actor_profiles?.audit_judges ?? []).find(
    (item) => item.id === invocation?.actor_id,
  );
  const turns = trace?.subject?.turns ?? [];
  const targetIndex = turns.findIndex(
    (turn) => turn.turn_id === repair?.target_turn_id,
  );
  const targetTurn = targetIndex >= 0 ? turns[targetIndex] : null;
  const targetScene = (trace?.subject?.scenes ?? []).find(
    (scene) => scene.scene_id === targetTurn?.scene_id,
  );
  const challengeById = new Map(
    (run?.challenges ?? []).map((challenge) => [challenge.challenge_id, challenge]),
  );
  const checkById = new Map(
    [
      ["evidence_checks", run?.evidence_checks ?? []],
      ["target_failure_checks", run?.target_failure_checks ?? []],
      ["counterfactual_checks", run?.counterfactual_checks ?? []],
      ["regression_checks", run?.regression_checks ?? []],
    ].flatMap(([collection, checks]) =>
      checks.map((check) => [check.check_id, { collection, check }]),
    ),
  );
  const challenges = (invocation?.resolved_challenge_ids ?? []).map(
    (challengeId) => challengeById.get(challengeId),
  );
  if (
    invocation?.invocation_kind !== "challenge_resolver" ||
    !actor ||
    !targetTurn ||
    !targetScene ||
    challenges.length === 0 ||
    challenges.some((challenge) => !isRecord(challenge)) ||
    !isRecord(repair?.candidates?.baseline) ||
    !isRecord(repair?.candidates?.candidate)
  ) {
    return null;
  }
  const resolutionInputs = challenges.map((challenge) => {
    const checks = (challenge.resolution_check_ids ?? []).map((checkId) =>
      checkById.get(checkId),
    );
    if (checks.some((entry) => !isRecord(entry))) return null;
    return {
      challenge: {
        challenge_id: challenge.challenge_id,
        challenge_kind: challenge.challenge_kind,
        raised_by: challenge.raised_by,
        severity: challenge.severity,
        claim: challenge.claim,
        target_finding_ids: challenge.target_finding_ids,
        required_resolution_check_ids:
          challenge.required_resolution_check_ids,
      },
      resolution_checks: checks.sort((left, right) =>
        left.check.check_id.localeCompare(right.check.check_id),
      ),
    };
  });
  if (resolutionInputs.some((entry) => entry === null)) return null;
  try {
    return sha256Json({
      request_version: "1.0.0",
      invocation: {
        invocation_id: invocation.invocation_id,
        invocation_kind: invocation.invocation_kind,
        actor_id: invocation.actor_id,
        context_partition: invocation.context_partition,
        seed: invocation.seed,
      },
      resolver: {
        id: actor.id,
        origin: actor.origin,
        prompt: actor.prompt,
        temperature: actor.temperature,
      },
      subject: {
        record_id: trace.subject.record_id,
        conversation_id: trace.subject.conversation_id,
        target_turn_id: targetTurn.turn_id,
        scene: {
          scene_id: targetScene.scene_id,
          contract: targetScene.contract,
          contract_digest: targetScene.contract_digest,
        },
      },
      candidates: {
        baseline: {
          content: repair.candidates.baseline.content,
          digest: repair.candidates.baseline.digest,
        },
        candidate: {
          content: repair.candidates.candidate.content,
          digest: repair.candidates.candidate.digest,
        },
      },
      resolution_inputs: resolutionInputs,
      disclosure_contract: {
        baseline_candidate_roles_visible: true,
        producer_identity_hidden: true,
        model_identity_hidden: true,
      },
    });
  } catch {
    return null;
  }
}

export function computeRepeatRunDigest(run, repeatEntry) {
  const orderTrials = (run?.order_trials ?? [])
    .filter((trial) => trial.repeat_id === repeatEntry.repeat_id)
    .sort((left, right) => left.trial_id.localeCompare(right.trial_id));
  return sha256Json({
    repeat_id: repeatEntry.repeat_id,
    seed: repeatEntry.seed,
    input_digest: repeatEntry.input_digest,
    executed_at: repeatEntry.executed_at,
    order_trials: orderTrials,
  });
}

export function computeOrderTrialSeed(repeatSeed, judgeId, order) {
  if (
    !Number.isInteger(repeatSeed) ||
    !nonEmptyString(judgeId) ||
    !["AB", "BA"].includes(order)
  ) {
    return null;
  }
  return Number.parseInt(
    sha256Text(`${repeatSeed}\u0000${judgeId}\u0000${order}`).slice(0, 8),
    16,
  );
}

export function computeRepeatPlanDigest(run) {
  return sha256Json(
    (run?.repeat_manifest ?? [])
      .map((entry) => ({
        repeat_id: entry.repeat_id,
        seed: entry.seed,
        input_digest: entry.input_digest,
      }))
      .sort((left, right) => left.repeat_id.localeCompare(right.repeat_id)),
  );
}

export function computeJudgeActorSetDigest(run) {
  if (!isRecord(run?.actor_profiles)) return null;
  return sha256Json({
    preference_judges: (run.actor_profiles.judges ?? [])
      .map((judge) => ({ ...judge }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    audit_judges: (run.actor_profiles.audit_judges ?? [])
      .map((judge) => ({ ...judge }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}

export function computeBlindingMappingDigest(run) {
  const baseline = run?.candidates?.baseline;
  const candidate = run?.candidates?.candidate;
  if (
    !isRecord(baseline) ||
    !isRecord(candidate) ||
    !nonEmptyString(baseline.blind_alias) ||
    !nonEmptyString(candidate.blind_alias) ||
    !nonEmptyString(baseline.digest) ||
    !nonEmptyString(candidate.digest) ||
    !nonEmptyString(run?.blinding?.commitment_nonce)
  ) {
    return null;
  }
  return sha256Json({
    commitment_nonce: run.blinding.commitment_nonce,
    mapping: [baseline, candidate]
      .map((item) => ({
        blind_alias: item.blind_alias,
        candidate_id: item.candidate_id,
        candidate_digest: item.digest,
      }))
      .sort((left, right) => left.blind_alias.localeCompare(right.blind_alias)),
  });
}

export function computeBlindingProtocolDigest(run) {
  const blinding = run?.blinding;
  if (!isRecord(blinding)) return null;
  try {
    return sha256Json({
      commitment_scheme: blinding.commitment_scheme,
      mapping_visible_to: blinding.mapping_visible_to,
      candidate_origin_hidden: blinding.candidate_origin_hidden,
      model_identity_hidden: blinding.model_identity_hidden,
      judge_contexts_reset_between_orders:
        blinding.judge_contexts_reset_between_orders,
      judge_contexts_reset_between_repeats:
        blinding.judge_contexts_reset_between_repeats,
      preference_channel_label_blind:
        blinding.preference_channel_label_blind,
      preference_channel_rationale_blind:
        blinding.preference_channel_rationale_blind,
      preference_audit_contexts_separated:
        blinding.preference_audit_contexts_separated,
    });
  } catch {
    return null;
  }
}

export function computeGenerationInputDigest(trace, outputTurnId) {
  const turns = trace?.subject?.turns ?? [];
  const outputIndex = turns.findIndex(
    (turn) => turn.turn_id === outputTurnId,
  );
  if (outputIndex < 0) return null;
  const outputTurn = turns[outputIndex];
  const scene = (trace?.subject?.scenes ?? []).find(
    (item) => item.scene_id === outputTurn.scene_id,
  );
  if (
    !scene ||
    !trace?.actors?.generator ||
    !trace?.actors?.contract_critic ||
    !isRecord(trace?.subject)
  ) {
    return null;
  }
  return sha256Json({
    subject_record_id: trace.subject.record_id,
    conversation_id: trace.subject.conversation_id,
    output_turn_id: outputTurnId,
    scene_id: scene.scene_id,
    context_turns: turns.slice(0, outputIndex),
    scene_contract: scene.contract,
    scene_contract_digest: scene.contract_digest,
    generator_actor: trace.actors.generator,
    contract_critic_actor: trace.actors.contract_critic,
  });
}

export function computeExperimentPlanDigest(ledger) {
  if (!ledger) return null;
  return sha256Json({
    family_id: ledger.family_id,
    attempt_id: ledger.attempt_id,
    attempt_index: ledger.attempt_index,
    budget: {
      max_candidate_attempts: ledger.budget?.max_candidate_attempts,
      max_model_calls: ledger.budget?.max_model_calls,
    },
    stop_rule: {
      rule_id: ledger.stop_rule?.rule_id,
      precommitted: ledger.stop_rule?.precommitted,
      condition_code: ledger.stop_rule?.condition_code,
      condition: ledger.stop_rule?.condition,
      action_when_met: ledger.stop_rule?.action_when_met,
      action_on_budget_exhaustion:
        ledger.stop_rule?.action_on_budget_exhaustion,
    },
  });
}

export function computeRepairInputDigest(trace, repair) {
  if (
    !isRecord(trace) ||
    !isRecord(repair) ||
    !Array.isArray(trace.findings) ||
    !Array.isArray(repair.target_finding_ids) ||
    !isRecord(trace.experiment_ledger) ||
    !isRecord(repair.candidates?.baseline) ||
    !Array.isArray(repair.repair_plan?.preservation_contract) ||
    !isRecord(repair.actors?.baseline_generator) ||
    !isRecord(repair.actors?.repair_generator) ||
    !isRecord(repair.actors?.critic) ||
    !isRecord(repair.identity_isolation) ||
    !isRecord(repair.verification_handoff)
  ) {
    return null;
  }
  const findingById = new Map(
    (trace.findings ?? []).map((finding) => [finding.finding_id, finding]),
  );
  const targetFindings = repair.target_finding_ids.map((findingId) =>
    findingById.get(findingId),
  );
  if (targetFindings.some((finding) => !isRecord(finding))) return null;
  return sha256Json({
    repair_id: repair.repair_id,
    diagnostic_trace_digest: sha256Json(trace),
    experiment_plan_digest: computeExperimentPlanDigest(
      trace.experiment_ledger,
    ),
    target_findings: targetFindings,
    target_turn_id: repair.target_turn_id,
    baseline: repair.candidates?.baseline,
    baseline_generator: repair.actors?.baseline_generator,
    preservation_contract: repair.repair_plan.preservation_contract,
    repair_generator: repair.actors?.repair_generator,
    repair_critic: repair.actors?.critic,
    identity_isolation: repair.identity_isolation,
    verification_handoff: repair.verification_handoff,
  });
}

export function computeEvaluationInvocationPlanDigest(run) {
  if (
    !isRecord(run) ||
    !isRecord(run.evaluation_manifest) ||
    !isRecord(run.actor_profiles) ||
    !isRecord(run.actor_profiles.generator) ||
    !Array.isArray(run.actor_profiles.judges) ||
    !Array.isArray(run.actor_profiles.audit_judges) ||
    !Array.isArray(run.actor_profiles.critics) ||
    !isRecord(run.actor_profiles.aggregator) ||
    !Array.isArray(run.repeat_manifest) ||
    !isRecord(run.blinding) ||
    !isRecord(run.identity_isolation)
  ) {
    return null;
  }
  return sha256Json({
    evaluation_manifest: run.evaluation_manifest,
    generator: run.actor_profiles.generator,
    preference_judges: run.actor_profiles.judges
      .map((judge) => ({ ...judge }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    audit_judges: run.actor_profiles.audit_judges
      .map((judge) => ({ ...judge }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    critics: run.actor_profiles.critics
      .map((critic) => ({ ...critic }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    aggregator: run.actor_profiles.aggregator,
    repeat_schedule: run.repeat_manifest
      .map((entry) => ({
        repeat_id: entry.repeat_id,
        seed: entry.seed,
      }))
      .sort((left, right) => left.repeat_id.localeCompare(right.repeat_id)),
    challenge_invocation_plan: (run.challenge_invocations ?? [])
      .map((invocation) => ({
        invocation_id: invocation.invocation_id,
        invocation_kind: invocation.invocation_kind,
        actor_id: invocation.actor_id,
        context_partition: invocation.context_partition,
        seed: invocation.seed,
      }))
      .sort((left, right) => left.invocation_id.localeCompare(right.invocation_id)),
    blinding_protocol_digest: computeBlindingProtocolDigest(run),
    identity_isolation: run.identity_isolation,
    case_commitments: computeEvaluationCaseCommitments(run),
  });
}

export function generationPrecommitPayload(precommit) {
  const payload = { ...precommit };
  delete payload.signature;
  return payload;
}

export function diagnosticPrecommitPayload(precommit) {
  const payload = { ...precommit };
  delete payload.signature;
  return payload;
}

export function promotionRunReceiptPayload(receipt) {
  const payload = { ...receipt };
  delete payload.signature;
  delete payload.verification_precommit;
  delete payload.completion;
  return payload;
}

export function verificationPrecommitPayload(receipt) {
  const payload = {
    ...receipt,
    verification_precommit: { ...receipt.verification_precommit },
  };
  delete payload.completion;
  delete payload.verification_precommit.signature;
  return payload;
}

export function promotionRunCompletionPayload(receipt) {
  const payload = {
    ...receipt,
    completion: { ...receipt.completion },
  };
  delete payload.completion.signature;
  return payload;
}

export function computeVerificationRunAttestationDigest(run) {
  const payload = { ...run };
  delete payload.promotion_gate;
  return sha256Json(payload);
}

export function evaluatePromotion(
  policyInput,
  verificationRunInput,
  artifactBundle = null,
  trustedPolicyRoot = null,
  trustedRunReceipt = null,
) {
  const policyStructure = inspectUntrustedStructure(policyInput);
  if (!policyStructure.pass) {
    return invalidDecision(
      "INVALID_POLICY",
      [{ message: describeStructureFailure(policyStructure, "policy") }],
      null,
      null,
    );
  }
  const runStructure = inspectUntrustedStructure(verificationRunInput);
  if (!runStructure.pass) {
    return invalidDecision(
      "INVALID_VERIFICATION_RUN",
      [
        {
          message: describeStructureFailure(
            runStructure,
            "verification run",
          ),
        },
      ],
      policyInput,
      null,
    );
  }
  for (const [reasonCode, value, label] of [
    ["ARTIFACT_BUNDLE_INVALID", artifactBundle, "artifact bundle"],
    ["POLICY_TRUST_ROOT_MISMATCH", trustedPolicyRoot, "trust root"],
    ["RUN_RECEIPT_INVALID", trustedRunReceipt, "run receipt"],
  ]) {
    const structure = inspectUntrustedStructure(value);
    if (!structure.pass) {
      return quarantinedInputDecision(
        reasonCode,
        describeStructureFailure(structure, label),
        policyInput,
        verificationRunInput,
      );
    }
  }
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
  const bundleMetric = analyzeArtifactBundle(policyInput, run, artifactBundle);
  const safeArtifactBundle =
    bundleMetric.schema_valid === false ? null : artifactBundle;
  if (!bundleMetric.available) reasons.add("ARTIFACT_BUNDLE_REQUIRED");
  else if (!bundleMetric.pass) reasons.add("ARTIFACT_BUNDLE_INVALID");
  if (policy.status !== "promoted") reasons.add("POLICY_NOT_EXECUTABLE");
  if (
    policy.mode !== "machine_only" ||
    run.mode !== "machine_only" ||
    run.mode !== policy.mode
  ) {
    reasons.add("UNSUPPORTED_EXECUTION_MODE");
  }
  const policyReference = run.policy_ref;
  const policyIdMatches = policyReference.record_id === policy.id;
  const policyVersionMatches = policyReference.policy_version === policy.version;
  const policySchemaVersionMatches =
    policyReference.schema_version === policy.schema_version &&
    policyReference.schema_id === POLICY_SCHEMA_ID;
  if (!policyIdMatches) reasons.add("POLICY_REFERENCE_MISMATCH");
  if (!policyVersionMatches) reasons.add("POLICY_VERSION_MISMATCH");
  if (!policySchemaVersionMatches) reasons.add("POLICY_SCHEMA_VERSION_MISMATCH");

  const policyDigestMetric = analyzePolicyDigest(policyInput, policyReference);
  if (!policyDigestMetric.pass) reasons.add("POLICY_DIGEST_MISMATCH");
  const policyTrustRootMetric = analyzePolicyTrustRoot(
    policyInput,
    trustedPolicyRoot,
    safeArtifactBundle?.taxonomy ?? null,
  );
  if (!policyTrustRootMetric.available) {
    reasons.add("POLICY_TRUST_ROOT_MISSING");
  } else if (!policyTrustRootMetric.pass) {
    reasons.add("POLICY_TRUST_ROOT_MISMATCH");
  }
  const provenanceMetric = analyzeTrustedProvenance(
    policyInput,
    run,
    safeArtifactBundle,
    trustedPolicyRoot,
  );
  if (!provenanceMetric.pass) reasons.add("UNVERIFIED_PROVENANCE");
  const regressionRegistryMetric = analyzeTrustedRegressionRegistry(
    run,
    trustedPolicyRoot,
  );
  if (!regressionRegistryMetric.pass) {
    reasons.add("UNTRUSTED_REGRESSION_CASE");
  }
  const runReceiptMetric = analyzeRunReceipt(
    policyInput,
    run,
    safeArtifactBundle,
    trustedPolicyRoot,
    trustedRunReceipt,
  );
  if (!runReceiptMetric.available) reasons.add("RUN_RECEIPT_MISSING");
  else if (!runReceiptMetric.pass) reasons.add("RUN_RECEIPT_INVALID");

  const safetyFloorMetric = analyzeSafetyFloor(policy.thresholds);
  if (!safetyFloorMetric.pass) reasons.add("POLICY_BELOW_SAFETY_FLOOR");

  const promotionTarget = run.promotion_artifact.target;
  const targetAllowed = policy.promotion_targets.includes(promotionTarget);
  if (!targetAllowed) reasons.add("PROMOTION_TARGET_NOT_ALLOWED");
  const targetImplemented = IMPLEMENTED_PROMOTION_TARGETS.has(promotionTarget);
  if (!targetImplemented) reasons.add("PROMOTION_TARGET_NOT_IMPLEMENTED");
  const promotionArtifactMetric = analyzePromotionArtifact(
    run,
    safeArtifactBundle,
  );
  if (!promotionArtifactMetric.bound) reasons.add("PROMOTION_ARTIFACT_UNBOUND");
  else if (!promotionArtifactMetric.pass) {
    reasons.add("PROMOTION_ARTIFACT_INVALID");
  }

  const evaluationManifestMetric = analyzeEvaluationManifest(
    run,
    safeArtifactBundle,
  );
  if (!evaluationManifestMetric.pass) {
    reasons.add("EVALUATION_MANIFEST_MISMATCH");
  }

  const experimentLedgerMetric = analyzeExperimentLedger(
    run,
    safeArtifactBundle,
    trustedRunReceipt,
  );
  if (!experimentLedgerMetric.pass) reasons.add("EXPERIMENT_LEDGER_INVALID");

  const generator = run.generator;
  const judges = [...run.judges].sort(compareActors);
  const judgeIds = judges.map((judge) => judge.id);
  const auditJudges = [...run.actor_profiles.audit_judges].sort(compareActors);
  const auditJudgeIds = auditJudges.map((judge) => judge.id);
  const duplicateJudgeIds = findDuplicates(judgeIds);
  const duplicateAuditJudgeIds = findDuplicates(auditJudgeIds);
  if (duplicateJudgeIds.length > 0) reasons.add("DUPLICATE_JUDGE_ID");
  if (duplicateAuditJudgeIds.length > 0) {
    reasons.add("DUPLICATE_AUDIT_JUDGE_ID");
  }
  if (!generator.id || !generator.origin) reasons.add("MISSING_GENERATOR_IDENTITY");

  const judgesMissingOrigin = [...judges, ...auditJudges]
    .filter((judge) => !judge.origin)
    .map((judge) => judge.id || "<missing-id>")
    .sort();
  if (judgesMissingOrigin.length > 0) reasons.add("JUDGE_ORIGIN_MISSING");

  const actorProfileMetric = analyzeActorProfiles(
    run,
    generator,
    judges,
    auditJudges,
  );
  if (!actorProfileMetric.pass) reasons.add("ACTOR_PROFILE_MISMATCH");

  const generatorIdConflicts = [...judges, ...auditJudges]
    .filter((judge) => judge.id === generator.id)
    .map((judge) => judge.id)
    .sort();
  if (generatorIdConflicts.length > 0) reasons.add("GENERATOR_AS_JUDGE");

  const generatorOriginConflicts = [...judges, ...auditJudges]
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

  const auditOriginComponents = groupActorsByOrigin(auditJudges);
  const sharedAuditJudgeOrigins = auditOriginComponents
    .filter((component) => component.length > 1)
    .map((component) => ({
      origin: describeOriginGroup(component.map((actor) => actor.origin)),
      judge_ids: component.map((actor) => actor.id).sort(),
    }))
    .sort((left, right) => left.origin.localeCompare(right.origin));
  if (sharedAuditJudgeOrigins.length > 0) {
    reasons.add("AUDIT_JUDGES_SHARE_ORIGIN");
  }
  const independentAuditJudgeCount = auditOriginComponents.length;
  if (
    independentAuditJudgeCount < policy.thresholds.min_independent_judges
  ) {
    reasons.add("INSUFFICIENT_INDEPENDENT_AUDIT_JUDGES");
  }

  const identityIsolationMetric = analyzeIdentityIsolation(run, policy);
  if (!identityIsolationMetric.pass) reasons.add("IDENTITY_ISOLATION_INVALID");

  const blindingMetric = {
    pass:
      run.blinding.mapping_digest === computeBlindingMappingDigest(run) &&
      run.blinding.candidate_origin_hidden === true &&
      run.blinding.model_identity_hidden === true &&
      run.blinding.judge_contexts_reset_between_orders === true &&
      run.blinding.judge_contexts_reset_between_repeats === true &&
      run.blinding.preference_channel_label_blind === true &&
      run.blinding.preference_channel_rationale_blind === true &&
      run.blinding.preference_audit_contexts_separated === true,
    candidate_origin_hidden: run.blinding.candidate_origin_hidden,
    mapping_digest_matches:
      run.blinding.mapping_digest === computeBlindingMappingDigest(run),
    expected_mapping_digest: computeBlindingMappingDigest(run),
    model_identity_hidden: run.blinding.model_identity_hidden,
    judge_contexts_reset_between_orders:
      run.blinding.judge_contexts_reset_between_orders,
    judge_contexts_reset_between_repeats:
      run.blinding.judge_contexts_reset_between_repeats,
    preference_channel_label_blind:
      run.blinding.preference_channel_label_blind,
    preference_channel_rationale_blind:
      run.blinding.preference_channel_rationale_blind,
    preference_audit_contexts_separated:
      run.blinding.preference_audit_contexts_separated,
  };
  if (!blindingMetric.pass) reasons.add("BLINDING_REQUIREMENTS_NOT_MET");

  const candidateDistinct =
    run.candidates.baseline.digest !== run.candidates.candidate.digest;
  if (!candidateDistinct) reasons.add("CANDIDATE_ARTIFACT_UNCHANGED");

  const invocationIdentityMetric = analyzeInvocationIdentityIsolation(
    run,
    safeArtifactBundle,
  );
  const orderMetric = analyzeOrderTrials(
    run,
    judgeIds,
    safeArtifactBundle,
    invocationIdentityMetric,
  );
  const repeatManifestMetric = analyzeRepeatManifest(
    policyInput,
    run,
    safeArtifactBundle,
    run.repeat_manifest,
    orderMetric.actual_repeat_ids,
    run.repeat_runs,
  );
  if (
    !repeatManifestMetric.ids_match ||
    !repeatManifestMetric.count_matches ||
    !repeatManifestMetric.digest_bindings_pass
  ) {
    reasons.add("REPEAT_MANIFEST_MISMATCH");
  }
  if (repeatManifestMetric.duplicate_seeds.length > 0) {
    reasons.add("DUPLICATE_REPEAT_SEED");
  }
  if (repeatManifestMetric.duplicate_run_digests.length > 0) {
    reasons.add("DUPLICATE_REPEAT_DIGEST");
  }
  if (repeatManifestMetric.input_digests_match === false) {
    reasons.add("REPEAT_INPUT_MISMATCH");
  }
  if (!orderMetric.repeat_count_matches) reasons.add("REPEAT_RUN_COUNT_MISMATCH");
  if (orderMetric.unknown_judge_ids.length > 0) reasons.add("UNKNOWN_TRIAL_JUDGE");
  if (orderMetric.duplicate_trial_ids.length > 0) reasons.add("DUPLICATE_TRIAL_ID");
  if (orderMetric.duplicate_slots.length > 0) reasons.add("DUPLICATE_ORDER_TRIAL");
  if (orderMetric.missing_slots.length > 0) reasons.add("ORDER_SWAP_MISSING");
  if (orderMetric.result_mismatches.length > 0) reasons.add("TRIAL_RESULT_MISMATCH");
  if (
    orderMetric.duplicate_invocation_ids.length > 0 ||
    orderMetric.duplicate_context_partitions.length > 0 ||
    orderMetric.duplicate_trial_seeds.length > 0 ||
    orderMetric.seed_mismatches.length > 0
  ) {
    reasons.add("TRIAL_CONTEXT_ISOLATION_INVALID");
  }
  if (orderMetric.preference_request_mismatches.length > 0) {
    reasons.add("PREFERENCE_REQUEST_BINDING_INVALID");
  }
  if (orderMetric.inconsistent_pairs.length > 0) reasons.add("ORDER_CONCLUSION_MISMATCH");
  if (orderMetric.baseline_pairs.length > 0) reasons.add("CANDIDATE_NOT_PREFERRED");
  if (orderMetric.tie_pairs.length > 0) reasons.add("ORDER_RESULT_TIED");
  if (orderMetric.actual_repeat_count < policy.thresholds.min_repeat_runs) {
    reasons.add("INSUFFICIENT_REPEAT_RUNS");
  }

  const checkReferenceMetric = analyzeCheckReferences(
    run,
    new Set(auditJudgeIds),
    new Set(auditJudgeIds),
    safeArtifactBundle?.repair_attempt?.target_finding_ids ??
    safeArtifactBundle?.repairAttempt?.target_finding_ids ??
      run.promotion_artifact?.payload?.target_finding_ids ??
      [],
    safeArtifactBundle,
    invocationIdentityMetric,
  );
  if (checkReferenceMetric.unknown_or_inactive.length > 0) reasons.add("UNKNOWN_CHECK_JUDGE");
  if (checkReferenceMetric.duplicate_check_ids.length > 0) reasons.add("DUPLICATE_CHECK_ID");
  if (checkReferenceMetric.duplicate_semantic_checks.length > 0) {
    reasons.add("DUPLICATE_SEMANTIC_CHECK");
  }
  if (
    checkReferenceMetric.incomplete_judge_coverage.length > 0 ||
    checkReferenceMetric.missing_target_judge_slots.length > 0 ||
    checkReferenceMetric.duplicate_target_judge_slots.length > 0 ||
    checkReferenceMetric.unexpected_target_checks.length > 0
  ) {
    reasons.add("CHECK_JUDGE_COVERAGE_INCOMPLETE");
  }
  if (
    checkReferenceMetric.duplicate_invocation_ids.length > 0 ||
    checkReferenceMetric.duplicate_context_partitions.length > 0 ||
    checkReferenceMetric.duplicate_invocation_seeds.length > 0 ||
    checkReferenceMetric.invocation_seed_mismatches.length > 0 ||
    checkReferenceMetric.audit_request_mismatches.length > 0
  ) {
    reasons.add("AUDIT_REQUEST_BINDING_INVALID");
  }

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
    auditJudgeIds,
  );
  if (!evidenceMetric.available) reasons.add("EVIDENCE_CHECKS_MISSING");
  else if (!evidenceMetric.pass) reasons.add("INSUFFICIENT_EVIDENCE_COVERAGE");

  const counterfactualMetric = measureBooleanRatio(
    run.counterfactual_checks,
    "passed",
    policy.thresholds.min_counterfactual_pass_rate,
    "minimum",
    auditJudgeIds,
  );
  if (!counterfactualMetric.available) reasons.add("COUNTERFACTUAL_CHECKS_MISSING");
  else if (!counterfactualMetric.pass) reasons.add("COUNTERFACTUAL_PASS_RATE_BELOW_MINIMUM");

  const regressionMetric = measureRegressionRatio(
    run.regression_checks,
    policy.thresholds.max_regression_failure_rate,
    auditJudgeIds,
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

  const challengeRoundMetric = analyzeChallengeRound(
    run,
    invocationIdentityMetric,
    safeArtifactBundle,
  );
  if (!challengeRoundMetric.completed) reasons.add("CHALLENGE_ROUND_INCOMPLETE");
  if (!challengeRoundMetric.pass) {
    reasons.add("CHALLENGE_INVOCATION_INVALID");
  }
  const unknownChallengeRaisers = challengeRoundMetric.unknown_actor_ids;
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
    decision_version: "2.0.0-alpha.1",
    run_id: run.verification_id,
    policy_id: policy.id,
    status,
    reason_codes: reasonCodes,
    metrics: {
      provenance: provenanceMetric,
      policy_binding: {
        pass:
          policy.status === "promoted" &&
          policyIdMatches &&
          policyVersionMatches &&
          policySchemaVersionMatches &&
          safetyFloorMetric.pass &&
          targetAllowed &&
          targetImplemented &&
          promotionArtifactMetric.pass &&
          policyDigestMetric.pass &&
          policyTrustRootMetric.pass &&
          runReceiptMetric.pass,
        executable_status: policy.status,
        policy_id_matches: policyIdMatches,
        policy_version_matches: policyVersionMatches,
        policy_schema_version_matches: policySchemaVersionMatches,
        promotion_target: promotionTarget,
        promotion_target_allowed: targetAllowed,
        promotion_target_implemented: targetImplemented,
        promotion_artifact_bound: promotionArtifactMetric.bound,
      },
      policy_digest: policyDigestMetric,
      policy_trust_root: policyTrustRootMetric,
      run_receipt: runReceiptMetric,
      safety_floor: safetyFloorMetric,
      artifact_bundle: bundleMetric,
      promotion_artifact: promotionArtifactMetric,
      evaluation_manifest: evaluationManifestMetric,
      experiment_ledger: experimentLedgerMetric,
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
      independent_audit_judges: {
        observed: independentAuditJudgeCount,
        required: policy.thresholds.min_independent_judges,
        pass:
          independentAuditJudgeCount >=
            policy.thresholds.min_independent_judges &&
          sharedAuditJudgeOrigins.length === 0 &&
          duplicateAuditJudgeIds.length === 0,
        duplicate_judge_ids: duplicateAuditJudgeIds,
        shared_origins: sharedAuditJudgeOrigins,
      },
      identity_isolation: identityIsolationMetric,
      blinding: blindingMetric,
      candidate_distinct: { pass: candidateDistinct },
      invocation_identity_isolation: invocationIdentityMetric,
      order_swap: orderMetric,
      repeat_manifest: repeatManifestMetric,
      check_references: checkReferenceMetric,
      target_failure_reduction: targetFailureMetric,
      evidence_coverage: evidenceMetric,
      counterfactual_pass_rate: counterfactualMetric,
      regression_failure_rate: regressionMetric,
      regression_registry: regressionRegistryMetric,
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

function quarantinedInputDecision(
  reasonCode,
  message,
  policyInput,
  runInput,
) {
  return {
    decision_version: "2.0.0-alpha.1",
    run_id: nonEmptyString(runInput?.verification_id)
      ? runInput.verification_id
      : null,
    policy_id: nonEmptyString(policyInput?.policy?.id)
      ? policyInput.policy.id
      : null,
    status: "inconclusive",
    reason_codes: [reasonCode],
    metrics: {},
    error: { message },
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
  const diagnosticTraceSchema = readSchema("diagnostic-trace.schema.json");
  ajv.addSchema(diagnosticTraceSchema);
  return {
    validatePolicySchema: ajv.compile(readSchema("evolution-policy.schema.json")),
    validateVerificationRunSchema: ajv.compile(
      readSchema("verification-run.schema.json"),
    ),
    validateDiagnosticTraceSchema: ajv.getSchema(diagnosticTraceSchema.$id),
    validateRepairAttemptSchema: ajv.compile(
      readSchema("repair-attempt.schema.json"),
    ),
    validateTrustRootSchema: ajv.compile(
      readSchema("promotion-trust-root.schema.json"),
    ),
    validateRunReceiptSchema: ajv.compile(
      readSchema("promotion-run-receipt.schema.json"),
    ),
    validateTaxonomySchema: ajv.compile(
      JSON.parse(
        readFileSync(new URL("../taxonomy.schema.json", import.meta.url), "utf8"),
      ),
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
    actor_isolation: structuredClone(input.actor_isolation),
  };
}

function analyzePolicyDigest(policyInput, policyReference) {
  const computedDigest = sha256Json(policyDigestPayload(policyInput));
  const declaredDigest = policyInput.policy_digest ?? null;
  const referencedDigest = policyReference.digest ?? null;
  return {
    pass:
      declaredDigest === computedDigest && referencedDigest === computedDigest,
    computed_digest: computedDigest,
    declared_digest: declaredDigest,
    referenced_digest: referencedDigest,
  };
}

function analyzePolicyTrustRoot(policyInput, trustRoot, taxonomy) {
  if (!isRecord(trustRoot)) {
    return {
      pass: false,
      available: false,
      issues: ["trust_root_missing"],
    };
  }
  const issues = [];
  const schemaValidation = runSchemaValidator(
    validateTrustRootSchema,
    trustRoot,
  );
  if (!schemaValidation.valid) {
    issues.push(
      ...schemaValidation.errors.map(
        (error) => `schema${error.instance_path}:${error.keyword}`,
      ),
    );
  }
  if (trustRoot.record_type !== "promotion_trust_root") {
    issues.push("record_type_mismatch");
  }
  const receiptKeyIds = Array.isArray(trustRoot.receipt_public_keys)
    ? trustRoot.receipt_public_keys
        .filter(isRecord)
        .map((item) => item.key_id)
        .filter(nonEmptyString)
    : [];
  for (const keyId of findDuplicates(receiptKeyIds)) {
    issues.push(`duplicate_receipt_key_id:${keyId}`);
  }
  if (trustRoot.immutable !== true) issues.push("trust_root_not_immutable");
  if (trustRoot.policy_id !== policyInput.policy.id) {
    issues.push("policy_id_mismatch");
  }
  if (trustRoot.policy_version !== policyInput.policy.version) {
    issues.push("policy_version_mismatch");
  }
  if (trustRoot.policy_digest !== policyInput.policy_digest) {
    issues.push("policy_digest_mismatch");
  }
  if (!isRecord(taxonomy)) {
    issues.push("taxonomy_missing");
  } else {
    if (trustRoot.taxonomy_name !== taxonomy.name) {
      issues.push("taxonomy_name_mismatch");
    }
    if (trustRoot.taxonomy_version !== taxonomy.taxonomy_version) {
      issues.push("taxonomy_version_mismatch");
    }
    if (trustRoot.taxonomy_digest !== sha256Json(taxonomy)) {
      issues.push("taxonomy_digest_mismatch");
    }
  }
  return {
    pass: issues.length === 0,
    available: true,
    trust_root_id: trustRoot.trust_root_id ?? null,
    pinned_policy_digest: trustRoot.policy_digest ?? null,
    pinned_taxonomy_digest: trustRoot.taxonomy_digest ?? null,
    issues,
  };
}

function analyzeTrustedRegressionRegistry(run, trustRoot) {
  const issues = [];
  const registry = Array.isArray(trustRoot?.trusted_regression_suites)
    ? trustRoot.trusted_regression_suites.filter(isRecord)
    : [];
  const caseKey = (suite, regressionCase) =>
    [
      suite.suite_id,
      suite.suite_version,
      suite.suite_digest,
      regressionCase.case_id,
      regressionCase.case_digest,
    ].join("\u0000");
  const requiredCaseKeys = new Set();
  const observedCaseKeys = new Set();
  const suitesByIdentity = new Map();
  for (const suite of registry) {
    const suiteKey = `${suite.suite_id ?? ""}\u0000${suite.suite_version ?? ""}`;
    const matches = suitesByIdentity.get(suiteKey) ?? [];
    matches.push(suite);
    suitesByIdentity.set(suiteKey, matches);
    const caseIds = Array.isArray(suite.cases)
      ? suite.cases.filter(isRecord).map((item) => item.case_id)
      : [];
    for (const caseId of findDuplicates(caseIds)) {
      issues.push(`duplicate_registry_case:${suiteKey}:${caseId}`);
    }
    for (const regressionCase of Array.isArray(suite.cases)
      ? suite.cases.filter(isRecord)
      : []) {
      if (regressionCase.required_for_promotion === true) {
        requiredCaseKeys.add(caseKey(suite, regressionCase));
        if (regressionCase.failure_policy !== "hard_veto") {
          issues.push(`required_case_not_hard_veto:${suiteKey}:${regressionCase.case_id}`);
        }
      }
    }
  }
  for (const [suiteKey, matches] of suitesByIdentity) {
    if (matches.length > 1) {
      issues.push(`duplicate_registry_suite:${suiteKey}`);
    }
  }
  if (requiredCaseKeys.size === 0) {
    issues.push("required_regression_registry_empty");
  }
  for (const check of run?.regression_checks ?? []) {
    const suiteKey = `${check.suite_id ?? ""}\u0000${check.suite_version ?? ""}`;
    const suiteMatches = suitesByIdentity.get(suiteKey) ?? [];
    if (suiteMatches.length !== 1) {
      issues.push(
        `${suiteMatches.length === 0 ? "unregistered" : "ambiguous"}_regression_suite:${check.check_id}`,
      );
      continue;
    }
    const suite = suiteMatches[0];
    if (
      suite.suite_digest !== check.suite_digest ||
      suite.digest_rule !== "sha256_rfc8785_json" ||
      !nonEmptyString(suite.suite_uri)
    ) {
      issues.push(`regression_suite_commitment_mismatch:${check.check_id}`);
    }
    const caseMatches = Array.isArray(suite.cases)
      ? suite.cases.filter(
          (item) => isRecord(item) && item.case_id === check.case_id,
        )
      : [];
    if (caseMatches.length !== 1) {
      issues.push(
        `${caseMatches.length === 0 ? "unregistered" : "ambiguous"}_regression_case:${check.check_id}`,
      );
      continue;
    }
    const regressionCase = caseMatches[0];
    observedCaseKeys.add(caseKey(suite, regressionCase));
    if (
      regressionCase.case_digest !== check.case_digest ||
      regressionCase.digest_rule !== "sha256_rfc8785_json" ||
      !nonEmptyString(regressionCase.case_uri)
    ) {
      issues.push(`regression_case_commitment_mismatch:${check.check_id}`);
    }
    if (
      regressionCase.failure_policy === "hard_veto" &&
      check.hard_veto !== true
    ) {
      issues.push(`registered_regression_not_hard_veto:${check.check_id}`);
    }
  }
  for (const requiredCaseKey of requiredCaseKeys) {
    if (!observedCaseKeys.has(requiredCaseKey)) {
      issues.push(`required_regression_case_missing:${requiredCaseKey}`);
    }
  }
  return {
    pass: issues.length === 0,
    registered_suite_count: registry.length,
    checked_case_count: run?.regression_checks?.length ?? 0,
    required_case_count: requiredCaseKeys.size,
    required_cases_observed: [...requiredCaseKeys].filter((key) =>
      observedCaseKeys.has(key),
    ).length,
    issues: [...new Set(issues)].sort(),
  };
}

function analyzeTrustedProvenance(
  policyInput,
  run,
  artifactBundle,
  trustRoot,
) {
  const trace =
    artifactBundle?.diagnostic_trace ?? artifactBundle?.diagnosticTrace;
  const repair = artifactBundle?.repair_attempt ?? artifactBundle?.repairAttempt;
  const records = [policyInput, trace, repair, run].filter(Boolean);
  const issues = [];
  if (records.length !== 4 || !isRecord(trustRoot)) {
    return {
      pass: false,
      issues: [
        records.length !== 4 ? "record_set_incomplete" : null,
        !isRecord(trustRoot) ? "trust_root_missing" : null,
      ].filter(Boolean),
    };
  }
  const trustedRunners = new Set(
    (Array.isArray(trustRoot.trusted_runners)
      ? trustRoot.trusted_runners
      : []
    ).map((item) => stableStringify(item)),
  );
  const trustedPrompts = new Set(
    (Array.isArray(trustRoot.trusted_prompt_bundles)
      ? trustRoot.trusted_prompt_bundles
      : []
    ).map((item) =>
      stableStringify(item),
    ),
  );
  const digestStatuses = {};
  for (const record of records) {
    const recordType = record.record_type ?? "unknown";
    digestStatuses[recordType] = record.provenance?.digest_status ?? null;
    if (record.provenance?.digest_status !== "verified") {
      issues.push(`${recordType}_digest_status_not_verified`);
    }
    const expectedSchema = LOCAL_RECORD_SCHEMAS.get(recordType);
    if (
      !expectedSchema ||
      stableStringify(record.provenance?.schema) !==
        stableStringify(expectedSchema)
    ) {
      issues.push(`${recordType}_schema_artifact_mismatch`);
    }
    if (
      !trustedRunners.has(stableStringify(record.provenance?.runner ?? null))
    ) {
      issues.push(`${recordType}_runner_not_trusted`);
    }
  }
  const observedPrompts = collectPromptBundleDescriptors(records);
  for (const prompt of observedPrompts) {
    if (!trustedPrompts.has(stableStringify(prompt))) {
      issues.push(`prompt_not_trusted:${prompt.id}@${prompt.version}`);
    }
  }
  return {
    pass: issues.length === 0,
    digest_statuses: digestStatuses,
    observed_prompt_bundles: observedPrompts,
    issues: [...new Set(issues)].sort(),
  };
}

function analyzeRunReceipt(
  policyInput,
  run,
  artifactBundle,
  trustRoot,
  receipt,
) {
  if (!isRecord(receipt)) {
    return { pass: false, available: false, issues: ["receipt_missing"] };
  }
  const issues = [];
  const schemaValidation = runSchemaValidator(validateRunReceiptSchema, receipt);
  if (!schemaValidation.valid) {
    issues.push(
      ...schemaValidation.errors.map(
        (error) => `schema${error.instance_path}:${error.keyword}`,
      ),
    );
  }
  const taxonomy = artifactBundle?.taxonomy;
  const trace =
    artifactBundle?.diagnostic_trace ?? artifactBundle?.diagnosticTrace;
  const repair = artifactBundle?.repair_attempt ?? artifactBundle?.repairAttempt;
  const manifest = run.evaluation_manifest;
  const trustedKeys = Array.isArray(trustRoot?.receipt_public_keys)
    ? trustRoot.receipt_public_keys.filter(isRecord)
    : [];
  if (receipt.policy_digest !== policyInput.policy_digest) {
    issues.push("policy_digest_mismatch");
  }
  if (
    !taxonomy ||
    receipt.taxonomy_digest !== sha256Json(taxonomy)
  ) {
    issues.push("taxonomy_digest_mismatch");
  }
  for (const field of [
    "manifest_id",
    "manifest_version",
    "manifest_digest",
    "frozen_at",
  ]) {
    if (receipt[field] !== manifest?.[field]) {
      issues.push(`${field}_mismatch`);
    }
  }
  const traceDigest = trace ? sha256Json(trace) : null;
  const expectedTraceRef = trace
    ? { ...run.diagnostic_trace_ref, digest: traceDigest }
    : null;
  if (
    !expectedTraceRef ||
    stableStringify(receipt.diagnostic_trace_ref) !==
      stableStringify(expectedTraceRef)
  ) {
    issues.push("diagnostic_trace_ref_mismatch");
  }
  if (receipt.repair_id !== repair?.repair_id) {
    issues.push("repair_id_mismatch");
  }
  const repairGeneratorActorDigest = repair?.actors?.repair_generator
    ? sha256Json(repair.actors.repair_generator)
    : null;
  const repairCriticActorDigest = repair?.actors?.critic
    ? sha256Json(repair.actors.critic)
    : null;
  if (
    receipt.repair_input_digest !== computeRepairInputDigest(trace, repair) ||
    receipt.baseline_digest !== repair?.candidates?.baseline?.digest ||
    receipt.repair_generator_actor_digest !== repairGeneratorActorDigest ||
    receipt.repair_critic_actor_digest !== repairCriticActorDigest ||
    receipt.evaluation_invocation_plan_digest !==
      computeEvaluationInvocationPlanDigest(run) ||
    receipt.blinding_protocol_digest !==
      computeBlindingProtocolDigest(run) ||
    receipt.mapping_visible_to_repairer !== false
  ) {
    issues.push("repair_precommit_binding_invalid");
  }
  if (receipt.verification_id !== run.verification_id) {
    issues.push("verification_id_mismatch");
  }
  const rawGenerationPrecommits = Array.isArray(receipt.generation_precommits)
    ? receipt.generation_precommits
    : [];
  const generationPrecommits = rawGenerationPrecommits.filter(isRecord);
  if (generationPrecommits.length !== rawGenerationPrecommits.length) {
    issues.push("generation_precommit_malformed");
  }
  const expectedOutputTurnIds = [
    ...new Set(trace?.subject?.generator_output_turn_ids ?? []),
  ].sort();
  const committedOutputTurnIds = generationPrecommits
    .map((item) => item.output_turn_id)
    .sort();
  if (
    expectedOutputTurnIds.length === 0 ||
    stableStringify(committedOutputTurnIds) !==
      stableStringify(expectedOutputTurnIds)
  ) {
    issues.push("generation_precommit_coverage_mismatch");
  }
  const turnById = new Map(
    (trace?.subject?.turns ?? []).map((turn) => [turn.turn_id, turn]),
  );
  const sceneById = new Map(
    (trace?.subject?.scenes ?? []).map((scene) => [scene.scene_id, scene]),
  );
  const observedNonces = new Set([receipt.single_use_nonce]);
  const experimentPlanDigest = trace?.experiment_ledger
    ? computeExperimentPlanDigest(trace.experiment_ledger)
    : null;
  const trustRootDigest = isRecord(trustRoot) ? sha256Json(trustRoot) : null;
  for (const precommit of generationPrecommits) {
    const outputTurn = turnById.get(precommit.output_turn_id);
    const scene = sceneById.get(outputTurn?.scene_id);
    const generatorActorDigest = trace?.actors?.generator
      ? sha256Json(trace.actors.generator)
      : null;
    const contractCriticActorDigest = trace?.actors?.contract_critic
      ? sha256Json(trace.actors.contract_critic)
      : null;
    const expectedInputDigest = trace
      ? computeGenerationInputDigest(trace, precommit.output_turn_id)
      : null;
    if (
      precommit.subject_record_id !== trace?.subject?.record_id ||
      precommit.scene_id !== outputTurn?.scene_id ||
      !scene ||
      precommit.scene_contract_digest !== scene.contract_digest ||
      precommit.scene_contract_digest !== sha256Json(scene.contract) ||
      precommit.input_digest !== expectedInputDigest ||
      precommit.generator_actor_digest !== generatorActorDigest ||
      precommit.contract_critic_actor_digest !== contractCriticActorDigest ||
      precommit.policy_digest !== policyInput.policy_digest ||
      precommit.taxonomy_digest !==
        (taxonomy ? sha256Json(taxonomy) : null) ||
      precommit.trust_root_id !== trustRoot?.trust_root_id ||
      precommit.trust_root_digest !== trustRootDigest ||
      precommit.experiment_plan_digest !== experimentPlanDigest ||
      precommit.trace_identity_isolation_digest !==
        (trace?.identity_isolation
          ? sha256Json(trace.identity_isolation)
          : null)
    ) {
      issues.push("generation_precommit_binding_invalid");
    }
    if (
      observedNonces.has(precommit.single_use_nonce) ||
      typeof precommit.single_use_nonce !== "string"
    ) {
      issues.push("generation_precommit_nonce_reused");
    }
    observedNonces.add(precommit.single_use_nonce);
    const generationIssuedAt = Date.parse(precommit.issued_at ?? "");
    const outputCreatedAt = Date.parse(outputTurn?.created_at ?? "");
    const outputIndex = (trace?.subject?.turns ?? []).findIndex(
      (turn) => turn.turn_id === precommit.output_turn_id,
    );
    const contextTurns =
      outputIndex >= 0
        ? (trace?.subject?.turns ?? []).slice(0, outputIndex)
        : [];
    const contextBeforePrecommit = contextTurns.every((turn) => {
      const createdAt = Date.parse(turn.created_at ?? "");
      return Number.isFinite(createdAt) && createdAt <= generationIssuedAt;
    });
    const groundingBeforePrecommit = (scene?.contract?.grounding ?? []).every(
      (grounding) => {
        const validatedAt = Date.parse(grounding.validated_at ?? "");
        return Number.isFinite(validatedAt) && validatedAt <= generationIssuedAt;
      },
    );
    if (
      !Number.isFinite(generationIssuedAt) ||
      !Number.isFinite(outputCreatedAt) ||
      outputIndex < 0 ||
      !Number.isFinite(Date.parse(trustRoot?.created_at ?? "")) ||
      generationIssuedAt < Date.parse(trustRoot.created_at) ||
      generationIssuedAt >= outputCreatedAt ||
      !contextBeforePrecommit ||
      !groundingBeforePrecommit
    ) {
      issues.push("generation_precommit_timeline_invalid");
    }
    const generationKey = trustedKeys.find(
      (item) => item.key_id === precommit.signature?.key_id,
    );
    if (
      !generationKey ||
      generationKey.algorithm !== precommit.signature?.algorithm ||
      generationKey.issuer_id !== precommit.issuer_id ||
      precommit.issuer_id !== receipt.issuer_id
    ) {
      issues.push("generation_precommit_key_not_trusted");
    } else {
      try {
        const validSignature = verifySignature(
          null,
          Buffer.from(
            canonicalJson(generationPrecommitPayload(precommit)),
            "utf8",
          ),
          generationKey.public_key_pem,
          Buffer.from(precommit.signature.value, "base64"),
        );
        if (!validSignature) issues.push("generation_precommit_signature_invalid");
      } catch {
        issues.push("generation_precommit_signature_invalid");
      }
    }
  }
  const rawDiagnosticPrecommits = Array.isArray(receipt.diagnostic_precommits)
    ? receipt.diagnostic_precommits
    : [];
  const diagnosticPrecommits = rawDiagnosticPrecommits.filter(isRecord);
  if (diagnosticPrecommits.length !== rawDiagnosticPrecommits.length) {
    issues.push("diagnostic_precommit_malformed");
  }
  const diagnosticOutputTurnIds = diagnosticPrecommits
    .map((item) => item.output_turn_id)
    .sort();
  if (
    stableStringify(diagnosticOutputTurnIds) !==
    stableStringify(expectedOutputTurnIds)
  ) {
    issues.push("diagnostic_precommit_coverage_mismatch");
  }
  const generationByOutputTurn = new Map(
    generationPrecommits.map((item) => [item.output_turn_id, item]),
  );
  const criticActorDigest = trace?.actors?.critic
    ? sha256Json(trace.actors.critic)
    : null;
  const testJudgeActorDigest = trace?.actors?.test_judge
    ? sha256Json(trace.actors.test_judge)
    : null;
  for (const precommit of diagnosticPrecommits) {
    const outputTurn = turnById.get(precommit.output_turn_id);
    const generationPrecommit = generationByOutputTurn.get(
      precommit.output_turn_id,
    );
    if (
      !outputTurn ||
      precommit.generation_request_id !==
        generationPrecommit?.generation_request_id ||
      precommit.output_digest !== sha256Text(outputTurn?.content ?? "") ||
      precommit.critic_actor_digest !== criticActorDigest ||
      precommit.test_judge_actor_digest !== testJudgeActorDigest ||
      precommit.taxonomy_digest !==
        (taxonomy ? sha256Json(taxonomy) : null) ||
      precommit.experiment_plan_digest !== experimentPlanDigest ||
      precommit.trace_identity_isolation_digest !==
        (trace?.identity_isolation
          ? sha256Json(trace.identity_isolation)
          : null)
    ) {
      issues.push("diagnostic_precommit_binding_invalid");
    }
    if (
      observedNonces.has(precommit.single_use_nonce) ||
      typeof precommit.single_use_nonce !== "string"
    ) {
      issues.push("diagnostic_precommit_nonce_reused");
    }
    observedNonces.add(precommit.single_use_nonce);
    const diagnosticIssuedAt = Date.parse(precommit.issued_at ?? "");
    const outputCreatedAt = Date.parse(outputTurn?.created_at ?? "");
    const relevantTestTimes = (trace?.findings ?? []).flatMap((finding) =>
      (finding.taxonomy_test_results ?? [])
        .filter(
          (result) =>
            result.execution?.intervention?.target_turn_id ===
            precommit.output_turn_id,
        )
        .map((result) => Date.parse(result.execution?.executed_at ?? "")),
    );
    if (
      !Number.isFinite(diagnosticIssuedAt) ||
      !Number.isFinite(outputCreatedAt) ||
      diagnosticIssuedAt < outputCreatedAt ||
      diagnosticIssuedAt >= Date.parse(trace?.provenance?.created_at ?? "") ||
      relevantTestTimes.some(
        (time) => !Number.isFinite(time) || diagnosticIssuedAt >= time,
      )
    ) {
      issues.push("diagnostic_precommit_timeline_invalid");
    }
    const diagnosticKey = trustedKeys.find(
      (item) => item.key_id === precommit.signature?.key_id,
    );
    if (
      !diagnosticKey ||
      diagnosticKey.algorithm !== precommit.signature?.algorithm ||
      diagnosticKey.issuer_id !== precommit.issuer_id ||
      precommit.issuer_id !== receipt.issuer_id
    ) {
      issues.push("diagnostic_precommit_key_not_trusted");
    } else {
      try {
        const validSignature = verifySignature(
          null,
          Buffer.from(
            canonicalJson(diagnosticPrecommitPayload(precommit)),
            "utf8",
          ),
          diagnosticKey.public_key_pem,
          Buffer.from(precommit.signature.value, "base64"),
        );
        if (!validSignature) issues.push("diagnostic_precommit_signature_invalid");
      } catch {
        issues.push("diagnostic_precommit_signature_invalid");
      }
    }
  }
  const primaryPrecommit = generationPrecommits.find(
    (item) => item.output_turn_id === trace?.subject?.generator_output_turn_id,
  );
  if (receipt.input_digest !== trace?.subject?.input_digest) {
    issues.push("input_digest_mismatch");
  }
  if (
    !primaryPrecommit ||
    receipt.input_digest !== primaryPrecommit.input_digest
  ) {
    issues.push("primary_generation_input_digest_mismatch");
  }
  if (
    receipt.experiment_ledger_digest !==
    (trace?.experiment_ledger ? sha256Json(trace.experiment_ledger) : null)
  ) {
    issues.push("experiment_ledger_digest_mismatch");
  }
  const completion = receipt.completion;
  if (completion?.diagnostic_trace_digest !== traceDigest) {
    issues.push("completion_trace_digest_mismatch");
  }
  const repairDigest = repair ? sha256Json(repair) : null;
  if (completion?.repair_attempt_digest !== repairDigest) {
    issues.push("completion_repair_digest_mismatch");
  }
  const verificationDigest = computeVerificationRunAttestationDigest(run);
  if (completion?.verification_run_digest !== verificationDigest) {
    issues.push("completion_verification_digest_mismatch");
  }
  if (
    completion?.candidate_digest !== repair?.candidates?.candidate?.digest
  ) {
    issues.push("completion_candidate_digest_mismatch");
  }
  const verificationPrecommit = receipt.verification_precommit;
  const expectedRepeatInputDigest =
    trace && repair && taxonomy
      ? computeRepeatInputDigest(policyInput, run, {
          diagnostic_trace: trace,
          repair_attempt: repair,
          taxonomy,
        })
      : null;
  if (
    !isRecord(verificationPrecommit) ||
    verificationPrecommit.repair_attempt_digest !== repairDigest ||
    verificationPrecommit.baseline_digest !==
      repair?.candidates?.baseline?.digest ||
    verificationPrecommit.candidate_digest !==
      repair?.candidates?.candidate?.digest ||
    verificationPrecommit.manifest_digest !== manifest?.manifest_digest ||
    verificationPrecommit.repeat_input_digest !== expectedRepeatInputDigest ||
    verificationPrecommit.repeat_plan_digest !== computeRepeatPlanDigest(run) ||
    verificationPrecommit.judge_actor_set_digest !==
      computeJudgeActorSetDigest(run) ||
    verificationPrecommit.blinding_mapping_digest !==
      run?.blinding?.mapping_digest
  ) {
    issues.push("verification_precommit_binding_invalid");
  }
  if (
    !isRecord(verificationPrecommit) ||
    observedNonces.has(verificationPrecommit.single_use_nonce) ||
    typeof verificationPrecommit.single_use_nonce !== "string"
  ) {
    issues.push("verification_precommit_nonce_reused");
  } else {
    observedNonces.add(verificationPrecommit.single_use_nonce);
  }
  const verificationIssuedAt = Date.parse(
    verificationPrecommit?.issued_at ?? "",
  );
  const verificationRepeatTimes = (run?.repeat_manifest ?? []).map((entry) =>
    Date.parse(entry.executed_at ?? ""),
  );
  const verificationInvocationTimes = [
    ...(run?.order_trials ?? []),
    ...(run?.evidence_checks ?? []),
    ...(run?.target_failure_checks ?? []),
    ...(run?.counterfactual_checks ?? []),
    ...(run?.regression_checks ?? []),
    ...(run?.challenge_invocations ?? []),
  ].map((entry) => Date.parse(entry.executed_at ?? ""));
  if (
    !Number.isFinite(verificationIssuedAt) ||
    verificationIssuedAt < Date.parse(repair?.provenance?.created_at ?? "") ||
    verificationRepeatTimes.length === 0 ||
    [...verificationRepeatTimes, ...verificationInvocationTimes].some(
      (time) => !Number.isFinite(time) || verificationIssuedAt >= time,
    )
  ) {
    issues.push("verification_precommit_timeline_invalid");
  }
  const verificationKey = trustedKeys.find(
    (item) => item.key_id === verificationPrecommit?.signature?.key_id,
  );
  if (
    !verificationKey ||
    verificationKey.algorithm !== verificationPrecommit?.signature?.algorithm ||
    verificationKey.issuer_id !== verificationPrecommit?.issuer_id ||
    verificationPrecommit?.issuer_id !== receipt.issuer_id
  ) {
    issues.push("verification_precommit_key_not_trusted");
  } else {
    try {
      const validSignature = verifySignature(
        null,
        Buffer.from(
          canonicalJson(verificationPrecommitPayload(receipt)),
          "utf8",
        ),
        verificationKey.public_key_pem,
        Buffer.from(verificationPrecommit.signature.value, "base64"),
      );
      if (!validSignature) issues.push("verification_precommit_signature_invalid");
    } catch {
      issues.push("verification_precommit_signature_invalid");
    }
  }
  const frozenAt = Date.parse(receipt.frozen_at ?? "");
  const issuedAt = Date.parse(receipt.issued_at ?? "");
  const traceCreatedAt = Date.parse(trace?.provenance?.created_at ?? "");
  const trustRootCreatedAt = Date.parse(trustRoot?.created_at ?? "");
  const repairCreatedAt = Date.parse(repair?.provenance?.created_at ?? "");
  const completedAt = Date.parse(completion?.completed_at ?? "");
  // verification_run.provenance.created_at is the time the run record was
  // instantiated. Every repeat therefore executes at or after this timestamp;
  // neither the run nor a repeat can predate its candidate or postdate completion.
  const runCreatedAt = Date.parse(run?.provenance?.created_at ?? "");
  const repeatExecutionAts = (run?.repeat_manifest ?? []).map((entry) =>
    Date.parse(entry.executed_at ?? ""),
  );
  const invocationExecutionAts = [
    ...(run?.order_trials ?? []),
    ...(run?.evidence_checks ?? []),
    ...(run?.target_failure_checks ?? []),
    ...(run?.counterfactual_checks ?? []),
    ...(run?.regression_checks ?? []),
    ...(run?.challenge_invocations ?? []),
  ].map((entry) => Date.parse(entry.executed_at ?? ""));
  const latestExecutionAt = Math.max(
    runCreatedAt,
    ...repeatExecutionAts,
    ...invocationExecutionAts,
  );
  const executionsWithinCandidateWindow =
    Number.isFinite(repairCreatedAt) &&
    Number.isFinite(completedAt) &&
    Number.isFinite(runCreatedAt) &&
    runCreatedAt >= repairCreatedAt &&
    runCreatedAt <= completedAt &&
    repeatExecutionAts.every(
      (executedAt) =>
        Number.isFinite(executedAt) &&
        executedAt >= runCreatedAt &&
        executedAt <= completedAt,
    ) &&
    invocationExecutionAts.every(
      (executedAt) =>
        Number.isFinite(executedAt) &&
        executedAt >= runCreatedAt &&
        executedAt <= completedAt,
    );
  if (
    !Number.isFinite(frozenAt) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(traceCreatedAt) ||
    !Number.isFinite(trustRootCreatedAt) ||
    !Number.isFinite(repairCreatedAt) ||
    !Number.isFinite(completedAt) ||
    !Number.isFinite(runCreatedAt) ||
    !Number.isFinite(latestExecutionAt) ||
    issuedAt < traceCreatedAt ||
    issuedAt < trustRootCreatedAt ||
    issuedAt < frozenAt ||
    issuedAt >= repairCreatedAt ||
    completedAt < repairCreatedAt ||
    completedAt < latestExecutionAt ||
    !executionsWithinCandidateWindow
  ) {
    issues.push("receipt_timeline_invalid");
  }
  const trustedKey = trustedKeys.find(
    (item) => item.key_id === receipt.signature?.key_id,
  );
  if (
    !trustedKey ||
    trustedKey.algorithm !== receipt.signature?.algorithm ||
    trustedKey.issuer_id !== receipt.issuer_id
  ) {
    issues.push("signing_key_not_trusted");
  } else {
    try {
      const validSignature = verifySignature(
        null,
        Buffer.from(canonicalJson(promotionRunReceiptPayload(receipt)), "utf8"),
        trustedKey.public_key_pem,
        Buffer.from(receipt.signature.value, "base64"),
      );
      if (!validSignature) issues.push("signature_invalid");
    } catch {
      issues.push("signature_invalid");
    }
  }
  const completionKey = trustedKeys.find(
    (item) => item.key_id === completion?.signature?.key_id,
  );
  if (
    !completionKey ||
    completionKey.algorithm !== completion?.signature?.algorithm ||
    completionKey.issuer_id !== receipt.issuer_id
  ) {
    issues.push("completion_signing_key_not_trusted");
  } else {
    try {
      const validSignature = verifySignature(
        null,
        Buffer.from(
          canonicalJson(promotionRunCompletionPayload(receipt)),
          "utf8",
        ),
        completionKey.public_key_pem,
        Buffer.from(completion.signature.value, "base64"),
      );
      if (!validSignature) issues.push("completion_signature_invalid");
    } catch {
      issues.push("completion_signature_invalid");
    }
  }
  return {
    pass: issues.length === 0,
    available: true,
    receipt_id: receipt.receipt_id ?? null,
    generation_precommit_count: generationPrecommits.length,
    diagnostic_precommit_count: diagnosticPrecommits.length,
    key_id: receipt.signature?.key_id ?? null,
    verification_key_id: verificationPrecommit?.signature?.key_id ?? null,
    completion_key_id: completion?.signature?.key_id ?? null,
    issues: [...new Set(issues)].sort(),
  };
}

function policyDigestPayload(policyInput) {
  const payload = {
    schema_version: policyInput.schema_version,
    mode: policyInput.mode,
    provenance: policyInput.provenance,
    policy: policyInput.policy,
    actor_isolation: policyInput.actor_isolation,
    verification_protocol: policyInput.verification_protocol,
    promotion_lifecycle: policyInput.promotion_lifecycle,
    rollback_policy: policyInput.rollback_policy,
  };
  if (policyInput.supersedes_ref) {
    payload.supersedes_ref = policyInput.supersedes_ref;
  }
  return payload;
}

function analyzeArtifactBundle(policyInput, run, artifactBundle) {
  if (!isRecord(artifactBundle)) {
    return {
      pass: false,
      available: false,
      schema_valid: false,
      issues: ["bundle_missing"],
    };
  }
  const trace =
    artifactBundle.diagnostic_trace ?? artifactBundle.diagnosticTrace ?? null;
  const repair =
    artifactBundle.repair_attempt ?? artifactBundle.repairAttempt ?? null;
  const taxonomy = artifactBundle.taxonomy ?? null;
  if (!trace || !repair || !taxonomy) {
    return {
      pass: false,
      available: false,
      issues: [
        !trace ? "diagnostic_trace_missing" : null,
        !repair ? "repair_attempt_missing" : null,
        !taxonomy ? "taxonomy_missing" : null,
      ].filter(Boolean),
    };
  }

  const issues = [];
  for (const [name, validator, value] of [
    ["diagnostic_trace", validateDiagnosticTraceSchema, trace],
    ["repair_attempt", validateRepairAttemptSchema, repair],
    ["taxonomy", validateTaxonomySchema, taxonomy],
  ]) {
    const validation = runSchemaValidator(validator, value);
    if (!validation.valid) {
      issues.push(
        ...validation.errors.map(
          (error) => `${name}_schema${error.instance_path}:${error.keyword}`,
        ),
      );
    }
  }
  if (issues.length > 0) {
    return {
      pass: false,
      available: true,
      schema_valid: false,
      issues: [...new Set(issues)].sort(),
    };
  }
  for (const error of validateTaxonomySemantics(taxonomy).errors) {
    issues.push(`taxonomy_semantics:${error.rule}:${error.message}`);
  }
  for (const message of validateDiagnosticArtifact(trace, taxonomy)) {
    issues.push(`diagnostic_semantics:${message}`);
  }
  for (const integrityIssue of validateMachineBundleIntegrity({
    policy: policyInput,
    trace,
    repair,
    run,
  })) {
    issues.push(
      `machine_bundle_integrity:${integrityIssue.code}:${integrityIssue.key}`,
    );
  }
  const traceDigest = sha256Json(trace);
  const repairDigest = sha256Json(repair);
  const taxonomyDigest = sha256Json(taxonomy);
  const policyDigest = sha256Json(policyDigestPayload(policyInput));

  checkReference(
    run.diagnostic_trace_ref,
    trace.trace_id,
    traceDigest,
    "diagnostic_trace",
    issues,
    "run.diagnostic_trace_ref",
  );
  checkReference(
    run.repair_attempt_ref,
    repair.repair_id,
    repairDigest,
    "repair_attempt",
    issues,
    "run.repair_attempt_ref",
  );
  checkReference(
    repair.diagnostic_trace_ref,
    trace.trace_id,
    traceDigest,
    "diagnostic_trace",
    issues,
    "repair.diagnostic_trace_ref",
  );
  if (run.diagnostic_trace_ref?.uri !== repair.diagnostic_trace_ref?.uri) {
    issues.push("diagnostic_trace_ref_uri_mismatch");
  }
  for (const [name, reference] of [
    ["trace.policy_ref", trace.policy_ref],
    ["repair.policy_ref", repair.policy_ref],
    ["run.policy_ref", run.policy_ref],
  ]) {
    if (
      reference?.record_id !== policyInput.policy.id ||
      reference?.policy_version !== policyInput.policy.version ||
      reference?.digest !== policyDigest
    ) {
      issues.push(`${name}_mismatch`);
    }
  }
  for (const [name, record, recordType, currentId] of [
    ["policy", policyInput, "evolution_policy", policyInput.policy.id],
    ["trace", trace, "diagnostic_trace", trace.trace_id],
    ["repair", repair, "repair_attempt", repair.repair_id],
    ["run", run, "verification_run", run.verification_id],
  ]) {
    checkSupersedesReference(
      record.supersedes_ref,
      recordType,
      currentId,
      issues,
      `${name}.supersedes_ref`,
    );
  }

  for (const [name, record] of [
    ["policy", policyInput],
    ["trace", trace],
    ["repair", repair],
    ["run", run],
  ]) {
    if (
      record.provenance?.taxonomy?.version !== taxonomy.taxonomy_version ||
      record.provenance?.taxonomy?.digest !== taxonomyDigest
    ) {
      issues.push(`${name}_taxonomy_binding_mismatch`);
    }
  }

  const generatorTurn = (trace.subject?.turns ?? []).find(
    (turn) => turn.turn_id === trace.subject?.generator_output_turn_id,
  );
  if (
    !generatorTurn ||
    generatorTurn.speaker !== "assistant" ||
    generatorTurn.content !== repair.candidates?.baseline?.content
  ) {
    issues.push("baseline_source_mismatch");
  }
  for (const candidateId of ["baseline", "candidate"]) {
    const candidate = repair.candidates?.[candidateId];
    if (!candidate || !digestMatchesText(candidate.content, candidate.digest)) {
      issues.push(`${candidateId}_content_digest_mismatch`);
    }
    if (run.candidates?.[candidateId]?.digest !== candidate?.digest) {
      issues.push(`${candidateId}_run_digest_mismatch`);
    }
  }
  if (
    repair.candidates?.baseline?.content === repair.candidates?.candidate?.content
  ) {
    issues.push("candidate_content_unchanged");
  }

  return {
    pass: issues.length === 0,
    available: true,
    schema_valid: true,
    issues: [...new Set(issues)].sort(),
    digests: {
      policy: policyDigest,
      taxonomy: taxonomyDigest,
      diagnostic_trace: traceDigest,
      repair_attempt: repairDigest,
    },
  };
}

function checkReference(
  reference,
  expectedId,
  expectedDigest,
  expectedRecordType,
  issues,
  name,
) {
  if (
    reference?.record_id !== expectedId ||
    reference?.digest !== expectedDigest
  ) {
    issues.push(`${name}_mismatch`);
  }
  const expectedSchema = LOCAL_RECORD_SCHEMAS.get(expectedRecordType);
  if (
    !expectedSchema ||
    reference?.schema_id !== expectedSchema.id ||
    reference?.schema_version !== expectedSchema.version
  ) {
    issues.push(`${name}_schema_identity_mismatch`);
  }
}

function checkSupersedesReference(
  reference,
  expectedRecordType,
  currentId,
  issues,
  name,
) {
  if (!reference) return;
  const expectedSchema = LOCAL_RECORD_SCHEMAS.get(expectedRecordType);
  if (
    !expectedSchema ||
    reference.schema_id !== expectedSchema.id ||
    reference.schema_version !== expectedSchema.version
  ) {
    issues.push(`${name}_schema_identity_mismatch`);
  }
  if (reference.record_id === currentId) {
    issues.push(`${name}_self_reference`);
  }
}

function analyzePromotionArtifact(run, artifactBundle) {
  const artifact = run.promotion_artifact;
  if (!isRecord(artifact) || !isRecord(artifact.payload)) {
    return { pass: false, bound: false, issues: ["artifact_missing"] };
  }
  const issues = [];
  const computedDigest = sha256Json(artifact.payload);
  if (artifact.artifact_digest !== computedDigest) {
    issues.push("payload_digest_mismatch");
  }

  const idFields = {
    repair_case: "case_id",
    repair_strategy: "strategy_id",
    critic_rule: "rule_id",
    prompt_bundle: "bundle_id",
    regression_case: "suite_id",
    taxonomy_proposal: "proposal_id",
  };
  const idField = idFields[artifact.target];
  if (!idField || artifact.payload[idField] !== artifact.artifact_id) {
    issues.push("artifact_id_payload_mismatch");
  }

  const repair =
    artifactBundle?.repair_attempt ?? artifactBundle?.repairAttempt ?? null;
  if (artifact.target === "repair_case") {
    if (
      artifact.payload.case_version !== artifact.artifact_version ||
      artifact.payload.repair_id !== repair?.repair_id ||
      artifact.payload.candidate_digest !== run.candidates.candidate.digest ||
      artifact.payload.strategy_id !== repair?.repair_plan?.strategy_id ||
      artifact.payload.strategy_version !==
        repair?.repair_plan?.strategy_version ||
      artifact.payload.hypothesis !== repair?.repair_plan?.hypothesis ||
      artifact.payload.minimality_rule !== repair?.repair_plan?.minimality_rule ||
      stableStringify([...(artifact.payload.target_finding_ids ?? [])].sort()) !==
        stableStringify([...(repair?.target_finding_ids ?? [])].sort())
    ) {
      issues.push("repair_case_payload_mismatch");
    }
    const repairDigest = repair ? sha256Json(repair) : null;
    const expectedSourceRef = {
      ...run.repair_attempt_ref,
      digest: repairDigest,
    };
    if (
      stableStringify(artifact.source_ref) !==
      stableStringify(expectedSourceRef)
    ) {
      issues.push("repair_case_source_mismatch");
    }
  }
  return {
    pass: issues.length === 0,
    bound: true,
    target: artifact.target,
    artifact_id: artifact.artifact_id,
    computed_digest: computedDigest,
    declared_digest: artifact.artifact_digest,
    issues: [...new Set(issues)].sort(),
  };
}

function analyzeEvaluationManifest(run, artifactBundle) {
  const manifest = run.evaluation_manifest;
  if (!isRecord(manifest)) {
    return { pass: false, issues: ["manifest_missing"] };
  }
  const withoutDigest = { ...manifest };
  delete withoutDigest.manifest_digest;
  const computedDigest = sha256Json(withoutDigest);
  const issues = [];
  if (manifest.manifest_digest !== computedDigest) {
    issues.push("manifest_digest_mismatch");
  }
  const idFields = {
    evidence_checks: "check_id",
    target_failure_checks: "check_id",
    counterfactual_checks: "check_id",
    regression_checks: "check_id",
    order_trials: "trial_id",
  };
  const observedCommitments = computeEvaluationCaseCommitments(run);
  for (const [collection, idField] of Object.entries(idFields)) {
    const observed = (run[collection] ?? []).map((item) => item[idField]);
    const expected = manifest.expected_case_ids?.[collection] ?? [];
    if (
      findDuplicates(observed).length > 0 ||
      stableStringify([...observed].sort()) !==
        stableStringify([...expected].sort())
    ) {
      issues.push(`${collection}_set_mismatch`);
    }
    const expectedCommitments =
      manifest.expected_case_digests?.[collection] ?? [];
    const expectedCommitmentIds = expectedCommitments.map(
      (item) => item.item_id,
    );
    const normalizeCommitments = (items) =>
      [...items].sort((left, right) =>
        `${left.item_id}\u0000${left.digest}`.localeCompare(
          `${right.item_id}\u0000${right.digest}`,
        ),
      );
    if (
      findDuplicates(expectedCommitmentIds).length > 0 ||
      stableStringify(normalizeCommitments(expectedCommitments)) !==
        stableStringify(
          normalizeCommitments(observedCommitments[collection] ?? []),
        )
    ) {
      issues.push(`${collection}_specification_mismatch`);
    }
  }
  const repair =
    artifactBundle?.repair_attempt ?? artifactBundle?.repairAttempt ?? null;
  const commitment = repair?.verification_handoff?.evaluation_manifest_commitment;
  if (
    !commitment ||
    commitment.manifest_id !== manifest.manifest_id ||
    commitment.manifest_version !== manifest.manifest_version ||
    commitment.manifest_digest !== manifest.manifest_digest ||
    commitment.frozen_at !== manifest.frozen_at ||
    commitment.coverage_rule !== manifest.coverage_rule ||
    commitment.commitment_rule !== manifest.commitment_rule
  ) {
    issues.push("repair_commitment_mismatch");
  }
  const frozenAt = Date.parse(manifest.frozen_at);
  const repairCreatedAt = Date.parse(repair?.provenance?.created_at ?? "");
  if (
    !Number.isFinite(frozenAt) ||
    !Number.isFinite(repairCreatedAt) ||
    frozenAt >= repairCreatedAt
  ) {
    issues.push("manifest_not_frozen_before_repair");
  }
  return {
    pass: issues.length === 0,
    computed_digest: computedDigest,
    declared_digest: manifest.manifest_digest,
    issues: [...new Set(issues)].sort(),
  };
}

function analyzeExperimentLedger(run, artifactBundle, runReceipt) {
  const ledger = run.experiment_ledger;
  const issues = [];
  if (!isRecord(ledger)) {
    return { pass: false, issues: ["ledger_missing"] };
  }
  const trace =
    artifactBundle?.diagnostic_trace ?? artifactBundle?.diagnosticTrace;
  const repair =
    artifactBundle?.repair_attempt ?? artifactBundle?.repairAttempt;
  const traceTurnById = new Map(
    (trace?.subject?.turns ?? []).map((turn) => [turn.turn_id, turn]),
  );
  const outputSceneIds = new Set(
    (trace?.subject?.generator_output_turn_ids ?? [])
      .map((turnId) => traceTurnById.get(turnId)?.scene_id)
      .filter(Boolean),
  );
  const contractGroundingBatches = new Set(
    (trace?.subject?.scenes ?? [])
      .filter((scene) => outputSceneIds.has(scene.scene_id))
      .flatMap((scene) => scene.contract?.grounding ?? [])
      .map((grounding) => grounding.validated_at)
      .filter(Boolean),
  ).size;
  const repairStageVisibleCalls =
    (isRecord(repair?.candidates?.candidate) ? 1 : 0) +
    (isRecord(repair?.critic_check) ? 1 : 0);
  const verificationStageVisibleCalls =
    (run?.order_trials?.length ?? 0) +
    (run?.evidence_checks?.length ?? 0) +
    (run?.target_failure_checks?.length ?? 0) +
    (run?.counterfactual_checks?.length ?? 0) +
    (run?.regression_checks?.length ?? 0) +
    (run?.challenge_invocations?.length ?? 0);
  const visibleModelCallLowerBounds = {
    diagnostic_trace:
      (runReceipt?.generation_precommits?.length ?? 0) +
      (runReceipt?.diagnostic_precommits?.length ?? 0) +
      contractGroundingBatches +
      (trace?.findings ?? []).reduce(
        (count, finding) =>
          count +
          (finding.taxonomy_test_results ?? []).filter(
            (result) => isRecord(result.execution),
          ).length,
        0,
      ),
    repair_attempt: 0,
    verification_run: 0,
  };
  visibleModelCallLowerBounds.repair_attempt =
    visibleModelCallLowerBounds.diagnostic_trace +
    repairStageVisibleCalls;
  visibleModelCallLowerBounds.verification_run =
    visibleModelCallLowerBounds.repair_attempt +
    verificationStageVisibleCalls;
  const budget = ledger.budget;
  if (
    budget.candidate_attempts_used > budget.max_candidate_attempts ||
    budget.model_calls_used > budget.max_model_calls ||
    budget.candidate_attempts_used !== ledger.attempt_index ||
    ledger.attempt_index > budget.max_candidate_attempts
  ) {
    issues.push("budget_exceeded_or_inconsistent");
  }
  if (
    budget.model_calls_used < visibleModelCallLowerBounds.verification_run
  ) {
    issues.push("verification_run_model_call_lower_bound_invalid");
  }
  const traceModelCallsUsed =
    trace?.experiment_ledger?.budget?.model_calls_used;
  const repairModelCallsUsed =
    repair?.experiment_ledger?.budget?.model_calls_used;
  if (
    Number.isInteger(traceModelCallsUsed) &&
    Number.isInteger(repairModelCallsUsed) &&
    repairModelCallsUsed < traceModelCallsUsed + repairStageVisibleCalls
  ) {
    issues.push("repair_attempt_model_call_cumulative_invalid");
  }
  if (
    Number.isInteger(repairModelCallsUsed) &&
    Number.isInteger(budget.model_calls_used) &&
    budget.model_calls_used <
      repairModelCallsUsed + verificationStageVisibleCalls
  ) {
    issues.push("verification_run_model_call_cumulative_invalid");
  }
  if (
    ledger.stop_rule.action_when_met !== "halt_and_verify" ||
    ledger.stop_rule.triggered !== true ||
    ledger.stop_rule.triggered_by !== "critic_approval"
  ) {
    issues.push("stop_rule_forbids_promotion");
  }
  if (
    ledger.stop_rule.triggered !==
    (ledger.stop_rule.triggered_by !== "not_triggered")
  ) {
    issues.push("stop_rule_trigger_state_mismatch");
  }
  const stopRuleSpec = (stopRule) => ({
    rule_id: stopRule?.rule_id,
    precommitted: stopRule?.precommitted,
    condition_code: stopRule?.condition_code,
    condition: stopRule?.condition,
    action_when_met: stopRule?.action_when_met,
    action_on_budget_exhaustion: stopRule?.action_on_budget_exhaustion,
  });
  const runStopRuleSpecDigest = sha256Json(stopRuleSpec(ledger.stop_rule));
  for (const [name, record] of [
    ["diagnostic_trace", artifactBundle?.diagnostic_trace ?? artifactBundle?.diagnosticTrace],
    ["repair_attempt", artifactBundle?.repair_attempt ?? artifactBundle?.repairAttempt],
  ]) {
    const other = record?.experiment_ledger;
    const expectedCandidateAttemptsUsed =
      name === "diagnostic_trace"
        ? ledger.attempt_index - 1
        : ledger.attempt_index;
    if (
      !other ||
      other.family_id !== ledger.family_id ||
      other.attempt_id !== ledger.attempt_id ||
      other.attempt_index !== ledger.attempt_index ||
      other.budget?.max_candidate_attempts !== budget.max_candidate_attempts ||
      other.budget?.candidate_attempts_used !== expectedCandidateAttemptsUsed ||
      other.budget?.max_model_calls !== budget.max_model_calls ||
      other.budget?.model_calls_used > budget.model_calls_used ||
      sha256Json(stopRuleSpec(other.stop_rule)) !== runStopRuleSpecDigest
    ) {
      issues.push(`${name}_ledger_mismatch`);
    }
    if (other?.budget?.model_calls_used < visibleModelCallLowerBounds[name]) {
      issues.push(`${name}_model_call_lower_bound_invalid`);
    }
    if (
      other?.stop_rule?.action_when_met !== "halt_and_verify" ||
      (name === "diagnostic_trace" &&
        (other?.stop_rule?.triggered !== false ||
          other?.stop_rule?.triggered_by !== "not_triggered")) ||
      (name === "repair_attempt" &&
        (other?.stop_rule?.triggered !== true ||
          other?.stop_rule?.triggered_by !== "critic_approval"))
    ) {
      issues.push(`${name}_stop_rule_forbids_promotion`);
    }
  }
  if (
    repair?.critic_check?.ready_for_blind_verification !== true ||
    repair?.critic_check?.targeted_failures_reduced !== true
  ) {
    issues.push("critic_approval_not_attested");
  }
  return {
    pass: issues.length === 0,
    family_id: ledger.family_id,
    attempt_id: ledger.attempt_id,
    attempt_index: ledger.attempt_index,
    visible_model_call_lower_bounds: visibleModelCallLowerBounds,
    visible_model_call_stage_deltas: {
      repair_attempt: repairStageVisibleCalls,
      verification_run: verificationStageVisibleCalls,
    },
    issues: [...new Set(issues)].sort(),
  };
}

function analyzeSafetyFloor(thresholds) {
  const violations = [];
  const floor = DEFAULT_POLICY.thresholds;
  if (thresholds.min_independent_judges < floor.min_independent_judges) {
    violations.push("min_independent_judges");
  }
  if (thresholds.min_evidence_coverage < floor.min_evidence_coverage) {
    violations.push("min_evidence_coverage");
  }
  if (
    thresholds.min_counterfactual_pass_rate <
    floor.min_counterfactual_pass_rate
  ) {
    violations.push("min_counterfactual_pass_rate");
  }
  if (
    thresholds.max_regression_failure_rate >
    floor.max_regression_failure_rate
  ) {
    violations.push("max_regression_failure_rate");
  }
  if (thresholds.min_repeat_runs < floor.min_repeat_runs) {
    violations.push("min_repeat_runs");
  }
  return {
    pass: violations.length === 0,
    floor: { ...floor },
    observed: { ...thresholds },
    violations,
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
    decision_version: "2.0.0-alpha.1",
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

function analyzeActorProfiles(run, generator, judges, auditJudges) {
  const profileGenerator = run.actor_profiles.generator;
  const profileJudges = run.actor_profiles.judges;
  const profileAuditJudges = run.actor_profiles.audit_judges;
  const allProfiles = [
    profileGenerator,
    ...profileJudges,
    ...profileAuditJudges,
    ...(run.actor_profiles.critics ?? []),
    run.actor_profiles.aggregator,
  ].filter(Boolean);
  const duplicateProfileIds = findDuplicates(
    allProfiles.map((profile) => profile.id),
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
  const preferenceJudgeIds = new Set(profileJudges.map((profile) => profile.id));
  const channelIdConflicts = profileAuditJudges
    .map((profile) => profile.id)
    .filter((id) => preferenceJudgeIds.has(id))
    .sort();
  const invalidAuditProfiles = auditJudges
    .filter(
      (profile) =>
        !profile?.id ||
        !profile?.origin ||
        profile.role !== "judge" ||
        !nonEmptyString(profile.context_partition),
    )
    .map((profile) => profile?.id ?? "<missing-id>")
    .sort();
  return {
    pass:
      mismatchedIds.length === 0 &&
      duplicateProfileIds.length === 0 &&
      unexpectedProfileIds.length === 0 &&
      channelIdConflicts.length === 0 &&
      invalidAuditProfiles.length === 0,
    mismatched_actor_ids: [...new Set(mismatchedIds)].sort(),
    duplicate_profile_ids: duplicateProfileIds,
    unexpected_profile_ids: unexpectedProfileIds,
    preference_audit_id_conflicts: channelIdConflicts,
    invalid_audit_profile_ids: invalidAuditProfiles,
  };
}

function analyzeIdentityIsolation(run, policy) {
  const profiles = [
    run.actor_profiles.generator,
    ...(run.actor_profiles.judges ?? []),
    ...(run.actor_profiles.audit_judges ?? []),
    ...(run.actor_profiles.critics ?? []),
    run.actor_profiles.aggregator,
  ].filter(Boolean);
  const knownActorIds = new Set(profiles.map((actor) => actor.id));
  const actorById = new Map(
    profiles.map((actor) => [actor.id, actor]),
  );
  const observedPairs = new Map();
  const invalidPairs = [];

  for (const pair of run.identity_isolation?.pairs ?? []) {
    const key = actorPairKey(pair.left_actor_id, pair.right_actor_id);
    const unknown = [pair.left_actor_id, pair.right_actor_id].filter(
      (actorId) => !knownActorIds.has(actorId),
    );
    const pairValidation = validateIdentityIsolationPair({
      record: run,
      pair,
      leftActor: actorById.get(pair.left_actor_id),
      rightActor: actorById.get(pair.right_actor_id),
      policy,
      blinding: run.blinding,
    });
    if (
      pair.left_actor_id === pair.right_actor_id ||
      unknown.length > 0 ||
      !pairValidation.pass ||
      pair.verified !== true ||
      pair.independent_context !== true ||
      observedPairs.has(key)
    ) {
      invalidPairs.push(key);
      continue;
    }
    observedPairs.set(key, pair);
  }

  const requiredPairs = new Set();
  const missingRequiredRoles = [];
  const declaredBoundaries = new Set(
    policy.actor_isolation?.required_pair_boundaries ?? [],
  );
  const generatorId = run.actor_profiles.generator.id;
  const aggregatorId = run.actor_profiles.aggregator.id;
  const judges = run.actor_profiles.judges ?? [];
  const auditJudges = run.actor_profiles.audit_judges ?? [];
  const allJudges = [...judges, ...auditJudges];
  const critics = run.actor_profiles.critics ?? [];
  if (
    declaredBoundaries.has("generator_judge") ||
    declaredBoundaries.has("repairer_judge")
  ) {
    for (const judge of allJudges) {
      requiredPairs.add(actorPairKey(generatorId, judge.id));
    }
  }
  if (declaredBoundaries.has("judge_aggregator")) {
    for (const judge of allJudges) {
      requiredPairs.add(actorPairKey(judge.id, aggregatorId));
    }
  }
  if (declaredBoundaries.has("critic_judge")) {
    if (critics.length === 0) missingRequiredRoles.push("critic");
    for (const critic of critics) {
      for (const judge of allJudges) {
        requiredPairs.add(actorPairKey(critic.id, judge.id));
      }
    }
  }
  if (declaredBoundaries.has("generator_critic")) {
    if (critics.length === 0) missingRequiredRoles.push("critic");
    for (const critic of critics) {
      requiredPairs.add(actorPairKey(generatorId, critic.id));
    }
  }
  if (declaredBoundaries.has("preference_judge_audit_judge")) {
    for (const preferenceJudge of judges) {
      for (const auditJudge of auditJudges) {
        requiredPairs.add(
          actorPairKey(preferenceJudge.id, auditJudge.id),
        );
      }
    }
  }
  const missingPairs = [...requiredPairs]
    .filter((key) => !observedPairs.has(key))
    .sort();
  return {
    pass:
      invalidPairs.length === 0 &&
      missingPairs.length === 0 &&
      missingRequiredRoles.length === 0 &&
      run.identity_isolation?.no_shared_scratchpad === true &&
      run.identity_isolation?.role_prompts_separated === true,
    required_pairs: [...requiredPairs].sort(),
    observed_pairs: [...observedPairs.keys()].sort(),
    missing_pairs: missingPairs,
    missing_required_roles: [...new Set(missingRequiredRoles)].sort(),
    invalid_pairs: [...new Set(invalidPairs)].sort(),
  };
}

function actorPairKey(leftActorId, rightActorId) {
  return [leftActorId, rightActorId].sort().join("<->");
}

function analyzeInvocationIdentityIsolation(run, artifactBundle) {
  const auditInvocations = [
    ...(run?.evidence_checks ?? []),
    ...(run?.target_failure_checks ?? []),
    ...(run?.counterfactual_checks ?? []),
    ...(run?.regression_checks ?? []),
  ];
  const channels = {
    order: run?.order_trials ?? [],
    audit: auditInvocations,
    challenge: run?.challenge_invocations ?? [],
  };
  const allInvocations = Object.values(channels).flat();
  const duplicateValuesForChannel = (channelValues, allValues) => {
    const counts = new Map();
    for (const value of allValues) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [
      ...new Set(channelValues.filter((value) => (counts.get(value) ?? 0) > 1)),
    ].sort();
  };
  const allInvocationIds = allInvocations.map(
    (invocation) => invocation.invocation_id,
  );
  const allInvocationSeeds = allInvocations.map(
    (invocation) => invocation.seed,
  );
  const allInvocationContexts = allInvocations.map((invocation) =>
    normalizeIdentityText(invocation.context_partition),
  );
  const trace =
    artifactBundle?.diagnostic_trace ?? artifactBundle?.diagnosticTrace;
  const repair =
    artifactBundle?.repair_attempt ?? artifactBundle?.repairAttempt;
  const actorContextSet = new Set(
    [
      run?.actor_profiles?.generator,
      ...(run?.actor_profiles?.judges ?? []),
      ...(run?.actor_profiles?.audit_judges ?? []),
      ...(run?.actor_profiles?.critics ?? []),
      run?.actor_profiles?.aggregator,
      ...Object.values(trace?.actors ?? {}),
      ...Object.values(repair?.actors ?? {}),
    ]
      .filter(isRecord)
      .map((actor) => normalizeIdentityText(actor.context_partition))
      .filter(nonEmptyString),
  );
  const result = {};
  for (const [channelName, invocations] of Object.entries(channels)) {
    const invocationIds = invocations.map(
      (invocation) => invocation.invocation_id,
    );
    const invocationSeeds = invocations.map((invocation) => invocation.seed);
    const invocationContexts = invocations.map((invocation) =>
      normalizeIdentityText(invocation.context_partition),
    );
    const duplicateContexts = duplicateValuesForChannel(
      invocationContexts,
      allInvocationContexts,
    );
    // Challenge calls intentionally run in their bound actor's context. Order
    // and audit calls, however, must use fresh execution partitions that do
    // not alias any run or upstream actor profile.
    if (channelName !== "challenge") {
      duplicateContexts.push(
        ...invocationContexts.filter((context) => actorContextSet.has(context)),
      );
    }
    result[channelName] = {
      duplicate_invocation_ids: duplicateValuesForChannel(
        invocationIds,
        allInvocationIds,
      ),
      duplicate_context_partitions: [...new Set(duplicateContexts)].sort(),
      duplicate_invocation_seeds: duplicateValuesForChannel(
        invocationSeeds,
        allInvocationSeeds,
      ),
    };
  }
  return result;
}

function analyzeOrderTrials(
  run,
  judgeIds,
  artifactBundle,
  invocationIdentityMetric,
) {
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
  const duplicateInvocationIds =
    invocationIdentityMetric?.order?.duplicate_invocation_ids ??
    findDuplicates(trials.map((trial) => trial.invocation_id));
  const duplicateContextPartitions =
    invocationIdentityMetric?.order?.duplicate_context_partitions ??
    findDuplicates(
      trials.map((trial) => normalizeIdentityText(trial.context_partition)),
    );
  const duplicateTrialSeeds =
    invocationIdentityMetric?.order?.duplicate_invocation_seeds ??
    findDuplicates(trials.map((trial) => trial.seed));
  const repeatSeedById = new Map(
    run.repeat_manifest.map((entry) => [entry.repeat_id, entry.seed]),
  );
  const seedMismatches = trials
    .filter(
      (trial) =>
        trial.seed !==
        computeOrderTrialSeed(
          repeatSeedById.get(trial.repeat_id),
          trial.judge_id,
          trial.order,
        ),
    )
    .map((trial) => trial.trial_id)
    .sort();
  const preferenceRequestMismatches = trials
    .filter(
      (trial) =>
        trial.preference_request_digest !==
        computePreferenceRequestDigest(run, trial, artifactBundle),
    )
    .map((trial) => trial.trial_id)
    .sort();
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
    duplicateInvocationIds.length === 0 &&
    duplicateContextPartitions.length === 0 &&
    duplicateTrialSeeds.length === 0 &&
    seedMismatches.length === 0 &&
    preferenceRequestMismatches.length === 0 &&
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
    duplicate_invocation_ids: duplicateInvocationIds,
    duplicate_context_partitions: duplicateContextPartitions,
    duplicate_trial_seeds: duplicateTrialSeeds,
    seed_mismatches: seedMismatches,
    preference_request_mismatches: preferenceRequestMismatches,
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

function analyzeCheckReferences(
  run,
  declaredJudgeIds,
  participatingJudgeIds,
  repairTargetFindingIds,
  artifactBundle,
  invocationIdentityMetric,
) {
  const collections = [
    ["evidence_checks", run.evidence_checks],
    ["target_failure_checks", run.target_failure_checks],
    ["counterfactual_checks", run.counterfactual_checks],
    ["regression_checks", run.regression_checks],
  ];
  const checkIds = [];
  const unknownOrInactive = [];
  const semanticKeys = [];
  const incompleteJudgeCoverage = [];
  const targetFindingIds = [...new Set(repairTargetFindingIds)].sort();
  const targetFindingIdSet = new Set(targetFindingIds);
  const targetBoundCollections = new Set([
    "evidence_checks",
    "target_failure_checks",
    "counterfactual_checks",
  ]);
  const targetJudgeSlots = new Map();
  const unexpectedTargetChecks = [];
  const allChecks = [];
  for (const [collectionName, checks] of collections) {
    const collectionJudgeIds = new Set();
    for (const check of checks) {
      allChecks.push({ collectionName, check });
      checkIds.push(check.check_id);
      semanticKeys.push(semanticCheckKey(collectionName, check));
      collectionJudgeIds.add(check.judge_id);
      if (targetBoundCollections.has(collectionName)) {
        const slot = `${collectionName}:${check.finding_id}:${check.judge_id}`;
        const slotChecks = targetJudgeSlots.get(slot) ?? [];
        slotChecks.push(check.check_id);
        targetJudgeSlots.set(slot, slotChecks);
        if (!targetFindingIdSet.has(check.finding_id)) {
          unexpectedTargetChecks.push(
            `${collectionName}:${check.check_id}:${check.finding_id}`,
          );
        }
      }
      if (
        !declaredJudgeIds.has(check.judge_id) ||
        !participatingJudgeIds.has(check.judge_id)
      ) {
        unknownOrInactive.push(
          `${collectionName}:${check.check_id}:${check.judge_id}`,
        );
      }
    }
    for (const judgeId of participatingJudgeIds) {
      if (!collectionJudgeIds.has(judgeId)) {
        incompleteJudgeCoverage.push(`${collectionName}:${judgeId}`);
      }
    }
  }
  const missingTargetJudgeSlots = [];
  const duplicateTargetJudgeSlots = [];
  for (const collectionName of targetBoundCollections) {
    for (const findingId of targetFindingIds) {
      for (const judgeId of participatingJudgeIds) {
        const slot = `${collectionName}:${findingId}:${judgeId}`;
        const count = targetJudgeSlots.get(slot)?.length ?? 0;
        if (count === 0) missingTargetJudgeSlots.push(slot);
        else if (count > 1) duplicateTargetJudgeSlots.push(slot);
      }
    }
  }
  const duplicateCheckIds = findDuplicates(checkIds);
  const duplicateSemanticChecks = findDuplicates(semanticKeys);
  const auditIdentityMetric =
    invocationIdentityMetric?.audit ??
    analyzeInvocationIdentityIsolation(run, artifactBundle).audit;
  const duplicateInvocationIds = auditIdentityMetric.duplicate_invocation_ids;
  const duplicateContextPartitions =
    auditIdentityMetric.duplicate_context_partitions;
  const duplicateInvocationSeeds =
    auditIdentityMetric.duplicate_invocation_seeds;
  const auditJudgeById = new Map(
    (run?.actor_profiles?.audit_judges ?? []).map((judge) => [judge.id, judge]),
  );
  const invocationSeedMismatches = allChecks
    .filter(({ collectionName, check }) => {
      const judge = auditJudgeById.get(check.judge_id);
      return (
        !judge ||
        check.seed !==
          computeAuditCheckSeed(judge.seed, collectionName, check.check_id)
      );
    })
    .map(({ collectionName, check }) => `${collectionName}:${check.check_id}`)
    .sort();
  const auditRequestMismatches = allChecks
    .filter(
      ({ collectionName, check }) =>
        check.audit_request_digest !==
        computeAuditRequestDigest(run, collectionName, check, artifactBundle),
    )
    .map(({ collectionName, check }) => `${collectionName}:${check.check_id}`)
    .sort();
  return {
    pass:
      unknownOrInactive.length === 0 &&
      duplicateCheckIds.length === 0 &&
      duplicateSemanticChecks.length === 0 &&
      incompleteJudgeCoverage.length === 0 &&
      missingTargetJudgeSlots.length === 0 &&
      duplicateTargetJudgeSlots.length === 0 &&
      unexpectedTargetChecks.length === 0 &&
      duplicateInvocationIds.length === 0 &&
      duplicateContextPartitions.length === 0 &&
      duplicateInvocationSeeds.length === 0 &&
      invocationSeedMismatches.length === 0 &&
      auditRequestMismatches.length === 0,
    unknown_or_inactive: unknownOrInactive.sort(),
    duplicate_check_ids: duplicateCheckIds,
    duplicate_semantic_checks: duplicateSemanticChecks,
    incomplete_judge_coverage: incompleteJudgeCoverage.sort(),
    missing_target_judge_slots: missingTargetJudgeSlots.sort(),
    duplicate_target_judge_slots: duplicateTargetJudgeSlots.sort(),
    unexpected_target_checks: unexpectedTargetChecks.sort(),
    duplicate_invocation_ids: duplicateInvocationIds,
    duplicate_context_partitions: duplicateContextPartitions,
    duplicate_invocation_seeds: duplicateInvocationSeeds,
    invocation_seed_mismatches: invocationSeedMismatches,
    audit_request_mismatches: auditRequestMismatches,
  };
}

function semanticCheckKey(collectionName, check) {
  if (collectionName === "evidence_checks") {
    return `${collectionName}:${check.finding_id}:${check.target_turn_id}:${[...(check.evidence_ids ?? [])].sort().join(",")}:${check.judge_id}`;
  }
  if (collectionName === "target_failure_checks") {
    return `${collectionName}:${check.finding_id}:${check.target_turn_id}:${check.judge_id}`;
  }
  if (collectionName === "counterfactual_checks") {
    return `${collectionName}:${check.finding_id}:${check.target_turn_id}:${check.source_execution_digest}:${check.judge_id}`;
  }
  return `${collectionName}:${check.suite_digest}:${check.case_digest}:${check.judge_id}`;
}

function analyzeRepeatManifest(
  policyInput,
  run,
  artifactBundle,
  manifest,
  actualRepeatIds,
  declaredRepeatCount,
) {
  const manifestIds = manifest.map((entry) => entry.repeat_id).sort();
  const duplicateIds = findDuplicates(manifestIds);
  const duplicateSeeds = findDuplicates(manifest.map((entry) => entry.seed));
  const duplicateRunDigests = findDuplicates(
    manifest.map((entry) => entry.run_digest),
  );
  const inputDigests = [
    ...new Set(manifest.map((entry) => entry.input_digest)),
  ].sort();
  const expectedInputDigest = computeRepeatInputDigest(
    policyInput,
    run,
    artifactBundle,
  );
  const inputBindingsPass =
    expectedInputDigest !== null &&
    manifest.every((entry) => entry.input_digest === expectedInputDigest);
  const runDigestMismatches = manifest
    .filter(
      (entry) => entry.run_digest !== computeRepeatRunDigest(run, entry),
    )
    .map((entry) => entry.repeat_id)
    .sort();
  const digestBindingsPass =
    inputBindingsPass && runDigestMismatches.length === 0;
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
      duplicateRunDigests.length === 0 &&
      inputDigests.length === 1 &&
      digestBindingsPass,
    ids_match: idsMatch,
    count_matches: countMatches,
    manifest_ids: manifestIds,
    actual_trial_repeat_ids: actualRepeatIds,
    duplicate_repeat_ids: duplicateIds,
    duplicate_seeds: duplicateSeeds,
    duplicate_run_digests: duplicateRunDigests,
    input_digests_match: inputDigests.length === 1 && inputBindingsPass,
    input_digests: inputDigests,
    expected_input_digest: expectedInputDigest,
    run_digest_mismatch_repeat_ids: runDigestMismatches,
    digest_bindings_pass: digestBindingsPass,
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
    .filter((check) => check.candidate_present === true)
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

function measureBooleanRatio(
  input,
  positiveField,
  threshold,
  direction,
  judgeIds = [],
) {
  const total = input.length;
  const positive = input.filter((item) => item[positiveField] === true).length;
  const available = total > 0;
  const rate = safeRate(positive, total);
  const byJudge = Object.fromEntries(
    judgeIds.map((judgeId) => {
      const checks = input.filter((item) => item.judge_id === judgeId);
      const judgePositive = checks.filter(
        (item) => item[positiveField] === true,
      ).length;
      const judgeRate = safeRate(judgePositive, checks.length);
      return [
        judgeId,
        {
          positive: judgePositive,
          total: checks.length,
          rate: judgeRate,
          pass:
            checks.length > 0 &&
            (direction === "minimum"
              ? judgeRate >= threshold
              : judgeRate <= threshold),
        },
      ];
    }),
  );
  const everyJudgePass = Object.values(byJudge).every((item) => item.pass);
  return {
    positive,
    total,
    rate,
    threshold,
    direction,
    available,
    pass:
      available &&
      (direction === "minimum" ? rate >= threshold : rate <= threshold) &&
      everyJudgePass,
    by_judge: byJudge,
  };
}

function measureRegressionRatio(input, threshold, judgeIds = []) {
  const total = input.length;
  const positive = input.filter((item) => item.passed === false).length;
  const available = total > 0;
  const rate = safeRate(positive, total);
  const byJudge = Object.fromEntries(
    judgeIds.map((judgeId) => {
      const checks = input.filter((item) => item.judge_id === judgeId);
      const failures = checks.filter((item) => item.passed === false).length;
      const judgeRate = safeRate(failures, checks.length);
      return [
        judgeId,
        {
          positive: failures,
          total: checks.length,
          rate: judgeRate,
          pass: checks.length > 0 && judgeRate <= threshold,
        },
      ];
    }),
  );
  const everyJudgePass = Object.values(byJudge).every((item) => item.pass);
  return {
    positive,
    total,
    rate,
    threshold,
    direction: "maximum",
    available,
    pass: available && rate <= threshold && everyJudgePass,
    by_judge: byJudge,
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

function analyzeChallengeRound(run, invocationIdentityMetric, artifactBundle) {
  const critics = run?.actor_profiles?.critics ?? [];
  const auditJudges = run?.actor_profiles?.audit_judges ?? [];
  const allowedActors = new Map(
    [...critics, ...auditJudges].map((actor) => [actor.id, actor]),
  );
  const invocations = run?.challenge_invocations ?? [];
  const challenges = run?.challenges ?? [];
  const issues = [];
  const invocationIds = invocations.map((item) => item.invocation_id);
  const challengeIds = challenges.map((item) => item.challenge_id);
  const unknownActorIds = [];
  for (const id of findDuplicates(invocationIds)) {
    issues.push(`duplicate_invocation_id:${id}`);
  }
  for (const id of
    invocationIdentityMetric?.challenge?.duplicate_invocation_ids ?? []) {
    issues.push(`global_duplicate_invocation_id:${id}`);
  }
  for (const context of
    invocationIdentityMetric?.challenge?.duplicate_context_partitions ?? []) {
    issues.push(`global_duplicate_context_partition:${context}`);
  }
  for (const seed of
    invocationIdentityMetric?.challenge?.duplicate_invocation_seeds ?? []) {
    issues.push(`global_duplicate_invocation_seed:${seed}`);
  }
  for (const id of findDuplicates(challengeIds)) {
    issues.push(`duplicate_challenge_id:${id}`);
  }
  const invocationsByActor = groupBy(
    invocations.filter(
      (item) => item.invocation_kind === "challenge_raiser",
    ),
    (item) => item.actor_id,
  );
  for (const critic of critics) {
    const matches = invocationsByActor.get(critic.id) ?? [];
    if (matches.length !== 1) {
      issues.push(`critic_invocation_count:${critic.id}:${matches.length}`);
    }
  }
  const challengeById = new Map(
    challenges.map((challenge) => [challenge.challenge_id, challenge]),
  );
  const resolutionChecks = new Map(
    [
      ...(run?.evidence_checks ?? []).map((check) => [
        check.check_id,
        {
          judge_id: check.judge_id,
          finding_id: check.finding_id,
          pass: check.covered === true,
          executed_at: check.executed_at,
          collection: "evidence_checks",
          check,
        },
      ]),
      ...(run?.target_failure_checks ?? []).map((check) => [
        check.check_id,
        {
          judge_id: check.judge_id,
          finding_id: check.finding_id,
          pass:
            check.baseline_present === true &&
            check.candidate_present === false &&
            check.evidence_reduced === true,
          executed_at: check.executed_at,
          collection: "target_failure_checks",
          check,
        },
      ]),
      ...(run?.counterfactual_checks ?? []).map((check) => [
        check.check_id,
        {
          judge_id: check.judge_id,
          finding_id: check.finding_id,
          pass: check.passed === true,
          executed_at: check.executed_at,
          collection: "counterfactual_checks",
          check,
        },
      ]),
      ...(run?.regression_checks ?? []).map((check) => [
        check.check_id,
        {
          judge_id: check.judge_id,
          finding_id: null,
          pass: check.passed === true,
          executed_at: check.executed_at,
          collection: "regression_checks",
          check,
        },
      ]),
    ],
  );
  const auditJudgeIds = new Set(auditJudges.map((actor) => actor.id));
  const referencedChallengeIds = [];
  const resolvedChallengeIds = [];
  for (const invocation of invocations) {
    const actor = allowedActors.get(invocation.actor_id);
    if (!actor) {
      unknownActorIds.push(invocation.actor_id);
      issues.push(`unknown_invocation_actor:${invocation.invocation_id}`);
    } else if (
      invocation.context_partition !== actor.context_partition ||
      invocation.seed !== actor.seed
    ) {
      issues.push(`invocation_actor_binding_mismatch:${invocation.invocation_id}`);
    }
    if (
      (invocation.invocation_kind === "challenge_raiser" &&
        !critics.some((item) => item.id === invocation.actor_id)) ||
      (invocation.invocation_kind === "challenge_resolver" &&
        !auditJudges.some((item) => item.id === invocation.actor_id))
    ) {
      issues.push(`invocation_kind_actor_mismatch:${invocation.invocation_id}`);
    }
    if (
      invocation.invocation_kind === "challenge_raiser" &&
      invocation.challenge_request_digest !==
        computeChallengeRequestDigest(run, invocation, artifactBundle)
    ) {
      issues.push(`challenge_request_binding_invalid:${invocation.invocation_id}`);
    }
    if (
      invocation.invocation_kind === "challenge_resolver" &&
      invocation.resolution_request_digest !==
        computeChallengeResolutionRequestDigest(
          run,
          invocation,
          artifactBundle,
        )
    ) {
      issues.push(`resolution_request_binding_invalid:${invocation.invocation_id}`);
    }
    if (invocation.completed !== true) {
      issues.push(`invocation_incomplete:${invocation.invocation_id}`);
    }
    for (const challengeId of invocation.raised_challenge_ids ?? []) {
      referencedChallengeIds.push(challengeId);
      const challenge = challengeById.get(challengeId);
      if (!challenge) {
        issues.push(`invocation_challenge_missing:${invocation.invocation_id}:${challengeId}`);
      } else if (challenge.raised_by !== invocation.actor_id) {
        issues.push(`challenge_raiser_mismatch:${challengeId}`);
      }
    }
    for (const challengeId of invocation.resolved_challenge_ids ?? []) {
      resolvedChallengeIds.push(challengeId);
      const challenge = challengeById.get(challengeId);
      if (!challenge || challenge.resolved !== true) {
        issues.push(`invocation_resolution_missing:${invocation.invocation_id}:${challengeId}`);
      } else if (challenge.resolved_by !== invocation.actor_id) {
        issues.push(`challenge_resolver_mismatch:${challengeId}`);
      }
    }
  }
  for (const id of findDuplicates(referencedChallengeIds)) {
    issues.push(`challenge_referenced_multiple_times:${id}`);
  }
  for (const id of findDuplicates(resolvedChallengeIds)) {
    issues.push(`challenge_resolved_multiple_times:${id}`);
  }
  const referencedChallengeIdSet = new Set(referencedChallengeIds);
  const resolvedChallengeIdSet = new Set(resolvedChallengeIds);
  for (const challenge of challenges) {
    if (!critics.some((actor) => actor.id === challenge.raised_by)) {
      unknownActorIds.push(challenge.raised_by);
    }
    if (!referencedChallengeIdSet.has(challenge.challenge_id)) {
      issues.push(`challenge_without_invocation:${challenge.challenge_id}`);
    }
    if (challenge.resolved === true) {
      const resolutionCheckIds = challenge.resolution_check_ids ?? [];
      const raiserInvocation = invocations.find((invocation) =>
        (invocation.raised_challenge_ids ?? []).includes(challenge.challenge_id),
      );
      const resolverInvocation = invocations.find((invocation) =>
        (invocation.resolved_challenge_ids ?? []).includes(
          challenge.challenge_id,
        ),
      );
      const raisedAt = Date.parse(raiserInvocation?.executed_at ?? "");
      const resolvedAt = Date.parse(resolverInvocation?.executed_at ?? "");
      const resolutionCheckTimes = resolutionCheckIds.map((checkId) =>
        Date.parse(resolutionChecks.get(checkId)?.executed_at ?? ""),
      );
      const requiredResolutionCollection = {
        target_failure_persists: "target_failure_checks",
        evidence_not_reduced: "target_failure_checks",
        diagnostic_counterfactual_invalid: "counterfactual_checks",
      }[challenge.challenge_kind];
      const requiredResolutionCheckIds = [
        ...(challenge.required_resolution_check_ids ?? []),
      ].sort();
      const exactResolutionCheckSet =
        stableStringify([...resolutionCheckIds].sort()) ===
        stableStringify(requiredResolutionCheckIds);
      const kindSpecificResolutionPassed = (entry) => {
        if (!entry?.check) return false;
        if (challenge.challenge_kind === "target_failure_persists") {
          return (
            entry.check.baseline_present === true &&
            entry.check.candidate_present === false
          );
        }
        if (challenge.challenge_kind === "evidence_not_reduced") {
          return entry.check.evidence_reduced === true;
        }
        if (challenge.challenge_kind === "diagnostic_counterfactual_invalid") {
          return entry.check.passed === true;
        }
        return false;
      };
      const checkedFindingIds = new Set(
        resolutionCheckIds
          .map((checkId) => resolutionChecks.get(checkId)?.finding_id)
          .filter(Boolean),
      );
      if (
        !resolvedChallengeIdSet.has(challenge.challenge_id) ||
        !auditJudgeIds.has(challenge.resolved_by) ||
        challenge.resolved_by === challenge.raised_by ||
        resolutionCheckIds.length === 0 ||
        !exactResolutionCheckSet ||
        !Number.isFinite(raisedAt) ||
        !Number.isFinite(resolvedAt) ||
        resolvedAt <= raisedAt ||
        resolutionCheckTimes.some(
          (time) =>
            !Number.isFinite(time) || time <= raisedAt || resolvedAt < time,
        ) ||
        resolutionCheckIds.some((checkId) => {
          const check = resolutionChecks.get(checkId);
          return (
            !check ||
            !kindSpecificResolutionPassed(check) ||
            check.judge_id !== challenge.resolved_by ||
            check.collection !== requiredResolutionCollection
          );
        }) ||
        (challenge.target_finding_ids ?? []).some(
          (findingId) => !checkedFindingIds.has(findingId),
        )
      ) {
        issues.push(`challenge_resolution_unsubstantiated:${challenge.challenge_id}`);
      }
    } else if (resolvedChallengeIdSet.has(challenge.challenge_id)) {
      issues.push(`unresolved_challenge_claimed_resolved:${challenge.challenge_id}`);
    }
  }
  const completed =
    run?.challenge_round_completed === true &&
    invocations.length > 0 &&
    invocations.every((item) => item.completed === true);
  return {
    completed,
    pass: completed && issues.length === 0,
    invocations_observed: invocations.length,
    challenges_observed: challenges.length,
    unknown_actor_ids: [...new Set(unknownActorIds)].sort(),
    issues: [...new Set(issues)].sort(),
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
    if (left.weights_digest === right.weights_digest) return true;
  }
  return (
    normalizeIdentityText(left.provider) === normalizeIdentityText(right.provider) &&
    normalizeIdentityText(left.model) === normalizeIdentityText(right.model) &&
    normalizeIdentityText(left.model_version) ===
      normalizeIdentityText(right.model_version)
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
  return `model:${normalizeIdentityText(origin.provider)}/${normalizeIdentityText(origin.model)}/${normalizeIdentityText(origin.model_version)}`;
}

function normalizeIdentityText(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    : "";
}

function chooseStatus(reasonCodes) {
  if (reasonCodes.some((code) => INCONCLUSIVE_REASONS.has(code))) {
    return "inconclusive";
  }
  if (reasonCodes.some((code) => REJECTION_REASONS.has(code))) {
    return "rejected";
  }
  if (
    reasonCodes.length === 1 &&
    reasonCodes[0] === "INSUFFICIENT_REPEAT_RUNS"
  ) {
    return "candidate";
  }
  if (reasonCodes.length === 0) return "adopted";
  // A newly introduced but unclassified reason must never silently authorize
  // promotion. Classification omissions fail closed until explicitly handled.
  return "inconclusive";
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
