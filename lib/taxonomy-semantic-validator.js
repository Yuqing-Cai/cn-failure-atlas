export function validateTaxonomySemantics(taxonomy) {
  const errors = [];
  const add = (rule, message) => errors.push({ rule, message });
  const symptoms = [];
  const subcategoryIds = [];
  for (const layer of taxonomy?.layers ?? []) {
    for (const subcategory of layer?.subcategories ?? []) {
      subcategoryIds.push(subcategory.id);
      for (const label of subcategory?.labels ?? []) {
        symptoms.push({ ...label, layerId: layer.id });
      }
    }
  }
  const kinds = {
    symptoms: symptoms.length,
    causal_hypotheses: taxonomy?.causal_hypotheses?.length ?? 0,
    composites: taxonomy?.composite_tags?.length ?? 0,
    uncertainty_markers: taxonomy?.uncertainty_markers?.length ?? 0,
  };
  for (const [kind, count] of Object.entries(kinds)) {
    if (taxonomy?.item_counts?.[kind] !== count) {
      add("R2", `item_counts.${kind} 与实际条目数不一致`);
    }
  }
  const total = Object.values(kinds).reduce((sum, count) => sum + count, 0);
  if (taxonomy?.total_items !== total) add("R2", "total_items 与实际总数不一致");

  const entries = [
    ...symptoms.map((item) => ({ ...item, kind: "symptom" })),
    ...(taxonomy?.causal_hypotheses ?? []).map((item) => ({
      ...item,
      kind: "causal_hypothesis",
    })),
    ...(taxonomy?.composite_tags ?? []).map((item) => ({
      ...item,
      kind: "composite",
    })),
    ...(taxonomy?.uncertainty_markers ?? []).map((item) => ({
      ...item,
      kind: "uncertainty_marker",
    })),
  ];
  for (const id of duplicates(entries.map((item) => item.id))) {
    add("R3", `taxonomy entry id 重复: ${id}`);
  }
  for (const id of duplicates(subcategoryIds)) {
    add("R3", `taxonomy subcategory id 重复: ${id}`);
  }

  const symptomIds = new Set(symptoms.map((item) => item.id));
  const entryIds = new Set(entries.map((item) => item.id));
  const graph = new Map();
  for (const symptom of symptoms) {
    graph.set(symptom.id, symptom.derived_from ?? []);
    for (const parent of symptom.derived_from ?? []) {
      if (!symptomIds.has(parent)) {
        add("R4", `"${symptom.id}" 的 derived_from 引用了不存在的症状 "${parent}"`);
      }
      if (parent === symptom.id) {
        add("R4", `"${symptom.id}" 不能衍生自自身`);
      }
    }
    for (const neighbor of symptom.confusable_with ?? []) {
      if (!symptomIds.has(neighbor)) {
        add("R4", `"${symptom.id}" 的 confusable_with 引用了不存在的症状 "${neighbor}"`);
      }
      if (neighbor === symptom.id) {
        add("R4", `"${symptom.id}" 不能与自身混淆`);
      }
    }
    for (const relation of symptom.related_to ?? []) {
      if (!entryIds.has(relation.target_id)) {
        add("R4", `"${symptom.id}" 的 related_to 引用了不存在的条目 "${relation.target_id}"`);
      }
      if (relation.target_id === symptom.id) {
        add("R4", `"${symptom.id}" 的 related_to 不能指向自身`);
      }
    }
  }
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      add("R4", `derived_from 出现循环: ${id}`);
      return;
    }
    state.set(id, 1);
    for (const parent of graph.get(id) ?? []) {
      if (graph.has(parent)) visit(parent);
    }
    state.set(id, 2);
  };
  for (const id of graph.keys()) visit(id);

  const recipeIds = [];
  const executableSymptomIds = [];
  const diagnosticGuardrail = taxonomy?.diagnostic_guardrail;
  for (const symptom of symptoms) {
    const discriminatingTests = symptom.discriminating_tests ?? [];
    const tests = new Set(discriminatingTests);
    const confusables = new Set(symptom.confusable_with ?? []);
    const recipes = symptom.test_recipes ?? [];
    if (symptom.discriminating_test_status === "specified") {
      if (discriminatingTests.length === 0) {
        add("R4", `${symptom.id} 声明边界测试已指定，但 discriminating_tests 为空`);
      }
    } else if (symptom.discriminating_test_status === "underspecified") {
      if (discriminatingTests.length !== 0) {
        add("R4", `${symptom.id} 的边界测试仍待定义，discriminating_tests 必须为空`);
      }
    } else {
      add("R4", `${symptom.id} 缺少有效的 discriminating_test_status`);
    }
    if (
      typeof diagnosticGuardrail === "string" &&
      discriminatingTests.includes(diagnosticGuardrail)
    ) {
      add("R4", `${symptom.id} 重复了全局 diagnostic_guardrail`);
    }
    if (recipes.length > 0 && symptom.discriminating_test_status !== "specified") {
      add("R4", `${symptom.id} 有结构化 recipe，但标签特异边界测试尚未指定`);
    }
    if (recipes.length > 0) executableSymptomIds.push(symptom.id);
    const covered = new Set();
    for (const recipe of recipes) {
      recipeIds.push(recipe.recipe_id);
      if (!tests.has(recipe.taxonomy_test)) {
        add("R4", `${recipe.recipe_id} 未引用所属 label 的 discriminating_tests`);
      }
      for (const neighbor of recipe.distinguishes_from ?? []) {
        covered.add(neighbor);
        if (!confusables.has(neighbor) || !symptomIds.has(neighbor)) {
          add("R4", `${recipe.recipe_id} 引用了未冻结近邻 ${neighbor}`);
        }
      }
      if (
        recipe.method !== "deterministic_text_edit" ||
        recipe.intervention_kind !== "delete_span" ||
        recipe.replacement_policy !== "empty" ||
        recipe.target_evidence_stance !== "supports" ||
        recipe.span_binding !== "exact_single_evidence" ||
        recipe.expected_status_before !== "present" ||
        recipe.expected_status_after !== "absent" ||
        recipe.invariant_source_kind !== "scene_contract" ||
        !(recipe.required_contract_paths?.length > 0)
      ) {
        add("R4", `${recipe.recipe_id} 超出当前确定性执行器能力`);
      }
    }
    if (
      recipes.length > 0 &&
      JSON.stringify([...covered].sort()) !==
        JSON.stringify([...confusables].sort())
    ) {
      add("R4", `${symptom.id} 的 recipes 未精确覆盖 confusable_with`);
    }
  }
  for (const id of duplicates(recipeIds)) add("R4", `recipe_id 重复: ${id}`);
  if (
    JSON.stringify(executableSymptomIds.sort()) !==
    JSON.stringify(
      [...(taxonomy?.machine_execution_policy?.executable_symptom_ids ?? [])].sort(),
    )
  ) {
    add("R4", "machine_execution_policy 与实际 recipe 覆盖不一致");
  }

  const diagnosticOrder = taxonomy?.diagnostic_order ?? [];
  const layerIds = (taxonomy?.layers ?? []).map((layer) => layer.id);
  if (JSON.stringify(layerIds) !== JSON.stringify(diagnosticOrder)) {
    add("R5", "layers 与 diagnostic_order 顺序不一致");
  }
  for (const layer of taxonomy?.layers ?? []) {
    for (const subcategory of layer?.subcategories ?? []) {
      if (!subcategory.id?.startsWith(`${layer.id}-`)) {
        add("R5", `subcategory ${subcategory.id} 不属于 Layer ${layer.id}`);
      }
    }
  }
  const validLayers = new Set(diagnosticOrder);
  for (const hypothesis of taxonomy?.causal_hypotheses ?? []) {
    const parts = hypothesis.primary_layer?.split("-") ?? [];
    if (parts.some((part) => !validLayers.has(part))) {
      add("R7", `${hypothesis.id} 的 primary_layer 无效`);
    } else if (
      parts.length === 2 &&
      diagnosticOrder.indexOf(parts[0]) >= diagnosticOrder.indexOf(parts[1])
    ) {
      add("R7", `${hypothesis.id} 的 layer range 方向无效`);
    }
    for (const symptomId of
      hypothesis.support_contract?.admissible_symptom_ids ?? []) {
      if (!symptomIds.has(symptomId)) {
        add("R7", `因果假设 "${hypothesis.id}" 的 support_contract 引用了不存在的症状 "${symptomId}"`);
      }
    }
  }
  return { errors, stats: { ...kinds, total } };
}

function duplicates(values) {
  const seen = new Set();
  const duplicateValues = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value);
    else seen.add(value);
  }
  return [...duplicateValues].sort();
}
