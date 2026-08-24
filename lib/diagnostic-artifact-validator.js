import { sha256Json, sha256Text } from "./content-integrity.js";

export function computeTaxonomyTestInputDigest(
  trace,
  result,
  finding = null,
  taxonomy = null,
  recipe = null,
) {
  const execution = result?.execution;
  if (!execution) return null;
  const turns = new Map(
    (trace?.subject?.turns ?? []).map((turn) => [turn.turn_id, turn]),
  );
  const targetTurn = turns.get(execution?.intervention?.target_turn_id);
  const scene = (trace?.subject?.scenes ?? []).find(
    (item) => item.scene_id === targetTurn?.scene_id,
  );
  const inputTurns = (execution.input_turn_ids ?? []).map((turnId) =>
    turns.get(turnId),
  );
  if (!targetTurn || !scene || inputTurns.some((turn) => !turn)) return null;
  const resolvedFinding =
    finding ??
    (trace?.findings ?? []).find((item) =>
      (item.taxonomy_test_results ?? []).includes(result),
    );
  const resolvedEvidence = (result.evidence_ids ?? []).map((evidenceId) =>
    (resolvedFinding?.evidence ?? []).find(
      (evidence) => evidence.evidence_id === evidenceId,
    ),
  );
  const judgeActor = Object.values(trace?.actors ?? {}).find(
    (actor) => actor?.id === execution.judge_actor_id,
  );
  if (
    !resolvedFinding ||
    resolvedEvidence.some((evidence) => !evidence) ||
    !judgeActor
  ) {
    return null;
  }
  try {
    return sha256Json({
      taxonomy_digest: taxonomy ? sha256Json(taxonomy) : null,
      finding: {
        finding_id: resolvedFinding.finding_id,
        label_id: resolvedFinding.label_id,
        label_kind: resolvedFinding.label_kind,
        scope: resolvedFinding.scope,
      },
      recipe: recipe ?? null,
      taxonomy_test: result.taxonomy_test,
      evidence: resolvedEvidence,
      method: execution.method,
      input_turns: inputTurns,
      scene_contract_digest: scene.contract_digest,
      intervention: execution.intervention,
      judge_actor: judgeActor,
    });
  } catch {
    return null;
  }
}

export function computeTaxonomyTestExecutionDigest({
  finding,
  result,
  taxonomy,
  recipe,
}) {
  if (!finding || !result?.execution) return null;
  const executionPayload = { ...result.execution };
  delete executionPayload.execution_digest;
  try {
    return sha256Json({
      taxonomy_digest: taxonomy ? sha256Json(taxonomy) : null,
      finding_id: finding.finding_id,
      label_id: finding.label_id,
      recipe: recipe ?? null,
      result: {
        recipe_id: result.recipe_id,
        taxonomy_test: result.taxonomy_test,
        outcome: result.outcome,
        rationale: result.rationale,
        evidence_ids: result.evidence_ids,
      },
      execution: executionPayload,
    });
  } catch {
    return null;
  }
}

