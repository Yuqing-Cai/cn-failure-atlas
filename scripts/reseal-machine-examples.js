import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Json, sha256Text } from "../lib/content-integrity.js";
import {
  computeTaxonomyTestExecutionDigest,
  computeTaxonomyTestInputDigest,
} from "../lib/diagnostic-artifact-validator.js";
import {
  collectPromptBundleDescriptors,
  computeAuditCheckSeed,
  computeAuditRequestDigest,
  computeBlindingMappingDigest,
  computeBlindingProtocolDigest,
  computeChallengeRequestDigest,
  computeChallengeResolutionRequestDigest,
  computeEvaluationCaseCommitments,
  computeGenerationInputDigest,
  computeOrderTrialSeed,
  computePreferenceRequestDigest,
  computeRepeatInputDigest,
  computeRepeatRunDigest,
  getLocalSchemaDescriptor,
} from "../lib/evolution-gate.js";
import { REPOSITORY_ROOT } from "../validate.js";

const examplesDirectory = join(REPOSITORY_ROOT, "examples", "machine-only");
const paths = {
  policy: join(examplesDirectory, "evolution-policy.example.json"),
  trace: join(examplesDirectory, "diagnostic-trace.example.json"),
  repair: join(examplesDirectory, "repair-attempt.example.json"),
  run: join(examplesDirectory, "verification-run.example.json"),
  taxonomy: join(REPOSITORY_ROOT, "taxonomy.json"),
  trustRoot: join(REPOSITORY_ROOT, "config", "promotion-trust-root.example.json"),
};

const policy = readJson(paths.policy);
const trace = readJson(paths.trace);
const repair = readJson(paths.repair);
const run = readJson(paths.run);
const taxonomy = readJson(paths.taxonomy);
const trustRoot = readJson(paths.trustRoot);
const records = [policy, trace, repair, run];
const taxonomyDigest = sha256Json(taxonomy);

