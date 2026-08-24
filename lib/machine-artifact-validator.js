import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { digestMatchesText, sha256Json } from "./content-integrity.js";
import { validateDiagnosticArtifact } from "./diagnostic-artifact-validator.js";
import {
  evaluatePromotion,
  getLocalSchemaDescriptor,
} from "./evolution-gate.js";
import { validateMachineBundleIntegrity } from "./machine-bundle-integrity.js";
import {
  describeStructureFailure,
  inspectUntrustedStructure,
} from "./untrusted-input.js";

const EXPECTED_RECORD_TYPES = [
  "diagnostic_trace",
  "repair_attempt",
  "verification_run",
  "evolution_policy"
];

function issue(rule, message) {
  return { rule, message };
}

function formatAjvError(error) {
  return `${error.instancePath || "/"} ${error.message}`;
}

function recordId(record) {
  if (record.record_type === "diagnostic_trace") return record.trace_id;
  if (record.record_type === "repair_attempt") return record.repair_id;
  if (record.record_type === "verification_run") return record.verification_id;
  if (record.record_type === "evolution_policy") return record.policy?.id;
  return null;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortObject(value[key])])
    );
  }
  return value;
}

export function validateMachineArtifacts({
  schemas,
  examples,
  taxonomyVersion,
  taxonomy = null,
  trustRoot = null,
  runReceipt = null,
  enforceConformanceExamples = false,
}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(schemas) || !Array.isArray(examples)) {
    errors.push(issue("R8", "schemas 与 examples 必须是数组"));
    return { errors, warnings, recordCount: 0 };
  }
  const untrustedInputs = [
    ...schemas.map((entry, index) => [
      `schemas[${index}]`,
      entry,
    ]),
    ...examples.map((entry, index) => [
      `examples[${index}]`,
      entry,
    ]),
    ["taxonomy", taxonomy],
    ["trust_root", trustRoot],
    ["run_receipt", runReceipt],
  ];
  for (const [label, value] of untrustedInputs) {
    if (value === null || value === undefined) continue;
    const structure = inspectUntrustedStructure(value);
    if (!structure.pass) {
      errors.push(
        issue("R8", describeStructureFailure(structure, label)),
      );
    }
  }
  if (errors.length > 0) {
    return { errors, warnings, recordCount: examples.length };
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);

  try {
    for (const { data } of schemas) ajv.addSchema(data);
  } catch (error) {
    errors.push(issue("R8", `机器记录 Schema 无法注册：${error.message}`));
    return { errors, warnings, recordCount: 0 };
  }

  const schemasByType = new Map();
  for (const { filename, data } of schemas) {
    const recordType = data?.properties?.record_type?.const;
    if (!recordType) continue;
    try {
      const validate = ajv.getSchema(data.$id);
      if (!validate) throw new Error(`无法按 $id 取得 ${data.$id}`);
      schemasByType.set(recordType, { filename, validate, id: data.$id });
    } catch (error) {
      errors.push(issue("R8", `${filename} 无法编译：${error.message}`));
    }
  }

  const recordsByType = new Map();
  for (const { filename, data } of examples) {
    const recordType = data?.record_type;
    const schemaEntry = schemasByType.get(recordType);
    if (!schemaEntry) {
      errors.push(issue("R8", `${filename} 的 record_type "${recordType}" 没有对应 Schema`));
      continue;
    }
    if (!schemaEntry.validate(data)) {
      for (const schemaError of schemaEntry.validate.errors ?? []) {
        errors.push(issue("R8", `${filename}: ${formatAjvError(schemaError)}`));
      }
    }
    if (recordsByType.has(recordType)) {
      errors.push(issue("R9", `machine-only 示例中 record_type "${recordType}" 重复`));
    } else {
      recordsByType.set(recordType, { filename, data });
    }
    if (data.mode !== "machine_only") {
      errors.push(issue("R9", `${filename} 必须以 machine_only 模式示范纯机器主路径`));
    }
    if (data?.provenance?.taxonomy?.version !== taxonomyVersion) {
      errors.push(issue("R9", `${filename} 的 taxonomy 版本 ${data?.provenance?.taxonomy?.version} 与 ${taxonomyVersion} 不一致`));
    }
  }

  for (const expectedType of EXPECTED_RECORD_TYPES) {
    if (!schemasByType.has(expectedType)) errors.push(issue("R8", `缺少 ${expectedType} Schema`));
    if (!recordsByType.has(expectedType)) errors.push(issue("R9", `缺少 ${expectedType} machine-only 示例`));
  }

  if (errors.some((error) => error.rule === "R8")) {
    return { errors, warnings, recordCount: examples.length };
  }

  checkCrossRecordLinks(
    recordsByType,
    errors,
    taxonomy,
    trustRoot,
    runReceipt,
    enforceConformanceExamples,
  );
  return { errors, warnings, recordCount: examples.length };
}