export function validateDiagnosticArtifact(trace, taxonomy) {
  const messages = [];
  const add = (message) => messages.push(message);
  const turns = new Map();
  const turnOrder = new Map();
  for (const [index, turn] of (trace?.subject?.turns ?? []).entries()) {
    if (turns.has(turn.turn_id)) {
      add(`diagnostic_trace 重复 turn_id "${turn.turn_id}"`);
    } else {
      turns.set(turn.turn_id, turn);
      turnOrder.set(turn.turn_id, index);
    }
  }
  const generatorOutputTurnIds = new Set(
    trace?.subject?.generator_output_turn_ids ?? [],
  );
  const scenes = new Map();
  const contractGroundingIds = new Set();
  for (const scene of trace?.subject?.scenes ?? []) {
    if (scenes.has(scene.scene_id)) {
      add(`diagnostic_trace 重复 scene_id "${scene.scene_id}"`);
    } else {
      scenes.set(scene.scene_id, scene);
    }
  }
  for (const turn of turns.values()) {
    const scene = scenes.get(turn.scene_id);
    if (!scene || !(scene.turn_ids ?? []).includes(turn.turn_id)) {
      add(
        `turn "${turn.turn_id}" 的 scene_id/scene.turn_ids 映射不完整`,
      );
    }
  }
  for (const scene of scenes.values()) {
    if (!scene.contract || scene.contract_digest !== sha256Json(scene.contract)) {
      add(`scene "${scene.scene_id}" 的 contract_digest 不能由内嵌 contract 重算`);
    }
    for (const turnId of scene.turn_ids ?? []) {
      if (turns.get(turnId)?.scene_id !== scene.scene_id) {
        add(`scene "${scene.scene_id}" 引用了不匹配的 turn "${turnId}"`);
      }
    }
    const outputTurns = (scene.turn_ids ?? [])
      .filter((turnId) => generatorOutputTurnIds.has(turnId))
      .map((turnId) => turns.get(turnId))
      .filter(Boolean);
    for (const sourceTurnId of scene.contract?.source_turn_ids ?? []) {
      const sourceTurn = turns.get(sourceTurnId);
      if (!sourceTurn || sourceTurn.scene_id !== scene.scene_id) {
        add(
          `scene "${scene.scene_id}" 的 contract source_turn_id "${sourceTurnId}" 不属于该 scene`,
        );
        continue;
      }
      if (generatorOutputTurnIds.has(sourceTurnId)) {
        add(
          `scene "${scene.scene_id}" 的 contract 不得把待评估 generator output 当作生成前来源`,
        );
      }
      for (const outputTurn of outputTurns) {
        const sourceAt = Date.parse(sourceTurn.created_at ?? "");
        const outputAt = Date.parse(outputTurn.created_at ?? "");
        if (
          !Number.isFinite(sourceAt) ||
          !Number.isFinite(outputAt) ||
          sourceAt >= outputAt ||
          turnOrder.get(sourceTurnId) >= turnOrder.get(outputTurn.turn_id)
        ) {
          add(
            `scene "${scene.scene_id}" 的 contract source "${sourceTurnId}" 必须早于 generator output "${outputTurn.turn_id}"`,
          );
        }
      }
    }
    validateSceneContractGrounding({
      scene,
      turns,
      outputTurns,
      contractCriticId: trace?.actors?.contract_critic?.id,
      groundingIds: contractGroundingIds,
      add,
    });
  }
  let previousTurnAt = Number.NEGATIVE_INFINITY;
  for (const turn of trace?.subject?.turns ?? []) {
    const turnAt = Date.parse(turn.created_at ?? "");
    if (!Number.isFinite(turnAt) || turnAt < previousTurnAt) {
      add(`turn "${turn.turn_id}" 的 created_at 缺失或早于前一条 subject turn`);
    }
    if (Number.isFinite(turnAt)) previousTurnAt = turnAt;
  }
  const traceCreatedAt = Date.parse(trace?.provenance?.created_at ?? "");
  if (
    !Number.isFinite(traceCreatedAt) ||
    [...turns.values()].some(
      (turn) => Date.parse(turn.created_at ?? "") > traceCreatedAt,
    )
  ) {
    add("diagnostic_trace.provenance.created_at 必须不早于全部 subject turns");
  }
  const validGeneratorOutputTurnIds = new Set();
  if (
    trace?.subject?.generator_output_turn_id &&
    !generatorOutputTurnIds.has(trace.subject.generator_output_turn_id)
  ) {
    add("subject.generator_output_turn_id 必须包含在 generator_output_turn_ids 中");
  }
  for (const turnId of generatorOutputTurnIds) {
    const turn = turns.get(turnId);
    if (!turn || turn.speaker !== "assistant") {
      add(
        `subject.generator_output_turn_ids 中的 "${turnId}" 必须指向真实的 assistant turn`,
      );
    } else {
      validGeneratorOutputTurnIds.add(turnId);
    }
  }
  const primaryOutputTurn = turns.get(trace?.subject?.generator_output_turn_id);
  const primaryScene = scenes.get(primaryOutputTurn?.scene_id);
  if (
    primaryScene &&
    (!primaryScene.contract ||
      !trace?.scene_contract ||
      primaryScene.contract_digest !== sha256Json(trace.scene_contract) ||
      sha256Json(primaryScene.contract) !== sha256Json(trace.scene_contract))
  ) {
    add("主 generator output 所属 scene 的内嵌 contract 与 scene_contract 不一致");
  }
  const evidenceIds = new Set();
  const taxonomyTestExecutionIds = new Set();
  const findingById = new Map();
  for (const finding of trace?.findings ?? []) {
    if (
      finding.label_kind === "symptom" &&
      finding.status !== "present" &&
      (finding.taxonomy_test_results !== undefined ||
        finding.neighboring_label_rebuttals !== undefined)
    ) {
      add(
        `finding "${finding.finding_id}" 不是 present symptom，不得携带 taxonomy test 或 neighboring rebuttal`,
      );
    }
    if (findingById.has(finding.finding_id)) {
      add(`diagnostic_trace 重复 finding_id "${finding.finding_id}"`);
    } else {
      findingById.set(finding.finding_id, finding);
    }
  }
  const findingIds = new Set(findingById.keys());
  const priorityFindingIds = trace?.disposition?.priority_finding_ids ?? [];
  if (
    trace?.disposition?.repair_recommended === true &&
    priorityFindingIds.length === 0
  ) {
    add("disposition.repair_recommended 为 true 时必须给出 priority_finding_ids");
  }
  if (
    trace?.disposition?.repair_recommended === false &&
    priorityFindingIds.length > 0
  ) {
    add("disposition.repair_recommended 为 false 时不得给出 priority_finding_ids");
  }
  for (const findingId of priorityFindingIds) {
    const finding = findingById.get(findingId);
    if (!finding || !["present", "uncertain"].includes(finding.status)) {
      add(
        `disposition.priority_finding_ids 中的 "${findingId}" 必须指向 present 或 uncertain finding`,
      );
    }
  }
  const ontologyKinds = new Map();
  const symptomParents = new Map();
  const symptomMetadata = new Map();
  const causalContracts = new Map();
  if (taxonomy) {
    for (const layer of taxonomy.layers ?? []) {
      for (const subcategory of layer.subcategories ?? []) {
        for (const label of subcategory.labels ?? []) {
          ontologyKinds.set(label.id, "symptom");
          symptomParents.set(label.id, new Set(label.derived_from ?? []));
          symptomMetadata.set(label.id, {
            minimum_evidence_scope: label.minimum_evidence_scope,
            confusable_with: new Set(label.confusable_with ?? []),
            discriminating_tests: new Set(label.discriminating_tests ?? []),
            test_recipes: new Map(
              (label.test_recipes ?? []).map((recipe) => [
                recipe.recipe_id,
                recipe,
              ]),
            ),
          });
        }
      }
    }
    for (const item of taxonomy.causal_hypotheses ?? []) {
      ontologyKinds.set(item.id, "causal_hypothesis");
      causalContracts.set(item.id, item.support_contract ?? null);
    }
    for (const item of taxonomy.composite_tags ?? []) {
      ontologyKinds.set(item.id, "composite");
    }
    for (const item of taxonomy.uncertainty_markers ?? []) {
      ontologyKinds.set(item.id, "uncertainty");
    }
  }

  for (const finding of trace?.findings ?? []) {
    if (
      finding.label_kind !== "symptom" &&
      finding.taxonomy_test_results !== undefined
    ) {
      add(
        `finding "${finding.finding_id}" 不是 symptom，不得记录 taxonomy_test_results`,
      );
    }
    if (
      finding.label_kind !== "symptom" &&
      finding.neighboring_label_rebuttals !== undefined
    ) {
      add(
        `finding "${finding.finding_id}" 不是 symptom，不得记录 neighboring_label_rebuttals`,
      );
    }
    if (
      finding.label_kind !== "causal_hypothesis" &&
      finding.supporting_finding_ids !== undefined
    ) {
      add(
        `finding "${finding.finding_id}" 不是 causal_hypothesis，不得记录 supporting_finding_ids`,
      );
    }
    if (taxonomy) {
      const expectedKind = ontologyKinds.get(finding.label_id);
      if (!expectedKind) {
        add(
          `diagnostic_trace 使用了 taxonomy 中不存在的 label_id "${finding.label_id}"`,
        );
      } else if (finding.label_kind !== expectedKind) {
        add(
          `"${finding.label_id}" 的 label_kind 应为 ${expectedKind}，实际为 ${finding.label_kind}`,
        );
      }
    }
    for (const supportingId of finding.supporting_finding_ids ?? []) {
      if (!findingIds.has(supportingId)) {
        add(
          `因果假设 supporting_finding_ids 引用了不存在的 finding "${supportingId}"`,
        );
      }
    }
    if (
      taxonomy &&
      finding.label_kind === "symptom" &&
      finding.status === "present"
    ) {
      const metadata = symptomMetadata.get(finding.label_id);
      if (metadata) {
        const outputSupport = (finding.evidence ?? []).filter(
          (item) =>
            item.stance === "supports" &&
            validGeneratorOutputTurnIds.has(item.turn_id),
        );
        if (outputSupport.length === 0) {
          add(
            `症状 finding "${finding.finding_id}" 没有来自 assistant 输出 turn 的支持证据`,
          );
        }
        if (!scopeSatisfies(finding.scope, metadata.minimum_evidence_scope)) {
          add(
            `症状 finding "${finding.finding_id}" 的 scope ${finding.scope} 低于 taxonomy 要求的 ${metadata.minimum_evidence_scope}`,
          );
        }
        validateScopeAttestation(
          finding,
          turns,
          scenes,
          validGeneratorOutputTurnIds,
          add,
        );
        const rebuttalLabels = new Set(
          (finding.neighboring_label_rebuttals ?? []).map(
            (item) => item.label_id,
          ),
        );
        for (const confusableId of metadata.confusable_with) {
          if (!rebuttalLabels.has(confusableId)) {
            add(
              `症状 finding "${finding.finding_id}" 未检查 confusable_with "${confusableId}"`,
            );
          }
        }
        const unresolvedRequiredNeighbors = (
          finding.neighboring_label_rebuttals ?? []
        )
          .filter(
            (item) =>
              metadata.confusable_with.has(item.label_id) &&
              item.verdict === "uncertain_between",
          )
          .map((item) => item.label_id)
          .sort();
        if (unresolvedRequiredNeighbors.length > 0) {
          add(
            `症状 finding "${finding.finding_id}" 仍与冻结近邻无法区分，不得标为 present：${unresolvedRequiredNeighbors.join(", ")}`,
          );
        }
        const observedRecipeIds = new Set();
        for (const result of finding.taxonomy_test_results ?? []) {
          if (observedRecipeIds.has(result.recipe_id)) {
            add(
              `症状 finding "${finding.finding_id}" 重复执行 recipe_id "${result.recipe_id}"；同一 finding/recipe 只能有一个受绑定结果`,
            );
          }
          observedRecipeIds.add(result.recipe_id);
        }
        const recordedTests = new Set(
          (finding.taxonomy_test_results ?? [])
            .filter((item) => item.outcome === "passed")
            .map((item) => item.taxonomy_test),
        );
        const passedRecipeIds = new Set();
        for (const result of finding.taxonomy_test_results ?? []) {
          const test = result.taxonomy_test;
          if (!metadata.discriminating_tests.has(test)) {
            add(
              `症状 finding "${finding.finding_id}" 记录了不属于该 taxonomy label 的 discriminating_test`,
            );
          }
          const recipe = metadata.test_recipes.get(result.recipe_id);
          if (!recipe || recipe.taxonomy_test !== test) {
            add(
              `症状 finding "${finding.finding_id}" 的 taxonomy test 未引用该 label 冻结的结构化 recipe`,
            );
          } else if (result.outcome === "passed") {
            passedRecipeIds.add(result.recipe_id);
          }
          const ownedEvidenceIds = new Set(
            (finding.evidence ?? []).map((item) => item.evidence_id),
          );
          for (const evidenceId of result.evidence_ids ?? []) {
            const ownedEvidence = (finding.evidence ?? []).find(
              (item) => item.evidence_id === evidenceId,
            );
            if (!ownedEvidenceIds.has(evidenceId)) {
              add(
                `finding "${finding.finding_id}" 的 taxonomy test 引用了不属于本 finding 的 evidence_id "${evidenceId}"`,
              );
            } else if (ownedEvidence.stance !== "supports") {
              add(
                `finding "${finding.finding_id}" 的 taxonomy test 只能引用 supports evidence`,
              );
            }
          }
          validateTaxonomyTestExecution({
            trace,
            finding,
            result,
            turns,
            scenes,
            taxonomy,
            recipe,
            executionIds: taxonomyTestExecutionIds,
            add,
          });
        }
        if (passedRecipeIds.size === 0) {
          add(
            `症状 finding "${finding.finding_id}" 没有通过任何结构化 taxonomy test recipe，不得标为 present`,
          );
        }
        if (
          ![...metadata.discriminating_tests].some((test) =>
            recordedTests.has(test),
          )
        ) {
          add(
            `症状 finding "${finding.finding_id}" 未记录 taxonomy 中冻结的 discriminating_test`,
          );
        }
      }
    }
    for (const evidence of finding.evidence ?? []) {
      if (evidenceIds.has(evidence.evidence_id)) {
        add(`diagnostic_trace 重复 evidence_id "${evidence.evidence_id}"`);
      }
      evidenceIds.add(evidence.evidence_id);
      const turn = turns.get(evidence.turn_id);
      if (!turn) {
        add(
          `证据 "${evidence.evidence_id}" 引用了不存在的 turn "${evidence.turn_id}"`,
        );
        continue;
      }
      if (evidence.source_record_id !== trace.subject.record_id) {
        add(
          `证据 "${evidence.evidence_id}" 的 source_record_id 与 subject.record_id 不一致`,
        );
      }
      if (!evidence.span) {
        add(
          `证据 "${evidence.evidence_id}" 缺少可验证的 unicode_codepoint span`,
        );
      } else if (evidence.span.unit !== "unicode_codepoint") {
        add(
          `证据 "${evidence.evidence_id}" 的 span unit 当前不可重放；必须使用 unicode_codepoint`,
        );
      } else {
        const codepoints = [...turn.content];
        const { start, end } = evidence.span;
        const observed = codepoints.slice(start, end).join("");
        if (
          start >= end ||
          end > codepoints.length ||
          observed !== evidence.quote
        ) {
          add(
            `证据 "${evidence.evidence_id}" 的 span 与 quote/turn 内容不一致`,
          );
        }
      }
    }
    const rebuttalLabelsSeen = new Set();
    for (const rebuttal of finding.neighboring_label_rebuttals ?? []) {
      if (rebuttalLabelsSeen.has(rebuttal.label_id)) {
        add(
          `finding "${finding.finding_id}" 重复检查 neighboring label "${rebuttal.label_id}"`,
        );
      }
      rebuttalLabelsSeen.add(rebuttal.label_id);
      if (rebuttal.label_id === finding.label_id) {
        add(`finding "${finding.finding_id}" 不能把自身 label 作为 neighboring label`);
      }
      if (taxonomy && !ontologyKinds.has(rebuttal.label_id)) {
        add(
          `neighboring_label_rebuttals 使用了未知 label_id "${rebuttal.label_id}"`,
        );
      }
      if (
        rebuttal.verdict === "co_present"
      ) {
        const neighbor = findingById.get(rebuttal.neighbor_finding_id);
        if (
          !neighbor ||
          neighbor.finding_id === finding.finding_id ||
          neighbor.label_id !== rebuttal.label_id ||
          neighbor.status !== "present"
        ) {
          add(
            `finding "${finding.finding_id}" 的 co_present 必须指向匹配 label 的另一条 present finding`,
          );
        } else {
          const citedEvidence = (finding.evidence ?? []).filter(
            (item) =>
              item.stance === "supports" &&
              (rebuttal.evidence_ids ?? []).includes(item.evidence_id),
          );
          const neighborSupport = (neighbor.evidence ?? []).filter(
            (item) => item.stance === "supports",
          );
          if (
            !citedEvidence.some((left) =>
              neighborSupport.some((right) =>
                evidenceSpansOverlap(left, right),
              ),
            )
          ) {
            add(
              `finding "${finding.finding_id}" 的 co_present 邻居没有共享或重叠的支持证据`,
            );
          }
        }
      } else {
        const rebuttalSupport = (finding.evidence ?? []).filter(
          (evidence) =>
            evidence.stance === "supports" &&
            (rebuttal.evidence_ids ?? []).includes(evidence.evidence_id),
        );
        const contradictoryPresentNeighbor = [...findingById.values()].find(
          (candidate) =>
            candidate.finding_id !== finding.finding_id &&
            candidate.label_id === rebuttal.label_id &&
            candidate.status === "present" &&
            rebuttalSupport.some((left) =>
              (candidate.evidence ?? []).some(
                (right) =>
                  right.stance === "supports" &&
                  evidenceSpansOverlap(left, right),
              ),
            ),
        );
        if (contradictoryPresentNeighbor) {
          add(
            `finding "${finding.finding_id}" 不得把已有 present finding 的 label "${rebuttal.label_id}" 记为 ${rebuttal.verdict}；必须使用 co_present`,
          );
        }
      }
    }
  }

  for (const finding of trace?.findings ?? []) {
    if (
      finding.label_kind === "causal_hypothesis" &&
      finding.status === "present"
    ) {
      const supporting = (finding.supporting_finding_ids ?? [])
        .map((id) => findingById.get(id))
        .filter(Boolean);
      if (
        supporting.length < 2 ||
        supporting.some(
          (item) => item.label_kind !== "symptom" || item.status !== "present",
        )
      ) {
        add(
          `因果假设 finding "${finding.finding_id}" 必须由至少两个 present symptom finding 支撑`,
        );
      } else if (taxonomy) {
        validateCausalScopeAttestation(
          finding,
          supporting,
          turns,
          scenes,
          add,
        );
        const supportContract = causalContracts.get(finding.label_id);
        if (
          finding.status === "present" &&
          supportContract?.status !== "specified"
        ) {
          add(
            `因果假设 finding "${finding.finding_id}" 的 support_contract 尚未指定，不得标为 present`,
          );
        }
        const admissibleIds = new Set(
          supportContract?.admissible_symptom_ids ?? [],
        );
        const inadmissibleLabels = [
          ...new Set(
            supporting
              .map((item) => item.label_id)
              .filter((labelId) => {
                if (admissibleIds.has(labelId)) return false;
                if (supportContract?.match_mode !== "descendants_included") {
                  return true;
                }
                return ![...admissibleIds].some((ancestorId) =>
                  isAncestorLabel(ancestorId, labelId, symptomParents),
                );
              }),
          ),
        ];
        if (finding.status === "present" && inadmissibleLabels.length > 0) {
          add(
            `因果假设 finding "${finding.finding_id}" 使用了 support_contract 不接受的症状：${inadmissibleLabels.join(", ")}`,
          );
        }
        const minimumGroups =
          taxonomy.causal_support_policy?.minimum_independent_symptom_groups ??
          2;
        const independentGroups = countIndependentSupportGroups(
          supporting,
          symptomParents,
        );
        if (independentGroups < minimumGroups) {
          add(
            `因果假设 finding "${finding.finding_id}" 只有 ${independentGroups} 个独立症状证据组，至少需要 ${minimumGroups} 个；祖先/后代或共享证据不得重复计票`,
          );
        }
      }
    }
    const taxonomyResultByExecutionId = new Map(
      (finding.taxonomy_test_results ?? [])
        .filter((result) => result.execution?.execution_id)
        .map((result) => [result.execution.execution_id, result]),
    );
    const frozenConfusables =
      symptomMetadata.get(finding.label_id)?.confusable_with ?? new Set();
    for (const rebuttal of finding.neighboring_label_rebuttals ?? []) {
      const ownedEvidenceIds = new Set(
        (finding.evidence ?? []).map((item) => item.evidence_id),
      );
      const linkedResult = taxonomyResultByExecutionId.get(
        rebuttal.test_execution_id,
      );
      const linkedRecipe = symptomMetadata
        .get(finding.label_id)
        ?.test_recipes.get(linkedResult?.recipe_id);
      const linkedNeighborStatus = (
        linkedResult?.execution?.judgment?.neighbor_statuses_before ?? []
      ).find((item) => item.label_id === rebuttal.label_id)?.status;
      const expectedNeighborStatus = {
        rebutted: "absent",
        uncertain_between: "uncertain",
        co_present: "present",
      }[rebuttal.verdict];
      if (
        !linkedResult ||
        linkedResult.outcome !== "passed" ||
        linkedResult.taxonomy_test !== rebuttal.discriminating_test ||
        !linkedRecipe?.distinguishes_from?.includes(rebuttal.label_id) ||
        linkedNeighborStatus !== expectedNeighborStatus
      ) {
        add(
          `finding "${finding.finding_id}" 的 rebuttal 必须引用逐字匹配且 passed 的冻结 taxonomy test execution`,
        );
      }
      if (!frozenConfusables.has(rebuttal.label_id)) {
        add(
          `finding "${finding.finding_id}" 的 rebuttal 不得把未冻结为 confusable_with 的 label 当作边界证明`,
        );
      }
      for (const evidenceId of rebuttal.evidence_ids ?? []) {
        const ownedEvidence = (finding.evidence ?? []).find(
          (item) => item.evidence_id === evidenceId,
        );
        if (!ownedEvidenceIds.has(evidenceId)) {
          add(
            `finding "${finding.finding_id}" 的 rebuttal 引用了不属于本 finding 的 evidence_id "${evidenceId}"`,
          );
        } else if (ownedEvidence.stance !== "supports") {
          add(
            `finding "${finding.finding_id}" 的 rebuttal 只能引用 supports evidence`,
          );
        }
        if (
          linkedResult &&
          !(linkedResult.evidence_ids ?? []).includes(evidenceId)
        ) {
          add(
            `finding "${finding.finding_id}" 的 rebuttal evidence 未被其 taxonomy test execution 覆盖`,
          );
        }
      }
    }
  }
  return [...new Set(messages)].sort();
}

