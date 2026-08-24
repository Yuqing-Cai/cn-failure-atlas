import {
  generateKeyPairSync,
  sign as signPayload,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import {
  computeBlindingProtocolDigest,
  computeEvaluationInvocationPlanDigest,
  computeExperimentPlanDigest,
  computeGenerationInputDigest,
  computeJudgeActorSetDigest,
  computeRepairInputDigest,
  computeRepeatInputDigest,
  computeRepeatPlanDigest,
  computeVerificationRunAttestationDigest,
  diagnosticPrecommitPayload,
  evaluatePromotion,
  generationPrecommitPayload,
  promotionRunCompletionPayload,
  promotionRunReceiptPayload,
  verificationPrecommitPayload,
} from "../lib/evolution-gate.js";
import {
  canonicalJson,
  parseJsonWithUniqueKeys,
  sha256Json,
  sha256Text,
} from "../lib/content-integrity.js";

const paths = {
  policy: new URL(
    "../examples/machine-only/evolution-policy.example.json",
    import.meta.url,
  ),
  trace: new URL(
    "../examples/machine-only/diagnostic-trace.example.json",
    import.meta.url,
  ),
  repair: new URL(
    "../examples/machine-only/repair-attempt.example.json",
    import.meta.url,
  ),
  run: new URL(
    "../examples/machine-only/verification-run.example.json",
    import.meta.url,
  ),
  taxonomy: new URL("../taxonomy.json", import.meta.url),
  trustRoot: new URL(
    "../config/promotion-trust-root.example.json",
    import.meta.url,
  ),
  receipt: new URL(
    "../config/promotion-run-receipt.example.json",
    import.meta.url,
  ),
  readme: new URL("../README.md", import.meta.url),
};

const readJson = (url) =>
  parseJsonWithUniqueKeys(readFileSync(url, "utf8"));
const writeJson = (url, value) =>
  writeFileSync(url, `${JSON.stringify(value, null, 2)}\n`, "utf8");

const policy = readJson(paths.policy);
const trace = readJson(paths.trace);
const repair = readJson(paths.repair);
const run = readJson(paths.run);
const taxonomy = readJson(paths.taxonomy);
const trustRoot = readJson(paths.trustRoot);
delete run.promotion_gate;

const issuerId = "orchestrator.repository-fixture.v3";
const keyId = "key.repository-fixture.ed25519.v3";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
trustRoot.policy_digest = policy.policy_digest;
trustRoot.taxonomy_digest = sha256Json(taxonomy);
trustRoot.receipt_public_keys = [
  {
    key_id: keyId,
    issuer_id: issuerId,
    algorithm: "Ed25519",
    public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
  },
];
const trustRootDigest = sha256Json(trustRoot);

const signatureFor = (payload) => ({
  key_id: keyId,
  algorithm: "Ed25519",
  value: signPayload(
    null,
    Buffer.from(canonicalJson(payload), "utf8"),
    privateKey,
  ).toString("base64"),
});

const outputTurnId = trace.subject.generator_output_turn_id;
const outputTurn = trace.subject.turns.find(
  (turn) => turn.turn_id === outputTurnId,
);
const outputScene = trace.subject.scenes.find(
  (scene) => scene.scene_id === outputTurn?.scene_id,
);
if (!outputTurn || !outputScene) {
  throw new Error("Example trace has no primary output turn or scene");
}

const experimentPlanDigest = computeExperimentPlanDigest(
  trace.experiment_ledger,
);
const traceIsolationDigest = sha256Json(trace.identity_isolation);
const generationPrecommit = {
  generation_request_id: "generation-request.repository-fixture.v3",
  single_use_nonce: "b".repeat(64),
  subject_record_id: trace.subject.record_id,
  output_turn_id: outputTurnId,
  scene_id: outputScene.scene_id,
  input_digest: computeGenerationInputDigest(trace, outputTurnId),
  scene_contract_digest: outputScene.contract_digest,
  generator_actor_digest: sha256Json(trace.actors.generator),
  contract_critic_actor_digest: sha256Json(trace.actors.contract_critic),
  policy_digest: policy.policy_digest,
  taxonomy_digest: sha256Json(taxonomy),
  trust_root_id: trustRoot.trust_root_id,
  trust_root_digest: trustRootDigest,
  experiment_plan_digest: experimentPlanDigest,
  trace_identity_isolation_digest: traceIsolationDigest,
  issued_at: "2026-08-24T09:59:50Z",
  issuer_id: issuerId,
};
generationPrecommit.signature = signatureFor(
  generationPrecommitPayload(generationPrecommit),
);

const diagnosticPrecommit = {
  diagnostic_request_id: "diagnostic-request.repository-fixture.v3",
  single_use_nonce: "a".repeat(64),
  generation_request_id: generationPrecommit.generation_request_id,
  output_turn_id: outputTurnId,
  output_digest: sha256Text(outputTurn.content),
  critic_actor_digest: sha256Json(trace.actors.critic),
  test_judge_actor_digest: sha256Json(trace.actors.test_judge),
  taxonomy_digest: sha256Json(taxonomy),
  experiment_plan_digest: experimentPlanDigest,
  trace_identity_isolation_digest: traceIsolationDigest,
  issued_at: "2026-08-24T09:59:59Z",
  issuer_id: issuerId,
};
diagnosticPrecommit.signature = signatureFor(
  diagnosticPrecommitPayload(diagnosticPrecommit),
);

const artifactBundle = {
  diagnostic_trace: trace,
  repair_attempt: repair,
  taxonomy,
};
const receipt = {
  record_type: "promotion_run_receipt",
  schema_version: "1.1.0",
  generation_precommits: [generationPrecommit],
  diagnostic_precommits: [diagnosticPrecommit],
  receipt_id: "receipt.repository-fixture.v3",
  run_request_id: "request.repository-fixture.v3",
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
  repair_generator_actor_digest: sha256Json(repair.actors.repair_generator),
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
  issuer_id: issuerId,
};
receipt.signature = signatureFor(promotionRunReceiptPayload(receipt));

receipt.verification_precommit = {
  verification_request_id: "verification-request.repository-fixture.v3",
  single_use_nonce: "e".repeat(64),
  repair_attempt_digest: sha256Json(repair),
  baseline_digest: repair.candidates.baseline.digest,
  candidate_digest: repair.candidates.candidate.digest,
  manifest_digest: run.evaluation_manifest.manifest_digest,
  repeat_input_digest: computeRepeatInputDigest(policy, run, artifactBundle),
  repeat_plan_digest: computeRepeatPlanDigest(run),
  judge_actor_set_digest: computeJudgeActorSetDigest(run),
  blinding_mapping_digest: run.blinding.mapping_digest,
  issued_at: "2026-08-24T10:04:30Z",
  issuer_id: issuerId,
};
receipt.verification_precommit.signature = signatureFor(
  verificationPrecommitPayload(receipt),
);

receipt.completion = {
  completed_at: "2026-08-24T10:08:00Z",
  diagnostic_trace_digest: sha256Json(trace),
  repair_attempt_digest: sha256Json(repair),
  verification_run_digest: computeVerificationRunAttestationDigest(run),
  candidate_digest: repair.candidates.candidate.digest,
};
receipt.completion.signature = signatureFor(
  promotionRunCompletionPayload(receipt),
);

const decision = evaluatePromotion(
  policy,
  run,
  artifactBundle,
  trustRoot,
  receipt,
);
if (
  decision.status !== "inconclusive" ||
  decision.metrics.run_receipt.pass !== true ||
  canonicalJson(decision.reason_codes) !==
    canonicalJson(["UNVERIFIED_PROVENANCE"])
) {
  throw new Error(
    `Example attestation did not reach the expected provenance-only quarantine: ${JSON.stringify(decision.reason_codes)}`,
  );
}
run.promotion_gate = {
  ...decision,
  lifecycle_state: "quarantined",
  lifecycle_reason: decision.reason_codes.join("|"),
};
policy.conformance_examples.verification_run.digest = sha256Json(run);

writeJson(paths.trustRoot, trustRoot);
writeJson(paths.receipt, receipt);
writeJson(paths.run, run);
writeJson(paths.policy, policy);

const readme = readFileSync(paths.readme, "utf8");
const updatedReadme = readme.replace(
  /(CN_FAILURE_ATLAS_TRUST_ROOT_SHA256(?:\s*=\s*"|=))([a-f0-9]{64})/g,
  `$1${trustRootDigest}`,
);
if (updatedReadme === readme) {
  throw new Error("README trust-root pins were not found");
}
writeFileSync(paths.readme, updatedReadme, "utf8");

console.log(
  JSON.stringify(
    {
      receipt_id: receipt.receipt_id,
      trust_root_digest: trustRootDigest,
      status: decision.status,
      reason_codes: decision.reason_codes,
    },
    null,
    2,
  ),
);
console.log(
  "Issued a demonstration-only key and attestation. Never reuse this fixture key or fixed nonces in production.",
);