const primaryOutputTurn = trace.subject.turns.find(
  (turn) => turn.turn_id === trace.subject.generator_output_turn_id,
);
const primaryScene = trace.subject.scenes.find(
  (scene) => scene.scene_id === primaryOutputTurn?.scene_id,
);
if (!primaryScene) throw new Error("Primary diagnostic scene is missing");
primaryScene.contract = structuredClone(trace.scene_contract);
primaryScene.contract_digest = sha256Json(trace.scene_contract);
trace.subject.input_digest = computeGenerationInputDigest(
  trace,
  trace.subject.generator_output_turn_id,
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
    if (!targetTurn || !scene) {
      throw new Error(`Taxonomy test ${execution.execution_id} has no target scene`);
    }
    const taxonomyLabel = taxonomy.layers
      .flatMap((layer) => layer.subcategories)
      .flatMap((subcategory) => subcategory.labels)
      .find((label) => label.id === finding.label_id);
    const recipe = taxonomyLabel?.test_recipes?.find(
      (item) => item.recipe_id === result.recipe_id,
    );
    scene.contract_digest = sha256Json(scene.contract);
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

for (const record of records) {
  Object.assign(record.provenance.taxonomy, {
    name: taxonomy.name,
    version: taxonomy.taxonomy_version,
    digest: taxonomyDigest,
  });
  record.provenance.schema = getLocalSchemaDescriptor(record.record_type);
}

policy.policy_digest = sha256Json({
  schema_version: policy.schema_version,
  mode: policy.mode,
  provenance: policy.provenance,
  ...(policy.supersedes_ref ? { supersedes_ref: policy.supersedes_ref } : {}),
  policy: policy.policy,
  actor_isolation: policy.actor_isolation,
  verification_protocol: policy.verification_protocol,
  promotion_lifecycle: policy.promotion_lifecycle,
  rollback_policy: policy.rollback_policy,
});
for (const record of [trace, repair, run]) {
  record.policy_ref.digest = policy.policy_digest;
}

const traceActors = Object.values(trace.actors);
trace.identity_isolation.pairs = traceActors
  .flatMap((leftActor, leftIndex) =>
    traceActors.slice(leftIndex + 1).map((rightActor) => {
      const mechanisms = [
        "separate_context",
        "separate_prompt",
        "no_shared_scratchpad",
      ];
      if (leftActor.origin.provider !== rightActor.origin.provider) {
        mechanisms.push("separate_provider");
      }
      return {
        left_actor_id: leftActor.id,
        right_actor_id: rightActor.id,
        mechanisms,
        independent_context: true,
        verified: true,
      };
    }),
  )
  .sort((left, right) =>
    `${left.left_actor_id}<->${left.right_actor_id}`.localeCompare(
      `${right.left_actor_id}<->${right.right_actor_id}`,
    ),
  );

const repairActors = Object.values(repair.actors);
repair.identity_isolation.pairs = repairActors
  .flatMap((leftActor, leftIndex) =>
    repairActors.slice(leftIndex + 1).map((rightActor) => {
      const mechanisms = [
        "separate_context",
        "separate_prompt",
        "no_shared_scratchpad",
      ];
      if (leftActor.origin.provider !== rightActor.origin.provider) {
        mechanisms.push("separate_provider");
      }
      return {
        left_actor_id: leftActor.id,
        right_actor_id: rightActor.id,
        mechanisms,
        independent_context: true,
        verified: true,
      };
    }),
  )
  .sort((left, right) =>
    `${left.left_actor_id}<->${left.right_actor_id}`.localeCompare(
      `${right.left_actor_id}<->${right.right_actor_id}`,
    ),
  );

for (const candidateId of ["baseline", "candidate"]) {
  const candidate = repair.candidates[candidateId];
  candidate.digest = sha256Text(candidate.content);
  run.candidates[candidateId].digest = candidate.digest;
}
run.blinding.mapping_digest = computeBlindingMappingDigest(run);
repair.verification_handoff.blinding_protocol_digest =
  computeBlindingProtocolDigest(run);

const preferenceJudges = run.actor_profiles.judges;
const auditJudges = run.actor_profiles.audit_judges;
const verificationCritics = run.actor_profiles.critics;
const allVerificationJudges = [...preferenceJudges, ...auditJudges];
const requiredIsolationPairs = [
  ...allVerificationJudges.map((judge) => [
    run.actor_profiles.generator.id,
    judge.id,
  ]),
  ...allVerificationJudges.map((judge) => [
    judge.id,
    run.actor_profiles.aggregator.id,
  ]),
  ...verificationCritics.flatMap((critic) =>
    allVerificationJudges.map((judge) => [critic.id, judge.id]),
  ),
  ...verificationCritics.map((critic) => [
    run.actor_profiles.generator.id,
    critic.id,
  ]),
  ...preferenceJudges.flatMap((preferenceJudge) =>
    auditJudges.map((auditJudge) => [preferenceJudge.id, auditJudge.id]),
  ),
];
const verificationActors = new Map(
  [
    run.actor_profiles.generator,
    ...preferenceJudges,
    ...auditJudges,
    ...verificationCritics,
    run.actor_profiles.aggregator,
  ].map((actor) => [actor.id, actor]),
);
run.identity_isolation.pairs = requiredIsolationPairs
  .map(([leftActorId, rightActorId]) => {
    const leftActor = verificationActors.get(leftActorId);
    const rightActor = verificationActors.get(rightActorId);
    const mechanisms = [
      "separate_context",
      "separate_prompt",
      "no_shared_scratchpad",
    ];
    if (leftActor.origin.provider !== rightActor.origin.provider) {
      mechanisms.push("separate_provider");
    }
    return {
      left_actor_id: leftActorId,
      right_actor_id: rightActorId,
      mechanisms,
      independent_context: true,
      verified: true,
    };
  })
  .sort((left, right) =>
    `${left.left_actor_id}<->${left.right_actor_id}`.localeCompare(
      `${right.left_actor_id}<->${right.right_actor_id}`,
    ),
  );
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

const repeatSeedById = new Map(
  run.repeat_manifest.map((entry) => [entry.repeat_id, entry.seed]),
);
const repeatExecutionById = new Map(
  run.repeat_manifest.map((entry) => [entry.repeat_id, entry.executed_at]),
);
for (const trial of run.order_trials) {
  trial.invocation_id = `invocation.${trial.trial_id}`;
  trial.context_partition =
    `preference/${trial.repeat_id}/${trial.judge_id}/${trial.order.toLowerCase()}`;
  trial.seed = computeOrderTrialSeed(
    repeatSeedById.get(trial.repeat_id),
    trial.judge_id,
    trial.order,
  );
  trial.executed_at = repeatExecutionById.get(trial.repeat_id);
  trial.preference_request_digest = computePreferenceRequestDigest(
    run,
    trial,
    { diagnostic_trace: trace, repair_attempt: repair },
  );
}

let auditExecutionOffset = 10;
for (const collectionName of [
  "evidence_checks",
  "target_failure_checks",
  "counterfactual_checks",
  "regression_checks",
]) {
  for (const check of run[collectionName]) {
    const judge = auditJudges.find((item) => item.id === check.judge_id);
    if (!judge) throw new Error(`Unknown audit judge ${check.judge_id}`);
    check.invocation_id = `invocation.audit.${collectionName}.${check.check_id}`;
    check.context_partition =
      `audit/${collectionName}/${check.check_id}/${check.judge_id}`;
    check.seed = computeAuditCheckSeed(
      judge.seed,
      collectionName,
      check.check_id,
    );
    check.executed_at =
      `2026-08-24T10:05:${String(auditExecutionOffset).padStart(2, "0")}Z`;
    auditExecutionOffset += 1;
    check.audit_request_digest = computeAuditRequestDigest(
      run,
      collectionName,
      check,
      { diagnostic_trace: trace, repair_attempt: repair },
    );
  }
}
let challengeRaiserOffset = 5;
let challengeResolverOffset = 40;
for (const invocation of run.challenge_invocations) {
  if (invocation.invocation_kind === "challenge_raiser") {
    invocation.executed_at =
      `2026-08-24T10:05:${String(challengeRaiserOffset).padStart(2, "0")}Z`;
    challengeRaiserOffset += 1;
    invocation.challenge_request_digest = computeChallengeRequestDigest(
      run,
      invocation,
      { diagnostic_trace: trace, repair_attempt: repair },
    );
    delete invocation.resolution_request_digest;
  } else if (invocation.invocation_kind === "challenge_resolver") {
    invocation.executed_at =
      `2026-08-24T10:05:${String(challengeResolverOffset).padStart(2, "0")}Z`;
    challengeResolverOffset += 1;
    invocation.resolution_request_digest =
      computeChallengeResolutionRequestDigest(
        run,
        invocation,
        { diagnostic_trace: trace, repair_attempt: repair },
      );
    delete invocation.challenge_request_digest;
  }
}

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
run.promotion_artifact.source_ref = {
  ...run.repair_attempt_ref,
  digest: repairDigest,
};
policy.conformance_examples.repair_attempt.digest = repairDigest;

const repeatInputDigest = computeRepeatInputDigest(policy, run, {
  diagnostic_trace: trace,
  repair_attempt: repair,
  taxonomy,
});
for (const repeat of run.repeat_manifest) {
  repeat.input_digest = repeatInputDigest;
  repeat.run_digest = computeRepeatRunDigest(run, repeat);
}
policy.conformance_examples.verification_run.digest = sha256Json(run);

Object.assign(trustRoot, {
  policy_id: policy.policy.id,
  policy_version: policy.policy.version,
  policy_digest: policy.policy_digest,
  taxonomy_name: taxonomy.name,
  taxonomy_version: taxonomy.taxonomy_version,
  taxonomy_digest: taxonomyDigest,
  trusted_runners: [
    ...new Map(
      records.map((record) => [
        JSON.stringify(record.provenance.runner),
        structuredClone(record.provenance.runner),
      ]),
    ).values(),
  ],
  trusted_prompt_bundles: collectPromptBundleDescriptors(records),
});

writeJson(paths.policy, policy);
writeJson(paths.trace, trace);
writeJson(paths.repair, repair);
writeJson(paths.run, run);
writeJson(paths.trustRoot, trustRoot);

console.log(
  JSON.stringify(
    {
      policy_digest: policy.policy_digest,
      taxonomy_digest: taxonomyDigest,
      manifest_digest: run.evaluation_manifest.manifest_digest,
      trust_root_digest: sha256Json(trustRoot),
    },
    null,
    2,
  ),
);

console.warn(
  "Machine examples were resealed. If any sealed content changed, reissue and sign the promotion run receipt; resealing never forges an attestation.",
);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