function validateSceneContractGrounding({
  scene,
  turns,
  outputTurns,
  contractCriticId,
  groundingIds,
  add,
}) {
  const expectedClausePaths = collectStringLeafPaths(scene.contract, "", new Set([
    "grounding",
    "source_turn_ids",
  ])).sort();
  const observedClausePaths = [];
  for (const grounding of scene.contract?.grounding ?? []) {
    if (groundingIds.has(grounding.grounding_id)) {
      add(`diagnostic_trace 重复 contract grounding_id "${grounding.grounding_id}"`);
    }
    groundingIds.add(grounding.grounding_id);
    observedClausePaths.push(...(grounding.clause_paths ?? []));
    const sourceTurn = turns.get(grounding.source_turn_id);
    if (
      !sourceTurn ||
      !(scene.contract?.source_turn_ids ?? []).includes(
        grounding.source_turn_id,
      )
    ) {
      add(
        `scene "${scene.scene_id}" 的 grounding 必须引用 contract.source_turn_ids 中的真实 turn`,
      );
      continue;
    }
    const codepoints = [...sourceTurn.content];
    const { start, end, unit } = grounding.span ?? {};
    if (
      unit !== "unicode_codepoint" ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      start >= end ||
      end > codepoints.length ||
      codepoints.slice(start, end).join("") !== grounding.quote
    ) {
      add(
        `scene "${scene.scene_id}" 的 contract grounding span/quote 无法从来源 turn 重放`,
      );
    }
    if (grounding.validated_by_actor_id !== contractCriticId) {
      add(
        `scene "${scene.scene_id}" 的 contract grounding 必须由声明的 contract_critic 验证`,
      );
    }
    const sourceAt = Date.parse(sourceTurn.created_at ?? "");
    const validatedAt = Date.parse(grounding.validated_at ?? "");
    if (
      !Number.isFinite(sourceAt) ||
      !Number.isFinite(validatedAt) ||
      validatedAt < sourceAt ||
      outputTurns.some(
        (turn) => validatedAt >= Date.parse(turn.created_at ?? ""),
      )
    ) {
      add(
        `scene "${scene.scene_id}" 的 contract grounding 必须在来源出现后、generator output 前完成`,
      );
    }
    for (const clausePath of grounding.clause_paths ?? []) {
      const clauseValue = readJsonPointer(scene.contract, clausePath);
      if (clauseValue === undefined) {
        add(
          `scene "${scene.scene_id}" 的 grounding 引用了不存在的 contract clause "${clausePath}"`,
        );
      }
    }
    if (
      grounding.derivation_kind === "verbatim" &&
      ((grounding.clause_paths ?? []).length !== 1 ||
        readJsonPointer(scene.contract, grounding.clause_paths[0]) !==
          grounding.quote)
    ) {
      add(
        `scene "${scene.scene_id}" 的 verbatim grounding 必须单独引用与 source quote 完全相同的 clause`,
      );
    }
  }
  observedClausePaths.sort();
  if (
    JSON.stringify(observedClausePaths) !==
    JSON.stringify(expectedClausePaths)
  ) {
    add(
      `scene "${scene.scene_id}" 的 contract grounding 必须不重不漏地覆盖每个字符串 clause`,
    );
  }
}