function checkCrossRecordLinks(
  recordsByType,
  errors,
  taxonomy,
  trustRoot,
  runReceipt,
  enforceConformanceExamples,
) {
  const policy = recordsByType.get("evolution_policy")?.data;
  const trace = recordsByType.get("diagnostic_trace")?.data;
  const repair = recordsByType.get("repair_attempt")?.data;
  const verification = recordsByType.get("verification_run")?.data;
  if (!policy || !trace || !repair || !verification) return;

  for (const message of validateDiagnosticArtifact(trace, taxonomy)) {
    errors.push(issue("R10", message));
  }
  for (const integrityIssue of validateMachineBundleIntegrity({
    policy,
    trace,
    repair,
    run: verification,
  })) {
    errors.push(issue("R10", integrityIssue.message));
  }
  if (enforceConformanceExamples) {
    const conformanceDigests = {
      diagnostic_trace: sha256Json(trace),
      repair_attempt: sha256Json(repair),
      verification_run: sha256Json(verification),
    };
    for (const [recordType, expectedDigest] of Object.entries(conformanceDigests)) {
      const reference = policy?.conformance_examples?.[recordType];
      if (reference?.digest !== expectedDigest) {
        errors.push(
          issue(
            "R10",
            `evolution_policy.conformance_examples.${recordType}.digest 与仓库固定样例内容不一致`,
          ),
        );
      }
    }
  }

  const expectedLinks = [
    [trace, "policy_ref", policy],
    [repair, "policy_ref", policy],
    [repair, "diagnostic_trace_ref", trace],
    [verification, "policy_ref", policy],
    [verification, "diagnostic_trace_ref", trace],
    [verification, "repair_attempt_ref", repair]
  ];
  for (const [source, field, target] of expectedLinks) {
    const observed = source?.[field]?.record_id;
    const expected = recordId(target);
    if (observed !== expected) {
      errors.push(issue("R10", `${source.record_type}.${field}.record_id 为 "${observed}"，应引用 "${expected}"`));
    }
  }

  for (const record of [policy, trace, repair, verification]) {
    const reference = record?.supersedes_ref;
    if (!reference) continue;
    const expectedSchema = getLocalSchemaDescriptor(record.record_type);
    if (
      !expectedSchema ||
      reference.schema_id !== expectedSchema.id ||
      reference.schema_version !== expectedSchema.version
    ) {
      errors.push(
        issue(
          "R10",
          `${record.record_type}.supersedes_ref 必须使用同类记录的本地权威 schema_id/schema_version`,
        ),
      );
    }
    if (reference.record_id === recordId(record)) {
      errors.push(
        issue(
          "R10",
          `${record.record_type}.supersedes_ref 不能指向当前记录自身`,
        ),
      );
    }
  }

  for (const candidateId of ["baseline", "candidate"]) {
    const repairDigest = repair?.candidates?.[candidateId]?.digest;
    const verificationDigest = verification?.candidates?.[candidateId]?.digest;
    if (repairDigest !== verificationDigest) {
      errors.push(issue("R10", `${candidateId} digest 在 repair_attempt 与 verification_run 之间不一致`));
    }
    const content = repair?.candidates?.[candidateId]?.content;
    if (
      repair?.provenance?.digest_status === "verified" &&
      !digestMatchesText(content, repairDigest)
    ) {
      errors.push(issue("R10", `${candidateId} digest 与 UTF-8 候选内容不一致`));
    }
  }
  if (repair?.candidates?.baseline?.content === repair?.candidates?.candidate?.content) {
    errors.push(issue("R10", "baseline 与 candidate 内容完全相同，不能依靠自报 digest 制造工件差异"));
  }

  const generatorOutputTurn = (trace?.subject?.turns ?? []).find(
    (turn) => turn.turn_id === trace?.subject?.generator_output_turn_id,
  );
  if (!generatorOutputTurn || generatorOutputTurn.speaker !== "assistant") {
    errors.push(issue("R10", "generator_output_turn_id 必须指向真实的 assistant turn"));
  } else if (repair?.candidates?.baseline?.content !== generatorOutputTurn.content) {
    errors.push(issue("R10", "repair baseline 内容必须与 diagnostic generator output 完全一致"));
  }
  const judgeIds = new Set((verification?.judges ?? []).map((judge) => judge.id));
  const trialJudgeIds = new Set((verification?.order_trials ?? []).map((trial) => trial.judge_id));
  for (const judgeId of trialJudgeIds) {
    if (!judgeIds.has(judgeId)) errors.push(issue("R10", `order_trials 引用了未声明的 judge "${judgeId}"`));
  }

  const repeatIds = new Set((verification?.order_trials ?? []).map((trial) => trial.repeat_id));
  if (typeof verification?.repeat_runs === "number" && repeatIds.size !== verification.repeat_runs) {
    errors.push(issue("R10", `repeat_runs 声明 ${verification.repeat_runs}，order_trials 实际含 ${repeatIds.size} 个 repeat_id`));
  }

  for (const repeatId of repeatIds) {
    for (const judgeId of judgeIds) {
      const trials = (verification.order_trials ?? []).filter(
        (trial) => trial.repeat_id === repeatId && trial.judge_id === judgeId
      );
      const ab = trials.filter((trial) => trial.order === "AB");
      const ba = trials.filter((trial) => trial.order === "BA");
      if (ab.length !== 1 || ba.length !== 1) {
        errors.push(issue("R10", `${repeatId}:${judgeId} 必须恰有一次 AB 与一次 BA 盲测`));
      } else if (ab[0].winner !== ba[0].winner) {
        errors.push(issue("R10", `${repeatId}:${judgeId} 在 AB/BA 换序后结论不一致`));
      }
    }
  }

  const computedDecision = evaluatePromotion(policy, verification, {
    diagnostic_trace: trace,
    repair_attempt: repair,
    taxonomy,
  }, trustRoot, runReceipt);
  const unsafeRecordReasons = new Set([
    "ARTIFACT_BUNDLE_REQUIRED",
    "ARTIFACT_BUNDLE_INVALID",
    "POLICY_DIGEST_MISMATCH",
    "POLICY_BELOW_SAFETY_FLOOR",
    "PROMOTION_ARTIFACT_UNBOUND",
    "PROMOTION_ARTIFACT_INVALID",
    "EVALUATION_MANIFEST_MISMATCH",
    "EXPERIMENT_LEDGER_INVALID",
    "POLICY_TRUST_ROOT_MISSING",
    "POLICY_TRUST_ROOT_MISMATCH",
    "RUN_RECEIPT_MISSING",
    "RUN_RECEIPT_INVALID",
    "IDENTITY_ISOLATION_INVALID",
    "DUPLICATE_SEMANTIC_CHECK",
    "CHECK_JUDGE_COVERAGE_INCOMPLETE",
    "REPEAT_INPUT_MISMATCH",
  ]);
  const unsafeReasons = computedDecision.reason_codes.filter((reason) =>
    unsafeRecordReasons.has(reason),
  );
  if (unsafeReasons.length > 0) {
    errors.push(
      issue(
        "R10",
        `机器证据包未满足确定性安全约束：${unsafeReasons.join(", ")}`,
      ),
    );
  }
  const persistedDecision = verification.promotion_gate;
  const persistedGateCore = persistedDecision
    ? {
        decision_version: persistedDecision.decision_version,
        run_id: persistedDecision.run_id,
        policy_id: persistedDecision.policy_id,
        status: persistedDecision.status,
        reason_codes: persistedDecision.reason_codes,
        metrics: persistedDecision.metrics
      }
    : null;
  if (
    persistedDecision &&
    JSON.stringify(sortObject(computedDecision)) !==
      JSON.stringify(sortObject(persistedGateCore))
  ) {
    errors.push(issue("R10", "verification_run.promotion_gate 与当前确定性 gate 的重新计算结果不一致"));
  }
  const lifecycleByStatus = {
    adopted: "promoted",
    candidate: "probation",
    rejected: "rejected",
    inconclusive: "quarantined"
  };
  if (
    persistedDecision &&
    persistedDecision.lifecycle_state !== lifecycleByStatus[persistedDecision.status]
  ) {
    errors.push(issue("R10", `gate 状态 ${persistedDecision?.status} 与 lifecycle_state ${persistedDecision?.lifecycle_state} 不匹配`));
  }
  const expectedLifecycleReason = persistedDecision?.reason_codes?.join("|");
  if (
    persistedDecision &&
    persistedDecision.lifecycle_reason !== expectedLifecycleReason
  ) {
    errors.push(
      issue(
        "R10",
        "verification_run.promotion_gate.lifecycle_reason 必须由 reason_codes 按原顺序以 | 连接确定性派生",
      ),
    );
  }
}
