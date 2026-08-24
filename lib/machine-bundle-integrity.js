import { sha256Json } from "./content-integrity.js";

export function validateMachineBundleIntegrity({ policy, trace, repair, run }) {
  const issues = [];
  checkRecordIsolation(
    trace,
    Object.values(trace?.actors ?? {}),
    [
      [trace?.actors?.generator?.id, trace?.actors?.contract_critic?.id],
      [trace?.actors?.generator?.id, trace?.actors?.critic?.id],
      [trace?.actors?.generator?.id, trace?.actors?.test_judge?.id],
      [trace?.actors?.critic?.id, trace?.actors?.test_judge?.id],
      [trace?.actors?.contract_critic?.id, trace?.actors?.critic?.id],
      [trace?.actors?.contract_critic?.id, trace?.actors?.test_judge?.id],
    ],
    policy,
    issues,
  );
  checkRecordIsolation(
    repair,
    Object.values(repair?.actors ?? {}),
    [
      [
        repair?.actors?.baseline_generator?.id,
        repair?.actors?.repair_generator?.id,
      ],
      [repair?.actors?.baseline_generator?.id, repair?.actors?.critic?.id],
      [repair?.actors?.repair_generator?.id, repair?.actors?.critic?.id],
    ],
    policy,
    issues,
  );

  if (
    repair?.actors?.baseline_generator?.id !== trace?.actors?.generator?.id ||
    !sameOrigin(
      repair?.actors?.baseline_generator?.origin,
      trace?.actors?.generator?.origin,
    )
  ) {
    issues.push({
      code: "baseline_generator_identity_mismatch",
      key: "repair.baseline_generator",
      message:
        "repair_attempt.baseline_generator 必须与 diagnostic_trace.generator 完全一致",
    });
  }

  const repairer = repair?.actors?.repair_generator;
  for (const [role, upstreamActor] of Object.entries(trace?.actors ?? {})) {
    if (!upstreamActor || !repairer) continue;
    const key = `repair_generator:diagnostic_trace.${role}`;
    if (repairer.id === upstreamActor.id) {
      issues.push({
        code: "repair_generator_upstream_actor_reuse",
        key,
        message: `repair generator 不得复用 diagnostic_trace.${role} actor id`,
      });
    }
    if (
      normalizeIdentityText(repairer.context_partition) ===
      normalizeIdentityText(upstreamActor.context_partition)
    ) {
      issues.push({
        code: "repair_generator_upstream_context_reuse",
        key,
        message: `repair generator 不得复用 diagnostic_trace.${role} context_partition`,
      });
    }
    if (
      normalizeIdentityText(repairer.prompt?.digest) ===
      normalizeIdentityText(upstreamActor.prompt?.digest)
    ) {
      issues.push({
        code: "repair_generator_upstream_prompt_reuse",
        key,
        message: `repair generator 不得复用 diagnostic_trace.${role} prompt`,
      });
    }
  }
  if (
    run?.generator?.id !== repairer?.id ||
    !sameOrigin(run?.generator?.origin, repairer?.origin)
  ) {
    issues.push({
      code: "repair_generator_identity_mismatch",
      key: "run.generator",
      message:
      "verification_run.generator 与 repair_attempt 的候选生成器不一致",
    });
  }

  const upstreamActors = [
    ...Object.entries(trace?.actors ?? {}).map(([role, actor]) => ({
      record: "diagnostic_trace",
      role,
      actor,
    })),
    ...Object.entries(repair?.actors ?? {}).map(([role, actor]) => ({
      record: "repair_attempt",
      role,
      actor,
    })),
  ];
  const verificationJudges = [
    ...(run?.actor_profiles?.judges ?? []).map((judge) => ({
      channel: "preference",
      judge,
    })),
    ...(run?.actor_profiles?.audit_judges ?? []).map((judge) => ({
      channel: "audit",
      judge,
    })),
  ];
  for (const { channel, judge } of verificationJudges) {
    for (const upstream of upstreamActors) {
      const upstreamActor = upstream.actor;
      if (!upstreamActor) continue;
      const key = `${judge?.id ?? "missing"}:${upstream.record}.${upstream.role}`;
      if (
        nonEmptyString(judge?.id) &&
        judge.id === upstreamActor.id
      ) {
        issues.push({
          code: `${channel}_judge_upstream_actor_reuse`,
          key,
          message: `${channel} judge "${judge.id}" 不得复用上游 ${upstream.record}.${upstream.role} actor`,
        });
      }
      if (
        nonEmptyString(judge?.context_partition) &&
        normalizeIdentityText(judge.context_partition) ===
          normalizeIdentityText(upstreamActor.context_partition)
      ) {
        issues.push({
          code: `${channel}_judge_upstream_context_reuse`,
          key,
          message: `${channel} judge "${judge.id}" 不得复用上游 ${upstream.record}.${upstream.role} context_partition`,
        });
      }
      if (
        nonEmptyString(judge?.prompt?.digest) &&
        normalizeIdentityText(judge.prompt.digest) ===
          normalizeIdentityText(upstreamActor.prompt?.digest)
      ) {
        issues.push({
          code: `${channel}_judge_upstream_prompt_reuse`,
          key,
          message: `${channel} judge "${judge.id}" 不得复用上游 ${upstream.record}.${upstream.role} prompt`,
        });
      }
    }
  }

  const repairCritic = repair?.actors?.critic;
  const runCriticMatches = (run?.actor_profiles?.critics ?? []).filter(
    (critic) => critic?.id === repairCritic?.id,
  );
  if (runCriticMatches.length !== 1) {
    issues.push({
      code: "repair_critic_verification_handoff_missing",
      key: repairCritic?.id ?? "missing",
      message:
        "verification_run.actor_profiles.critics 必须精确包含 repair_attempt 声明的 critic",
    });
  } else {
    const runCritic = runCriticMatches[0];
    const sameCriticIdentity =
      runCritic.kind === repairCritic.kind &&
      runCritic.role === repairCritic.role &&
      sameOrigin(runCritic.origin, repairCritic.origin) &&
      stableStringify(runCritic.prompt) === stableStringify(repairCritic.prompt);
    const sameInvocation =
      runCritic.context_partition === repairCritic.context_partition &&
      runCritic.seed === repairCritic.seed &&
      runCritic.temperature === repairCritic.temperature;
    const verifiablyFreshInvocation =
      nonEmptyString(runCritic.context_partition) &&
      nonEmptyString(repairCritic.context_partition) &&
      normalizeIdentityText(runCritic.context_partition) !==
        normalizeIdentityText(repairCritic.context_partition) &&
      runCritic.seed !== undefined &&
      repairCritic.seed !== undefined &&
      runCritic.seed !== repairCritic.seed &&
      run?.identity_isolation?.no_shared_scratchpad === true;
    if (
      !sameCriticIdentity ||
      (!sameInvocation && !verifiablyFreshInvocation)
    ) {
      issues.push({
        code: "repair_critic_verification_handoff_mismatch",
        key: repairCritic.id,
        message:
          "verification critic 必须保持 repair critic 的 ID/origin/prompt，且复用原 invocation 或声明可验证的新鲜 context+seed",
      });
    }
  }

  const evidenceById = new Map();
  const findingById = new Map();
  const supportingEvidenceIdsByFinding = new Map();
  for (const finding of trace?.findings ?? []) {
    findingById.set(finding.finding_id, finding);
    const supportingEvidenceIds = new Set();
    for (const evidence of finding.evidence ?? []) {
      evidenceById.set(evidence.evidence_id, {
        finding_id: finding.finding_id,
        evidence,
      });
      if (evidence.stance === "supports") {
        supportingEvidenceIds.add(evidence.evidence_id);
      }
    }
    supportingEvidenceIdsByFinding.set(
      finding.finding_id,
      supportingEvidenceIds,
    );
  }

  const targetFindingIds = [
    ...new Set(repair?.target_finding_ids ?? []),
  ].sort();
  const targetFindingIdSet = new Set(targetFindingIds);
  const primaryTargetTurnId = trace?.subject?.generator_output_turn_id;
  const primaryTargetTurn = (trace?.subject?.turns ?? []).find(
    (turn) => turn.turn_id === primaryTargetTurnId,
  );
  if (
    !primaryTargetTurn ||
    repair?.target_turn_id !== primaryTargetTurnId
  ) {
    issues.push({
      code: "repair_target_turn_mismatch",
      key: repair?.target_turn_id ?? "missing",
      message:
        "当前 alpha repair_attempt.target_turn_id 必须精确等于 diagnostic_trace 的 primary generator output turn",
    });
  }
  const reparablePriorityFindingIds = [
    ...new Set(
      (trace?.disposition?.priority_finding_ids ?? []).filter((findingId) => {
        const finding = findingById.get(findingId);
        return finding?.status === "present" && finding?.label_kind === "symptom";
      }),
    ),
  ].sort();

  for (const findingId of targetFindingIds) {
    const finding = findingById.get(findingId);
    if (!finding) {
      issues.push({
        code: "repair_target_unknown_finding",
        key: findingId,
        message: `repair_attempt 引用了不存在的 finding "${findingId}"`,
      });
    } else if (finding.status !== "present" || finding.label_kind !== "symptom") {
      issues.push({
        code: "repair_target_not_present_symptom",
        key: findingId,
        message: `repair_attempt 目标 finding "${findingId}" 必须是 present symptom`,
      });
    } else if (
      !(finding.evidence ?? []).some(
        (evidence) =>
          evidence.stance === "supports" &&
          evidence.turn_id === primaryTargetTurnId,
      )
    ) {
      issues.push({
        code: "repair_target_not_grounded_in_target_turn",
        key: findingId,
        message: `repair target finding "${findingId}" 必须在 target_turn_id 上拥有 supports evidence`,
      });
    }
  }
  if (!sameStringArray(targetFindingIds, reparablePriorityFindingIds)) {
    issues.push({
      code: "repair_target_priority_set_mismatch",
      key: "repair.target_finding_ids",
      message:
        "repair target findings 必须与 disposition.priority_finding_ids 中的 present symptoms 完全一致",
    });
  }

  const checkedTargetFindingIds = [
    ...new Set(
      (run?.target_failure_checks ?? []).map((check) => check.finding_id),
    ),
  ].sort();
  for (const check of run?.target_failure_checks ?? []) {
    if (!findingById.has(check.finding_id)) {
      issues.push({
        code: "target_failure_check_unknown_finding",
        key: `${check.check_id}:${check.finding_id}`,
        message: `target_failure_checks 引用了不存在的 finding "${check.finding_id}"`,
      });
    }
    if (check.target_turn_id !== repair?.target_turn_id) {
      issues.push({
        code: "target_failure_check_turn_mismatch",
        key: check.check_id,
        message: `target_failure_check "${check.check_id}" 未绑定 repair target turn`,
      });
    }
  }
  if (!sameStringArray(targetFindingIds, checkedTargetFindingIds)) {
    issues.push({
      code: "target_failure_check_target_set_mismatch",
      key: "run.target_failure_checks",
      message:
        "target_failure_checks 必须完整覆盖且只能覆盖 repair target findings",
    });
  }

  for (const check of run?.evidence_checks ?? []) {
    const checkedFinding = findingById.get(check.finding_id);
    if (!checkedFinding) {
      issues.push({
        code: "evidence_check_unknown_finding",
        key: `${check.check_id}:${check.finding_id}`,
        message: `evidence_checks 引用了不存在的 finding "${check.finding_id}"`,
      });
    } else if (!targetFindingIdSet.has(check.finding_id)) {
      issues.push({
        code: "evidence_check_non_target_finding",
        key: `${check.check_id}:${check.finding_id}`,
        message: `evidence_checks 引用了非修复目标 finding "${check.finding_id}"`,
      });
    }
    if (check.target_turn_id !== repair?.target_turn_id) {
      issues.push({
        code: "evidence_check_turn_mismatch",
        key: check.check_id,
        message: `evidence_check "${check.check_id}" 未绑定 repair target turn`,
      });
    }
    const expectedSupportingEvidenceIds = (checkedFinding?.evidence ?? [])
      .filter(
        (evidence) =>
          evidence.stance === "supports" &&
          evidence.turn_id === repair?.target_turn_id,
      )
      .map((evidence) => evidence.evidence_id)
      .sort();
    const observedEvidenceIds = [...(check.evidence_ids ?? [])].sort();
    if (!sameStringArray(observedEvidenceIds, expectedSupportingEvidenceIds)) {
      issues.push({
        code: "evidence_check_support_set_mismatch",
        key: check.check_id,
        message: `evidence_check "${check.check_id}" 必须逐项覆盖 finding "${check.finding_id}" 在 target turn 上的全部 supports evidence，且不得夹带其他证据`,
      });
    }
    for (const evidenceId of check.evidence_ids ?? []) {
      const ownedEvidence = evidenceById.get(evidenceId);
      if (!ownedEvidence) {
        issues.push({
          code: "evidence_check_unknown_evidence",
          key: `${check.check_id}:${evidenceId}`,
          message: `evidence_checks 引用了不存在的 evidence "${evidenceId}"`,
        });
        continue;
      }
      if (ownedEvidence.finding_id !== check.finding_id) {
        issues.push({
          code: "evidence_check_finding_mismatch",
          key: `${check.check_id}:${evidenceId}`,
          message: `evidence_checks 的 evidence "${evidenceId}" 必须属于 finding "${check.finding_id}" 且 stance 为 supports`,
        });
      }
      if (ownedEvidence.evidence.stance !== "supports") {
        issues.push({
          code: "evidence_check_non_supporting_evidence",
          key: `${check.check_id}:${evidenceId}`,
          message: `evidence_checks 的 evidence "${evidenceId}" 必须属于 finding "${check.finding_id}" 且 stance 为 supports`,
        });
      }
    }
  }

  for (const check of run?.counterfactual_checks ?? []) {
    const finding = findingById.get(check.finding_id);
    const matchingResults = (finding?.taxonomy_test_results ?? []).filter(
      (result) =>
        result.recipe_id === check.recipe_id &&
        result.execution?.execution_id === check.source_execution_id,
    );
    const result = matchingResults[0];
    const execution = result?.execution;
    const expectedContractPaths = [
      ...new Set(
        (execution?.judgment?.invariants ?? [])
          .filter(
            (invariant) =>
              invariant.source_kind === "scene_contract" &&
              invariant.status === "passed",
          )
          .flatMap((invariant) => invariant.contract_paths ?? []),
      ),
    ].sort();
    if (
      !finding ||
      !targetFindingIdSet.has(check.finding_id) ||
      matchingResults.length !== 1 ||
      result.outcome !== "passed" ||
      check.target_turn_id !== repair?.target_turn_id ||
      execution?.intervention?.target_turn_id !== check.target_turn_id ||
      check.source_execution_digest !== execution?.execution_digest ||
      stableStringify(check.intervention) !==
        stableStringify(execution?.intervention) ||
      !sameStringArray(
        [...(check.invariant_contract_paths ?? [])].sort(),
        expectedContractPaths,
      ) ||
      expectedContractPaths.length === 0
    ) {
      issues.push({
        code: "counterfactual_source_binding_mismatch",
        key: check.check_id,
        message: `counterfactual_check "${check.check_id}" 必须逐字段重放 repair target 的已通过结构化 taxonomy test 与 scene-contract invariants`,
      });
    }
  }

  const editTargetFindingIds = [
    ...new Set(
      (repair?.repair_plan?.edits ?? []).map((edit) => edit.target_finding_id),
    ),
  ].sort();
  for (const edit of repair?.repair_plan?.edits ?? []) {
    if (!targetFindingIdSet.has(edit.target_finding_id)) {
      issues.push({
        code: "repair_edit_non_target_finding",
        key: `${edit.edit_id}:${edit.target_finding_id}`,
        message: `repair edit 引用了非目标 finding "${edit.target_finding_id}"`,
      });
    }
    if (edit.target_turn_id !== repair?.target_turn_id) {
      issues.push({
        code: "repair_edit_turn_mismatch",
        key: edit.edit_id,
        message: `repair edit "${edit.edit_id}" 未绑定唯一 target turn`,
      });
    }
    const ownedSupportingEvidence =
      supportingEvidenceIdsByFinding.get(edit.target_finding_id) ?? new Set();
    for (const evidenceId of edit.source_evidence_ids ?? []) {
      if (!evidenceById.has(evidenceId)) {
        issues.push({
          code: "repair_edit_unknown_evidence",
          key: `${edit.edit_id}:${evidenceId}`,
          message: `repair edit 引用了不存在的 evidence "${evidenceId}"`,
        });
      } else if (!ownedSupportingEvidence.has(evidenceId)) {
        issues.push({
          code: "repair_edit_non_supporting_evidence",
          key: `${edit.edit_id}:${evidenceId}`,
          message: `repair edit 的 source evidence "${evidenceId}" 必须属于 target finding "${edit.target_finding_id}" 且 stance 为 supports`,
        });
      } else if (
        evidenceById.get(evidenceId)?.evidence?.turn_id !==
        repair?.target_turn_id
      ) {
        issues.push({
          code: "repair_edit_evidence_wrong_turn",
          key: `${edit.edit_id}:${evidenceId}`,
          message: `repair edit 的 source evidence "${evidenceId}" 必须来自 target_turn_id`,
        });
      }
    }
  }
  if (!sameStringArray(targetFindingIds, editTargetFindingIds)) {
    issues.push({
      code: "repair_edit_target_set_mismatch",
      key: "repair.repair_plan.edits",
      message: "repair edits 必须完整覆盖且只能覆盖 repair target findings",
    });
  }

  validateReplayableEdits(repair, primaryTargetTurn, issues);

  const primaryScene = (trace?.subject?.scenes ?? []).find(
    (scene) => scene.scene_id === primaryTargetTurn?.scene_id,
  );
  const regressionById = new Map(
    (run?.regression_checks ?? []).map((check) => [check.check_id, check]),
  );
  const preservationConstraints =
    repair?.repair_plan?.preservation_contract ?? [];
  const preservationById = new Map(
    preservationConstraints.map((constraint) => [
      constraint.constraint_id,
      constraint,
    ]),
  );
  for (const constraint of preservationConstraints) {
    for (const pointer of constraint.source_contract_paths ?? []) {
      if (readJsonPointer(primaryScene?.contract, pointer) === undefined) {
        issues.push({
          code: "preservation_contract_path_invalid",
          key: `${constraint.constraint_id}:${pointer}`,
          message: `preservation constraint "${constraint.constraint_id}" 引用了不存在的 scene contract path`,
        });
      }
    }
    for (const checkId of constraint.verification_check_ids ?? []) {
      const check = regressionById.get(checkId);
      if (
        !check ||
        check.passed !== true ||
        check.hard_veto !== true ||
        check.contamination_status !== "clean" ||
        !(check.preservation_constraint_ids ?? []).includes(
          constraint.constraint_id,
        )
      ) {
        issues.push({
          code: "preservation_contract_check_invalid",
          key: `${constraint.constraint_id}:${checkId}`,
          message: `preservation constraint "${constraint.constraint_id}" 必须链接通过、clean 且 hard-veto 的冻结 regression check`,
        });
      }
    }
  }
  for (const check of run?.regression_checks ?? []) {
    for (const constraintId of check.preservation_constraint_ids ?? []) {
      const constraint = preservationById.get(constraintId);
      if (
        !constraint ||
        !(constraint.verification_check_ids ?? []).includes(check.check_id)
      ) {
        issues.push({
          code: "preservation_contract_reverse_link_invalid",
          key: `${check.check_id}:${constraintId}`,
          message:
            "regression check 的 preservation_constraint_ids 必须与 repair preservation contract 双向精确链接",
        });
      }
    }
  }

  const repairActorIds = new Set(
    Object.values(repair?.actors ?? {})
      .map((actor) => actor?.id)
      .filter(Boolean),
  );
  for (const candidate of Object.values(repair?.candidates ?? {})) {
    if (!repairActorIds.has(candidate?.producer_actor_id)) {
      issues.push({
        code: "candidate_producer_undeclared",
        key: `${candidate?.candidate_id ?? "unknown"}:${candidate?.producer_actor_id ?? "missing"}`,
        message: `candidate 引用了未声明的 producer "${candidate?.producer_actor_id}"`,
      });
    }
  }
  if (
    repair?.candidates?.baseline?.producer_actor_id !==
    repair?.actors?.baseline_generator?.id
  ) {
    issues.push({
      code: "baseline_producer_role_mismatch",
      key: "repair.candidates.baseline.producer_actor_id",
      message: "repair baseline 必须由声明的 baseline_generator 产生",
    });
  }
  if (
    repair?.candidates?.candidate?.producer_actor_id !==
    repair?.actors?.repair_generator?.id
  ) {
    issues.push({
      code: "candidate_producer_role_mismatch",
      key: "repair.candidates.candidate.producer_actor_id",
      message: "repair candidate 必须由声明的 repair_generator 产生",
    });
  }

  if (repair?.critic_check?.critic_id !== repair?.actors?.critic?.id) {
    issues.push({
      code: "critic_check_actor_mismatch",
      key: "repair.critic_check.critic_id",
      message: `critic_check.critic_id 必须精确引用声明的 critic "${repair?.actors?.critic?.id}"`,
    });
  }
  if (
    repair?.critic_check?.targeted_failures_reduced !== true ||
    repair?.critic_check?.ready_for_blind_verification !== true
  ) {
    issues.push({
      code: "critic_check_not_ready",
      key: "repair.critic_check",
      message: "critic_check 未确认目标失败降低并允许进入盲测",
    });
  }
  const presentNewFailures = (repair?.critic_check?.new_failure_scan ?? [])
    .filter((item) => item.status === "present")
    .map((item) => item.label_id)
    .sort();
  if (presentNewFailures.length > 0) {
    issues.push({
      code: "critic_check_new_failure_present",
      key: presentNewFailures.join(","),
      message: `critic_check 检出新的 present failure：${presentNewFailures.join(", ")}`,
    });
  }

  const criticChallenges = repair?.critic_check?.unresolved_challenges ?? [];
  const verificationChallenges = run?.challenges ?? [];
  const criticChallengeIds = criticChallenges
    .map((challenge) => challenge?.challenge_id)
    .filter(Boolean);
  for (const challengeId of findDuplicates(criticChallengeIds)) {
    issues.push({
      code: "critic_challenge_id_duplicate",
      key: challengeId,
      message: `critic_check.unresolved_challenges 重复使用 challenge_id "${challengeId}"`,
    });
  }
  const verificationChallengesById = new Map();
  for (const challenge of verificationChallenges) {
    const challengeId = challenge?.challenge_id;
    if (!challengeId) continue;
    const matches = verificationChallengesById.get(challengeId) ?? [];
    matches.push(challenge);
    verificationChallengesById.set(challengeId, matches);
  }
  for (const criticChallenge of criticChallenges) {
    const challengeId = criticChallenge?.challenge_id;
    if (!challengeId) continue;
    if (
      (criticChallenge.target_finding_ids ?? []).some(
        (findingId) => !targetFindingIdSet.has(findingId),
      )
    ) {
      issues.push({
        code: "critic_challenge_non_target_finding",
        key: challengeId,
        message: `critic 未决挑战 "${challengeId}" 只能绑定本次 repair target findings`,
      });
    }
    const matches = verificationChallengesById.get(challengeId) ?? [];
    if (matches.length !== 1) {
      issues.push({
        code:
          matches.length === 0
            ? "critic_challenge_handoff_missing"
            : "critic_challenge_handoff_duplicate",
        key: challengeId,
        message: `critic 未决挑战 "${challengeId}" 必须在 verification_run.challenges 中精确交接一次`,
      });
      continue;
    }
    const verificationChallenge = matches[0];
    if (
      verificationChallenge.raised_by !== repair?.critic_check?.critic_id ||
      verificationChallenge.challenge_kind !==
        criticChallenge.challenge_kind ||
      verificationChallenge.severity !== criticChallenge.severity ||
      verificationChallenge.claim !== criticChallenge.claim ||
      !sameStringArray(
        [...(verificationChallenge.target_finding_ids ?? [])].sort(),
        [...(criticChallenge.target_finding_ids ?? [])].sort(),
      ) ||
      !sameStringArray(
        [...(verificationChallenge.required_resolution_check_ids ?? [])].sort(),
        [...(criticChallenge.required_resolution_check_ids ?? [])].sort(),
      )
    ) {
      issues.push({
        code: "critic_challenge_handoff_metadata_mismatch",
        key: challengeId,
        message: `critic 未决挑战 "${challengeId}" 在验证交接中必须保留 critic identity、kind、severity、claim、target_finding_ids 与 required_resolution_check_ids`,
      });
    }
  }

  if (
    repair?.verification_handoff?.blinding_protocol_digest !==
    computeBlindingProtocolDigest(run)
  ) {
    issues.push({
      code: "blinding_protocol_handoff_mismatch",
      key: "repair.verification_handoff.blinding_protocol_digest",
      message:
        "repair_attempt handoff 与 verification_run 的候选无关盲化协议 digest 不一致",
    });
  }
  const expectedSuites = [
    "challenge",
    "counterfactual",
    "evidence",
    "order_swap",
    "regression",
  ];
  if (
    !sameStringArray(
      [...(repair?.verification_handoff?.required_suites ?? [])].sort(),
      expectedSuites,
    ) ||
    policy?.verification_protocol?.challenge_round_required !== true ||
    policy?.verification_protocol?.counterfactual_suite_required !== true ||
    policy?.verification_protocol?.regression_suite_required !== true ||
    policy?.verification_protocol?.evidence_trace_required !== true ||
    policy?.verification_protocol?.pairwise_blind_comparison !== true
  ) {
    issues.push({
      code: "verification_handoff_suite_mismatch",
      key: "repair.verification_handoff.required_suites",
      message:
        "repair verification handoff 必须与 policy 精确冻结 order_swap/evidence/counterfactual/regression/challenge 五类验证",
    });
  }

  return issues;
}

