import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { evaluatePromotion } from "./evolution-gate.js";

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

function sameOrigin(left, right) {
  return JSON.stringify(sortObject(left)) === JSON.stringify(sortObject(right));
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

export function validateMachineArtifacts({ schemas, examples, taxonomyVersion, taxonomy = null }) {
  const errors = [];
  const warnings = [];
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

  checkCrossRecordLinks(recordsByType, errors, taxonomy);
  return { errors, warnings, recordCount: examples.length };
}

function checkCrossRecordLinks(recordsByType, errors, taxonomy) {
  const policy = recordsByType.get("evolution_policy")?.data;
  const trace = recordsByType.get("diagnostic_trace")?.data;
  const repair = recordsByType.get("repair_attempt")?.data;
  const verification = recordsByType.get("verification_run")?.data;
  if (!policy || !trace || !repair || !verification) return;

  checkDiagnosticEvidence(trace, taxonomy, errors);

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

  for (const candidateId of ["baseline", "candidate"]) {
    const repairDigest = repair?.candidates?.[candidateId]?.digest;
    const verificationDigest = verification?.candidates?.[candidateId]?.digest;
    if (repairDigest !== verificationDigest) {
      errors.push(issue("R10", `${candidateId} digest 在 repair_attempt 与 verification_run 之间不一致`));
    }
  }

  const findingIds = new Set((trace.findings ?? []).map((finding) => finding.finding_id));
  for (const findingId of repair.target_finding_ids ?? []) {
    if (!findingIds.has(findingId)) errors.push(issue("R10", `repair_attempt 引用了不存在的 finding "${findingId}"`));
  }
  for (const check of verification.target_failure_checks ?? []) {
    if (!findingIds.has(check.finding_id)) errors.push(issue("R10", `target_failure_checks 引用了不存在的 finding "${check.finding_id}"`));
  }
  if (repair?.verification_handoff?.candidate_mapping_digest !== verification?.blinding?.mapping_digest) {
    errors.push(issue("R10", "repair_attempt handoff 与 verification_run 的盲化映射 digest 不一致"));
  }

  const repairer = repair?.actors?.repair_generator;
  if (verification?.generator?.id !== repairer?.id || !sameOrigin(verification?.generator?.origin, repairer?.origin)) {
    errors.push(issue("R10", "verification_run.generator 与 repair_attempt 的候选生成器不一致"));
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

  const computedDecision = evaluatePromotion(policy, verification);
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
  if (JSON.stringify(sortObject(computedDecision)) !== JSON.stringify(sortObject(persistedGateCore))) {
    errors.push(issue("R10", "verification_run.promotion_gate 与当前确定性 gate 的重新计算结果不一致"));
  }
  const lifecycleByStatus = {
    adopted: "promoted",
    candidate: "probation",
    rejected: "rejected",
    inconclusive: "quarantined"
  };
  if (persistedDecision?.lifecycle_state !== lifecycleByStatus[persistedDecision?.status]) {
    errors.push(issue("R10", `gate 状态 ${persistedDecision?.status} 与 lifecycle_state ${persistedDecision?.lifecycle_state} 不匹配`));
  }
}

function checkDiagnosticEvidence(trace, taxonomy, errors) {
  const turns = new Map((trace?.subject?.turns ?? []).map((turn) => [turn.turn_id, turn]));
  const evidenceIds = new Set();
  const findingIds = new Set((trace.findings ?? []).map((finding) => finding.finding_id));
  const ontologyKinds = new Map();
  if (taxonomy) {
    for (const layer of taxonomy.layers ?? []) {
      for (const subcategory of layer.subcategories ?? []) {
        for (const label of subcategory.labels ?? []) ontologyKinds.set(label.id, "symptom");
      }
    }
    for (const item of taxonomy.causal_hypotheses ?? []) ontologyKinds.set(item.id, "causal_hypothesis");
    for (const item of taxonomy.composite_tags ?? []) ontologyKinds.set(item.id, "composite");
    for (const item of taxonomy.uncertainty_markers ?? []) ontologyKinds.set(item.id, "uncertainty");
  }

  for (const finding of trace.findings ?? []) {
    if (taxonomy) {
      const expectedKind = ontologyKinds.get(finding.label_id);
      if (!expectedKind) errors.push(issue("R10", `diagnostic_trace 使用了 taxonomy 中不存在的 label_id "${finding.label_id}"`));
      else if (finding.label_kind !== expectedKind) errors.push(issue("R10", `"${finding.label_id}" 的 label_kind 应为 ${expectedKind}，实际为 ${finding.label_kind}`));
    }
    for (const supportingId of finding.supporting_finding_ids ?? []) {
      if (!findingIds.has(supportingId)) errors.push(issue("R10", `因果假设 supporting_finding_ids 引用了不存在的 finding "${supportingId}"`));
    }
    for (const evidence of finding.evidence ?? []) {
      if (evidenceIds.has(evidence.evidence_id)) errors.push(issue("R10", `diagnostic_trace 重复 evidence_id "${evidence.evidence_id}"`));
      evidenceIds.add(evidence.evidence_id);
      const turn = turns.get(evidence.turn_id);
      if (!turn) {
        errors.push(issue("R10", `证据 "${evidence.evidence_id}" 引用了不存在的 turn "${evidence.turn_id}"`));
        continue;
      }
      if (evidence.source_record_id !== trace.subject.record_id) {
        errors.push(issue("R10", `证据 "${evidence.evidence_id}" 的 source_record_id 与 subject.record_id 不一致`));
      }
      if (evidence.span?.unit === "unicode_codepoint") {
        const codepoints = [...turn.content];
        const { start, end } = evidence.span;
        const observed = codepoints.slice(start, end).join("");
        if (start >= end || end > codepoints.length || observed !== evidence.quote) {
          errors.push(issue("R10", `证据 "${evidence.evidence_id}" 的 span 与 quote/turn 内容不一致`));
        }
      }
    }
    for (const rebuttal of finding.neighboring_label_rebuttals ?? []) {
      if (taxonomy && !ontologyKinds.has(rebuttal.label_id)) {
        errors.push(issue("R10", `neighboring_label_rebuttals 使用了未知 label_id "${rebuttal.label_id}"`));
      }
    }
  }

  for (const finding of trace.findings ?? []) {
    if (finding.label_kind === "causal_hypothesis") {
      const supporting = (finding.supporting_finding_ids ?? [])
        .map((id) => (trace.findings ?? []).find((candidate) => candidate.finding_id === id))
        .filter(Boolean);
      if (supporting.length < 2 || supporting.some((item) => item.label_kind !== "symptom" || item.status !== "present")) {
        errors.push(issue("R10", `因果假设 finding "${finding.finding_id}" 必须由至少两个 present symptom finding 支撑`));
      }
    }
    for (const rebuttal of finding.neighboring_label_rebuttals ?? []) {
      for (const evidenceId of rebuttal.evidence_ids ?? []) {
        if (!evidenceIds.has(evidenceId)) errors.push(issue("R10", `rebuttal 引用了不存在的 evidence_id "${evidenceId}"`));
      }
    }
  }
}