function collectStringLeafPaths(value, basePath, excludedRootKeys) {
  if (typeof value === "string") return [basePath];
  if (!value || typeof value !== "object") return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value).filter(
        ([key]) => basePath !== "" || !excludedRootKeys.has(key),
      );
  return entries.flatMap(([key, nested]) =>
    collectStringLeafPaths(
      nested,
      `${basePath}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`,
      excludedRootKeys,
    ),
  );
}

function validateTaxonomyTestExecution({
  trace,
  finding,
  result,
  turns,
  scenes,
  taxonomy,
  recipe,
  executionIds,
  add,
}) {
  const execution = result.execution;
  if (!execution) {
    add(
      `finding "${finding.finding_id}" 的 taxonomy test 缺少可重放 execution`,
    );
    return;
  }
  if (executionIds.has(execution.execution_id)) {
    add(`diagnostic_trace 重复 taxonomy test execution_id "${execution.execution_id}"`);
  }
  executionIds.add(execution.execution_id);

  const ownedEvidence = new Map(
    (finding.evidence ?? []).map((item) => [item.evidence_id, item]),
  );
  const inputTurnIds = new Set(execution.input_turn_ids ?? []);
  const targetTurn = turns.get(execution.intervention?.target_turn_id);
  if (!targetTurn || !inputTurnIds.has(targetTurn.turn_id)) {
    add(
      `finding "${finding.finding_id}" 的 taxonomy test target turn 必须存在且包含在 input_turn_ids`,
    );
    return;
  }
  const orderedSubjectTurns = Array.isArray(trace?.subject?.turns)
    ? trace.subject.turns
    : [];
  const targetTurnIndex = orderedSubjectTurns.findIndex(
    (turn) => turn.turn_id === targetTurn.turn_id,
  );
  const expectedInputTurnIds = orderedSubjectTurns
    .slice(0, targetTurnIndex + 1)
    .map((turn) => turn.turn_id);
  if (
    targetTurnIndex < 0 ||
    JSON.stringify(execution.input_turn_ids) !==
      JSON.stringify(expectedInputTurnIds)
  ) {
    add(
      `finding "${finding.finding_id}" 的 taxonomy test input_turn_ids 必须按原顺序精确覆盖 target 生成时的完整上下文`,
    );
  }
  if (
    !(trace?.subject?.generator_output_turn_ids ?? []).includes(
      targetTurn.turn_id,
    )
  ) {
    add(
      `finding "${finding.finding_id}" 的 taxonomy test target 必须是受绑定的 generator output turn`,
    );
  }
  for (const turnId of inputTurnIds) {
    if (!turns.has(turnId)) {
      add(
        `finding "${finding.finding_id}" 的 taxonomy test 引用了不存在的 input turn "${turnId}"`,
      );
    }
  }
  for (const evidenceId of result.evidence_ids ?? []) {
    const evidence = ownedEvidence.get(evidenceId);
    if (evidence && !inputTurnIds.has(evidence.turn_id)) {
      add(
        `finding "${finding.finding_id}" 的 taxonomy test input 未包含证据 "${evidenceId}" 所属 turn`,
      );
    }
  }

  const scene = scenes.get(targetTurn.scene_id);
  if (
    !scene ||
    execution.scene_contract_digest !== scene.contract_digest ||
    execution.scene_contract_digest !== sha256Json(scene.contract)
  ) {
    add(
      `finding "${finding.finding_id}" 的 taxonomy test 未绑定 target turn 的 scene contract`,
    );
  }
  for (const sourceTurnId of scene?.contract?.source_turn_ids ?? []) {
    if (!inputTurnIds.has(sourceTurnId)) {
      add(
        `finding "${finding.finding_id}" 的 taxonomy test input 未包含 scene contract source turn "${sourceTurnId}"`,
      );
    }
  }
  if (execution.intervention?.instruction !== result.taxonomy_test) {
    add(
      `finding "${finding.finding_id}" 的 taxonomy test intervention 未逐字绑定冻结测试`,
    );
  }
  if (execution.judge_actor_id !== trace?.actors?.test_judge?.id) {
    add(
      `finding "${finding.finding_id}" 的 taxonomy test judge 必须是独立声明且受来源约束的 test_judge`,
    );
  }
  const executedAt = Date.parse(execution.executed_at ?? "");
  const traceCreatedAt = Date.parse(trace?.provenance?.created_at ?? "");
  const inputTimes = [...inputTurnIds].map((turnId) =>
    Date.parse(turns.get(turnId)?.created_at ?? ""),
  );
  if (
    !Number.isFinite(executedAt) ||
    !Number.isFinite(traceCreatedAt) ||
    executedAt > traceCreatedAt ||
    inputTimes.some((time) => !Number.isFinite(time) || time > executedAt)
  ) {
    add(
      `finding "${finding.finding_id}" 的 taxonomy test executed_at 不在输入完成与 trace 封存之间`,
    );
  }

  const expectedInputDigest = computeTaxonomyTestInputDigest(
    trace,
    result,
    finding,
    taxonomy,
    recipe,
  );
  if (!expectedInputDigest || execution.input_digest !== expectedInputDigest) {
    add(
      `finding "${finding.finding_id}" 的 taxonomy test input_digest 无法由精确输入重算`,
    );
  }
  if (execution.output?.digest !== sha256Text(execution.output?.content ?? "")) {
    add(
      `finding "${finding.finding_id}" 的 taxonomy test output digest 与内容不一致`,
    );
  }

  const intervention = execution.intervention ?? {};
  const source = [...targetTurn.content];
  if (recipe) {
    if (
      execution.method !== recipe.method ||
      execution.judgment?.target_status_before !==
        recipe.expected_status_before ||
      execution.judgment?.target_status_after !== recipe.expected_status_after ||
      intervention.kind !== recipe.intervention_kind ||
      (recipe.replacement_policy === "empty" &&
        intervention.replacement_text !== "")
    ) {
      add(
        `finding "${finding.finding_id}" 的 taxonomy test execution 不符合冻结 recipe 的方法或状态转移`,
      );
    }
    const neighborStatuses = new Map();
    for (const item of execution.judgment?.neighbor_statuses_before ?? []) {
      if (neighborStatuses.has(item.label_id)) {
        add(
          `finding "${finding.finding_id}" 的 taxonomy test 重复记录 neighbor status "${item.label_id}"`,
        );
      }
      neighborStatuses.set(item.label_id, item.status);
    }
    const expectedNeighbors = [...(recipe.distinguishes_from ?? [])].sort();
    const observedNeighbors = [...neighborStatuses.keys()].sort();
    if (
      JSON.stringify(expectedNeighbors) !== JSON.stringify(observedNeighbors)
    ) {
      add(
        `finding "${finding.finding_id}" 的 taxonomy test neighbor_statuses_before 未精确覆盖 recipe.distinguishes_from`,
      );
    }
    const observedContractPaths = [
      ...new Set(
        (execution.judgment?.invariants ?? [])
          .filter((item) => item.source_kind === "scene_contract")
          .flatMap((item) => item.contract_paths ?? []),
      ),
    ].sort();
    const requiredContractPaths = [
      ...(recipe.required_contract_paths ?? []),
    ].sort();
    if (
      JSON.stringify(observedContractPaths) !==
      JSON.stringify(requiredContractPaths)
    ) {
      add(
        `finding "${finding.finding_id}" 的 taxonomy test contract paths 未精确匹配冻结 recipe`,
      );
    }
    if (recipe.span_binding === "exact_single_evidence") {
      const boundEvidence = (result.evidence_ids ?? [])
        .map((evidenceId) => ownedEvidence.get(evidenceId))
        .filter(Boolean);
      const span = intervention.span;
      if (
        boundEvidence.length !== 1 ||
        boundEvidence[0].stance !== recipe.target_evidence_stance ||
        boundEvidence[0].turn_id !== targetTurn.turn_id ||
        span?.unit !== boundEvidence[0].span?.unit ||
        span?.start !== boundEvidence[0].span?.start ||
        span?.end !== boundEvidence[0].span?.end
      ) {
        add(
          `finding "${finding.finding_id}" 的 taxonomy test intervention 必须精确绑定一条 supports evidence span`,
        );
      }
    } else if (recipe.span_binding === "none" && intervention.span !== undefined) {
      add(
        `finding "${finding.finding_id}" 的 taxonomy test recipe 不允许未声明的 span`,
      );
    }
  }
  if (execution.method === "deterministic_text_edit") {
    if (!['delete_span', 'replace_span'].includes(intervention.kind)) {
      add(
        `finding "${finding.finding_id}" 的 deterministic_text_edit 必须使用 delete_span 或 replace_span`,
      );
    }
    const { start, end, unit } = intervention.span ?? {};
    if (
      unit !== "unicode_codepoint" ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      start >= end ||
      end > source.length
    ) {
      add(
        `finding "${finding.finding_id}" 的 taxonomy test intervention span 不可重放`,
      );
    } else {
      const replacement = intervention.replacement_text ?? "";
      if (intervention.kind === "delete_span" && replacement !== "") {
        add(
          `finding "${finding.finding_id}" 的 delete_span replacement_text 必须为空`,
        );
      }
      const expectedOutput = [
        ...source.slice(0, start),
        ...[...replacement],
        ...source.slice(end),
      ].join("");
      if (execution.output?.content !== expectedOutput) {
        add(
          `finding "${finding.finding_id}" 的 taxonomy test output 不是 intervention 的确定性结果`,
        );
      }
      if (expectedOutput === targetTurn.content) {
        add(
          `finding "${finding.finding_id}" 的 taxonomy test intervention 没有产生实质文本变化`,
        );
      }
    }
  } else {
    if (
      intervention.kind !== "no_text_change" ||
      intervention.span !== undefined ||
      intervention.replacement_text !== "" ||
      execution.output?.content !== targetTurn.content
    ) {
      add(
        `finding "${finding.finding_id}" 的证据审计不得伪装成未记录的文本变换`,
      );
    }
  }

  for (const invariant of execution.judgment?.invariants ?? []) {
    if (recipe && invariant.source_kind !== recipe.invariant_source_kind) {
      add(
        `finding "${finding.finding_id}" 的 taxonomy test invariant 来源不符合冻结 recipe`,
      );
    }
    if (invariant.source_kind === "scene_contract") {
      if (
        (invariant.evidence_ids ?? []).length > 0 ||
        !(invariant.contract_paths?.length > 0)
      ) {
        add(
          `finding "${finding.finding_id}" 的 scene-contract invariant 必须只引用明确 contract paths`,
        );
      }
      for (const pointer of invariant.contract_paths ?? []) {
        if (readJsonPointer(scene?.contract, pointer) === undefined) {
          add(
            `finding "${finding.finding_id}" 的 taxonomy test invariant 引用了不存在的 contract path "${pointer}"`,
          );
        }
      }
    } else if (invariant.source_kind === "finding_evidence") {
      if (
        !(invariant.evidence_ids?.length > 0) ||
        (invariant.contract_paths ?? []).length > 0
      ) {
        add(
          `finding "${finding.finding_id}" 的 finding-evidence invariant 必须只引用 evidence_ids`,
        );
      }
      for (const evidenceId of invariant.evidence_ids ?? []) {
        const evidence = ownedEvidence.get(evidenceId);
        const editSpan = intervention.span;
        const removedByIntervention =
          evidence?.turn_id === targetTurn.turn_id &&
          editSpan?.unit === evidence?.span?.unit &&
          Math.max(editSpan?.start ?? 0, evidence?.span?.start ?? 0) <
            Math.min(editSpan?.end ?? 0, evidence?.span?.end ?? 0);
        if (!evidence || evidence.stance !== "supports" || removedByIntervention) {
          add(
            `finding "${finding.finding_id}" 的 taxonomy test invariant evidence 不属于未被干预删除的 supports evidence`,
          );
        }
      }
    }
  }
  if (result.outcome === "passed") {
    if (
      execution.judgment?.target_status_before !== "present" ||
      (execution.judgment?.invariants ?? []).some(
        (item) => item.status !== "passed",
      ) ||
      (execution.method === "deterministic_text_edit" &&
        execution.judgment?.target_status_after !== "absent") ||
      (execution.method !== "deterministic_text_edit" &&
        !["present", "not_applicable"].includes(
          execution.judgment?.target_status_after,
        ))
    ) {
      add(
        `finding "${finding.finding_id}" 的 passed taxonomy test 与结构化 judgment 不一致`,
      );
    }
  }
  const expectedExecutionDigest = computeTaxonomyTestExecutionDigest({
    finding,
    result,
    taxonomy,
    recipe,
  });
  if (execution.execution_digest !== expectedExecutionDigest) {
    add(
      `finding "${finding.finding_id}" 的 taxonomy test execution_digest 无法重算`,
    );
  }
}