function validateReplayableEdits(repair, targetTurn, issues) {
  const baseline = repair?.candidates?.baseline?.content;
  const candidate = repair?.candidates?.candidate?.content;
  if (
    typeof baseline !== "string" ||
    typeof candidate !== "string" ||
    targetTurn?.content !== baseline
  ) {
    issues.push({
      code: "repair_edit_baseline_mismatch",
      key: repair?.target_turn_id ?? "missing",
      message: "repair edit baseline 必须逐字等于 target turn content",
    });
    return;
  }
  const baselineCodepoints = Array.from(baseline);
  const edits = [...(repair?.repair_plan?.edits ?? [])].sort(
    (left, right) => left.span.start - right.span.start,
  );
  let priorEnd = -1;
  let structurallyValid = true;
  for (const edit of edits) {
    const start = edit?.span?.start;
    const end = edit?.span?.end;
    const expected =
      Number.isInteger(start) && Number.isInteger(end)
        ? baselineCodepoints.slice(start, end).join("")
        : null;
    if (
      edit.operation !== "replace" ||
      edit?.span?.unit !== "unicode_codepoint" ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > baselineCodepoints.length ||
      start < priorEnd ||
      expected !== edit.expected_text ||
      typeof edit.replacement_text !== "string"
    ) {
      structurallyValid = false;
      issues.push({
        code: "repair_edit_not_replayable",
        key: edit?.edit_id ?? "missing",
        message: `repair edit "${edit?.edit_id ?? "missing"}" 的 span/expected_text 无法在 baseline 上重放`,
      });
    }
    if (Number.isInteger(end)) priorEnd = Math.max(priorEnd, end);
  }
  if (!structurallyValid) return;
  let replayed = [...baselineCodepoints];
  for (const edit of [...edits].reverse()) {
    replayed.splice(
      edit.span.start,
      edit.span.end - edit.span.start,
      ...Array.from(edit.replacement_text),
    );
  }
  if (replayed.join("") !== candidate) {
    issues.push({
      code: "repair_edit_replay_candidate_mismatch",
      key: repair?.repair_id ?? "missing",
      message: "声明的 repair edits 重放结果必须逐字等于 candidate content",
    });
  }
}

function computeBlindingProtocolDigest(run) {
  const blinding = run?.blinding;
  if (!blinding || typeof blinding !== "object") return null;
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

function readJsonPointer(value, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return undefined;
  let current = value;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (current && typeof current === "object") {
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

function checkRecordIsolation(
  record,
  actors,
  requiredPairs,
  policy,
  issues,
) {
  const actorIdList = actors.map((actor) => actor?.id).filter(Boolean);
  const actorIds = new Set(actorIdList);
  for (const actorId of findDuplicates(actorIdList)) {
    issues.push({
      code: "record_actor_id_duplicate",
      key: `${record?.record_type ?? "unknown"}:${actorId}`,
      message: `${record?.record_type ?? "unknown"} 的不同 actor 角色重复使用 id "${actorId}"`,
    });
  }
  const actorById = new Map(
    actors.filter((actor) => actor?.id).map((actor) => [actor.id, actor]),
  );
  const observed = new Set();
  for (const pair of record?.identity_isolation?.pairs ?? []) {
    const key = pairKey(pair.left_actor_id, pair.right_actor_id);
    const pairValidation = validateIdentityIsolationPair({
      record,
      pair,
      leftActor: actorById.get(pair.left_actor_id),
      rightActor: actorById.get(pair.right_actor_id),
      policy,
    });
    const valid =
      pair.left_actor_id !== pair.right_actor_id &&
      actorIds.has(pair.left_actor_id) &&
      actorIds.has(pair.right_actor_id) &&
      pair.verified === true &&
      pair.independent_context === true &&
      pairValidation.pass &&
      !observed.has(key);
    if (!valid) {
      issues.push({
        code: "record_identity_isolation_invalid",
        key: `${record?.record_type ?? "unknown"}:${key}`,
        message: `${record?.record_type ?? "unknown"}.identity_isolation 含无效或重复 actor pair "${key}"`,
      });
    }
    observed.add(key);
  }
  for (const [left, right] of requiredPairs) {
    const key = pairKey(left, right);
    if (!left || !right || !observed.has(key)) {
      issues.push({
        code: "record_identity_isolation_missing_pair",
        key: `${record?.record_type ?? "unknown"}:${key}`,
        message: `${record?.record_type ?? "unknown"}.identity_isolation 缺少必需 actor pair "${key}"`,
      });
    }
  }
  if (
    record?.identity_isolation?.no_shared_scratchpad !== true ||
    record?.identity_isolation?.role_prompts_separated !== true
  ) {
    issues.push({
      code: "record_identity_isolation_context_unverified",
      key: record?.record_type ?? "unknown",
      message: `${record?.record_type ?? "unknown"}.identity_isolation 未确认上下文隔离`,
    });
  }
}

export function validateIdentityIsolationPair({
  record,
  pair,
  leftActor,
  rightActor,
  policy,
  blinding = null,
}) {
  const reasons = [];
  if (!leftActor || !rightActor) {
    reasons.push("actor_missing");
    return { pass: false, reasons };
  }

  const acceptedMechanisms = new Set(
    policy?.actor_isolation?.accepted_mechanisms ?? [],
  );
  const mechanisms = pair?.mechanisms ?? [];
  if (!mechanisms.some((mechanism) => acceptedMechanisms.has(mechanism))) {
    reasons.push("accepted_mechanism_missing");
  }

  const leftPromptDigest = normalizeIdentityText(leftActor.prompt?.digest);
  const rightPromptDigest = normalizeIdentityText(rightActor.prompt?.digest);
  const promptSeparated =
    leftPromptDigest.length > 0 &&
    rightPromptDigest.length > 0 &&
    leftPromptDigest !== rightPromptDigest;
  const leftContext = normalizeIdentityText(leftActor.context_partition);
  const rightContext = normalizeIdentityText(rightActor.context_partition);
  const contextSeparated =
    leftContext.length > 0 &&
    rightContext.length > 0 &&
    leftContext !== rightContext;
  const leftProvider = normalizeIdentityText(leftActor.origin?.provider);
  const rightProvider = normalizeIdentityText(rightActor.origin?.provider);
  const providerSeparated =
    leftProvider.length > 0 &&
    rightProvider.length > 0 &&
    leftProvider !== rightProvider;
  const modelIdentityMatches =
    stableStringify({
      model: normalizeIdentityText(leftActor.origin?.model),
      model_version: normalizeIdentityText(leftActor.origin?.model_version),
    }) ===
    stableStringify({
      model: normalizeIdentityText(rightActor.origin?.model),
      model_version: normalizeIdentityText(rightActor.origin?.model_version),
    });
  const weightsDigestMatches =
    nonEmptyString(leftActor.origin?.weights_digest) &&
    leftActor.origin.weights_digest === rightActor.origin?.weights_digest;
  const modelSeparated = !modelIdentityMatches && !weightsDigestMatches;
  const seedSeparated =
    leftActor.seed !== undefined &&
    rightActor.seed !== undefined &&
    leftActor.seed !== rightActor.seed;
  const mechanismEvidence = {
    separate_context: contextSeparated,
    separate_prompt: promptSeparated,
    separate_model: modelSeparated,
    separate_provider: providerSeparated,
    fresh_seed: seedSeparated,
    blinded_candidate_identity:
      blinding?.candidate_origin_hidden === true &&
      blinding?.model_identity_hidden === true,
    no_shared_scratchpad:
      record?.identity_isolation?.no_shared_scratchpad === true,
  };
  for (const mechanism of mechanisms) {
    if (mechanismEvidence[mechanism] !== true) {
      reasons.push(`mechanism_unsubstantiated:${mechanism}`);
    }
  }
  if (
    pair?.independent_context === true &&
    !contextSeparated
  ) {
    reasons.push("independent_context_not_separated");
  }
  if (
    record?.identity_isolation?.role_prompts_separated === true &&
    !promptSeparated
  ) {
    reasons.push("role_prompt_not_separated");
  }
  if (
    policy?.actor_isolation?.same_model_weights_allowed === false &&
    !modelSeparated
  ) {
    reasons.push("model_weights_not_separated");
  }
  return { pass: reasons.length === 0, reasons };
}

function sameOrigin(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function pairKey(left, right) {
  return [left, right].sort().join("<->");
}

function sameStringArray(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function normalizeIdentityText(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    : "";
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

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