function validateCausalScopeAttestation(
  finding,
  supportingFindings,
  turns,
  scenes,
  add,
) {
  const supportingEvidence = supportingFindings.flatMap((item) =>
    (item.evidence ?? []).filter((evidence) => evidence.stance === "supports"),
  );
  const turnIds = new Set(
    supportingEvidence
      .map((evidence) => evidence.turn_id)
      .filter((turnId) => turns.has(turnId)),
  );
  if (finding.scope === "conversation" && turnIds.size < 2) {
    add(
      `因果假设 finding "${finding.finding_id}" 声称 conversation scope，但支持症状未覆盖至少两个 turns`,
    );
  } else if (finding.scope === "cross_scene") {
    const sceneIds = new Set(
      [...turnIds]
        .map((turnId) => turns.get(turnId)?.scene_id)
        .filter(Boolean),
    );
    const contractDigests = new Set(
      [...sceneIds]
        .map((sceneId) => scenes.get(sceneId)?.contract_digest)
        .filter(Boolean),
    );
    if (sceneIds.size < 2 || contractDigests.size < 2) {
      add(
        `因果假设 finding "${finding.finding_id}" 声称 cross_scene scope，但支持症状未覆盖至少两个受绑定 scenes`,
      );
    }
  } else if (finding.scope === "model_profile") {
    add(
      `因果假设 finding "${finding.finding_id}" 的 model_profile scope 不能由单份 diagnostic_trace 证明`,
    );
  }
}

function readJsonPointer(value, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    return undefined;
  }
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce(
      (current, part) =>
        current !== null &&
        typeof current === "object" &&
        Object.hasOwn(current, part)
          ? current[part]
          : undefined,
      value,
    );
}

function countIndependentSupportGroups(findings, symptomParents) {
  const parents = findings.map((_, index) => index);
  const find = (index) => {
    if (parents[index] !== index) parents[index] = find(parents[index]);
    return parents[index];
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  for (let left = 0; left < findings.length; left += 1) {
    for (let right = left + 1; right < findings.length; right += 1) {
      const leftEvidence = (findings[left].evidence ?? []).filter(
        (evidence) => evidence.stance === "supports",
      );
      const rightEvidence = (findings[right].evidence ?? []).filter(
        (evidence) => evidence.stance === "supports",
      );
      const sharesEvidence = leftEvidence.some((leftItem) =>
        rightEvidence.some((rightItem) =>
          evidenceSpansOverlap(leftItem, rightItem),
        ),
      );
      const labelsRelatedByAncestry =
        findings[left].label_id === findings[right].label_id ||
        isAncestorLabel(
          findings[left].label_id,
          findings[right].label_id,
          symptomParents,
        ) ||
        isAncestorLabel(
          findings[right].label_id,
          findings[left].label_id,
          symptomParents,
        );
      if (sharesEvidence || labelsRelatedByAncestry) union(left, right);
    }
  }
  return new Set(findings.map((_, index) => find(index))).size;
}

function evidenceSpansOverlap(left, right) {
  return (
    left.source_record_id === right.source_record_id &&
    left.turn_id === right.turn_id &&
    left.span?.unit === right.span?.unit &&
    Number.isInteger(left.span?.start) &&
    Number.isInteger(left.span?.end) &&
    Number.isInteger(right.span?.start) &&
    Number.isInteger(right.span?.end) &&
    Math.max(left.span.start, right.span.start) <
      Math.min(left.span.end, right.span.end)
  );
}

function scopeSatisfies(observed, required) {
  const acceptedByRequirement = new Map([
    ["span", new Set(["span", "turn", "conversation", "cross_scene", "model_profile"])],
    ["turn", new Set(["turn", "conversation", "cross_scene", "model_profile"])],
    ["conversation", new Set(["conversation", "model_profile"])],
    ["cross_scene", new Set(["cross_scene", "model_profile"])],
    ["model_profile", new Set(["model_profile"])],
  ]);
  return acceptedByRequirement.get(required)?.has(observed) === true;
}

function validateScopeAttestation(
  finding,
  turns,
  scenes,
  generatorOutputTurnIds,
  add,
) {
  const supporting = (finding.evidence ?? []).filter(
    (item) =>
      item.stance === "supports" &&
      generatorOutputTurnIds.has(item.turn_id),
  );
  if (finding.scope === "conversation") {
    const turnIds = new Set(
      (finding.evidence ?? [])
        .map((item) => item.turn_id)
        .filter((turnId) => turns.has(turnId)),
    );
    if (turnIds.size < 2) {
      add(
        `症状 finding "${finding.finding_id}" 声称 conversation scope，但证据未覆盖至少两个 context turn`,
      );
    }
  } else if (finding.scope === "cross_scene") {
    const outputTurnIds = new Set(supporting.map((item) => item.turn_id));
    const sceneIds = new Set(
      supporting
        .map((item) => turns.get(item.turn_id)?.scene_id)
        .filter(Boolean),
    );
    const contractDigests = new Set(
      [...sceneIds]
        .map((sceneId) => scenes.get(sceneId)?.contract_digest)
        .filter(Boolean),
    );
    if (
      outputTurnIds.size < 2 ||
      sceneIds.size < 2 ||
      contractDigests.size < 2
    ) {
      add(
        `症状 finding "${finding.finding_id}" 声称 cross_scene scope，但支持证据未覆盖至少两个受绑定的 generator output scene contract`,
      );
    }
  } else if (finding.scope === "model_profile") {
    add(
      `症状 finding "${finding.finding_id}" 的 model_profile scope 不能由单份 diagnostic_trace 证明`,
    );
  }
}

function isAncestorLabel(ancestorId, descendantId, symptomParents) {
  const pending = [...(symptomParents.get(descendantId) ?? [])];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === ancestorId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(symptomParents.get(current) ?? []));
  }
  return false;
}
