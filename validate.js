#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validateMachineArtifacts } from "./lib/machine-artifact-validator.js";

export const REPOSITORY_ROOT = fileURLToPath(new URL(".", import.meta.url));

const LAYER_DOCUMENTS = {
  I: "layer-1-preconditions.md",
  II: "layer-2-semantic-reading.md",
  III: "layer-3-scene-preservation.md",
  IV: "layer-4-writing-intrusion.md",
  V: "layer-5-multi-turn.md"
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function collectSymptoms(taxonomy) {
  const symptoms = [];
  for (const layer of taxonomy?.layers ?? []) {
    for (const subcategory of layer?.subcategories ?? []) {
      for (const symptom of subcategory?.labels ?? []) {
        symptoms.push({
          ...symptom,
          layerId: layer.id,
          subcategoryId: subcategory.id
        });
      }
    }
  }
  return symptoms;
}

export function collectEntries(taxonomy) {
  return [
    ...collectSymptoms(taxonomy).map((item) => ({ ...item, kind: "symptom" })),
    ...(taxonomy?.causal_hypotheses ?? []).map((item) => ({ ...item, kind: "causal_hypothesis" })),
    ...(taxonomy?.composite_tags ?? []).map((item) => ({ ...item, kind: "composite" })),
    ...(taxonomy?.uncertainty_markers ?? []).map((item) => ({ ...item, kind: "uncertainty_marker" }))
  ];
}

function issue(rule, message) {
  return { rule, message };
}

function formatAjvError(error) {
  const location = error.instancePath || "/";
  return `${location} ${error.message}`;
}

function checkSchema(taxonomy, schema, errors) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(taxonomy)) {
    for (const schemaError of validate.errors ?? []) {
      errors.push(issue("R1", formatAjvError(schemaError)));
    }
  }
}

function checkCounts(taxonomy, errors) {
  const actual = {
    symptoms: collectSymptoms(taxonomy).length,
    causal_hypotheses: taxonomy?.causal_hypotheses?.length ?? 0,
    composites: taxonomy?.composite_tags?.length ?? 0,
    uncertainty_markers: taxonomy?.uncertainty_markers?.length ?? 0
  };

  for (const [kind, count] of Object.entries(actual)) {
    if (taxonomy?.item_counts?.[kind] !== count) {
      errors.push(issue("R2", `item_counts.${kind} 声明 ${taxonomy?.item_counts?.[kind]}，实际 ${count}`));
    }
  }

  const actualTotal = Object.values(actual).reduce((sum, count) => sum + count, 0);
  if (taxonomy?.total_items !== actualTotal) {
    errors.push(issue("R2", `total_items 声明 ${taxonomy?.total_items}，实际 ${actualTotal}`));
  }

  return { ...actual, total: actualTotal };
}

function checkUniqueIds(taxonomy, errors) {
  const seen = new Map();
  for (const entry of collectEntries(taxonomy)) {
    if (!entry.id) continue;
    if (seen.has(entry.id)) {
      errors.push(issue("R3", `ID "${entry.id}" 同时出现在 ${seen.get(entry.id)} 与 ${entry.kind}`));
    } else {
      seen.set(entry.id, entry.kind);
    }
  }

  const subcategories = new Set();
  for (const layer of taxonomy?.layers ?? []) {
    for (const subcategory of layer?.subcategories ?? []) {
      if (subcategories.has(subcategory.id)) {
        errors.push(issue("R3", `子类 ID "${subcategory.id}" 重复`));
      }
      subcategories.add(subcategory.id);
    }
  }
}

function checkDerivedGraph(taxonomy, errors) {
  const symptoms = collectSymptoms(taxonomy);
  const ids = new Set(symptoms.map((item) => item.id));
  const graph = new Map();

  for (const symptom of symptoms) {
    const parents = symptom.derived_from ?? [];
    graph.set(symptom.id, parents);
    for (const parent of parents) {
      if (!ids.has(parent)) {
        errors.push(issue("R4", `"${symptom.id}" 的 derived_from 引用了不存在的症状 "${parent}"`));
      }
      if (parent === symptom.id) {
        errors.push(issue("R4", `"${symptom.id}" 不能衍生自自身`));
      }
    }
  }

  const state = new Map();
  const stack = [];
  function visit(id) {
    const current = state.get(id) ?? 0;
    if (current === 2) return;
    if (current === 1) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id].join(" -> ");
      errors.push(issue("R4", `derived_from 出现循环：${cycle}`));
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const parent of graph.get(id) ?? []) {
      if (graph.has(parent)) visit(parent);
    }
    stack.pop();
    state.set(id, 2);
  }
  for (const id of graph.keys()) visit(id);
}

function checkLayerStructure(taxonomy, errors) {
  const layerIds = (taxonomy?.layers ?? []).map((layer) => layer.id);
  const expectedOrder = taxonomy?.diagnostic_order ?? [];
  if (JSON.stringify(layerIds) !== JSON.stringify(expectedOrder)) {
    errors.push(issue("R5", `layers 顺序 ${layerIds.join(" → ")} 与 diagnostic_order ${expectedOrder.join(" → ")} 不一致`));
  }

  for (const layer of taxonomy?.layers ?? []) {
    for (const subcategory of layer?.subcategories ?? []) {
      if (!subcategory.id?.startsWith(`${layer.id}-`)) {
        errors.push(issue("R5", `子类 "${subcategory.id}" 不属于 Layer ${layer.id}`));
      }
    }
  }
}

function checkDocumentation(taxonomy, markdowns, errors) {
  if (!markdowns) return;
  for (const layer of taxonomy?.layers ?? []) {
    const filename = LAYER_DOCUMENTS[layer.id];
    const content = markdowns[filename];
    if (!content) {
      errors.push(issue("R6", `缺少 Layer ${layer.id} 文档 ${filename}`));
      continue;
    }

    const documentedIds = new Set(
      [...content.matchAll(/^####\s+`([a-z][a-z0-9_]*)`/gm)].map((match) => match[1])
    );
    const expectedIds = new Set(
      layer.subcategories.flatMap((subcategory) => subcategory.labels.map((label) => label.id))
    );

    for (const id of expectedIds) {
      if (!documentedIds.has(id)) errors.push(issue("R6", `${filename} 缺少症状标题 \`${id}\``));
    }
    for (const id of documentedIds) {
      if (!expectedIds.has(id)) errors.push(issue("R6", `${filename} 出现 taxonomy.json 未定义的症状标题 \`${id}\``));
    }
    for (const subcategory of layer.subcategories) {
      const heading = new RegExp(`^###\\s+${subcategory.id.replace("-", "\\-")}\\b`, "m");
      if (!heading.test(content)) errors.push(issue("R6", `${filename} 缺少子类标题 ${subcategory.id}`));
    }
  }

  const crossLayer = markdowns["cross-layer.md"];
  if (!crossLayer) {
    errors.push(issue("R6", "缺少 cross-layer.md"));
    return;
  }
  const auxiliaryEntries = [
    ...(taxonomy?.causal_hypotheses ?? []),
    ...(taxonomy?.composite_tags ?? []),
    ...(taxonomy?.uncertainty_markers ?? [])
  ];
  const documentedAuxiliaryIds = [
    ...[...crossLayer.matchAll(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|/gm)].map((match) => match[1]),
    ...[...crossLayer.matchAll(/^#####\s+`([a-z][a-z0-9_]*)`/gm)].map((match) => match[1])
  ];
  const expectedAuxiliaryIds = new Set(auxiliaryEntries.map((entry) => entry.id));
  const seenAuxiliaryIds = new Set();
  for (const id of documentedAuxiliaryIds) {
    if (seenAuxiliaryIds.has(id)) errors.push(issue("R6", `cross-layer.md 重复定义条目 \`${id}\``));
    seenAuxiliaryIds.add(id);
    if (!expectedAuxiliaryIds.has(id)) errors.push(issue("R6", `cross-layer.md 定义了 taxonomy.json 中不存在的辅助条目 \`${id}\``));
  }
  for (const id of expectedAuxiliaryIds) {
    if (!seenAuxiliaryIds.has(id)) errors.push(issue("R6", `cross-layer.md 缺少规范条目 \`${id}\``));
  }
}

function checkCausalRanges(taxonomy, errors) {
  const order = taxonomy?.diagnostic_order ?? [];
  const validLayers = new Set(order);
  for (const hypothesis of taxonomy?.causal_hypotheses ?? []) {
    const parts = hypothesis.primary_layer?.split("-") ?? [];
    if (parts.some((part) => !validLayers.has(part))) {
      errors.push(issue("R7", `因果假设 "${hypothesis.id}" 引用了无效层级 "${hypothesis.primary_layer}"`));
      continue;
    }
    if (parts.length === 2 && order.indexOf(parts[0]) >= order.indexOf(parts[1])) {
      errors.push(issue("R7", `因果假设 "${hypothesis.id}" 的层级范围必须从前向后："${hypothesis.primary_layer}"`));
    }
  }
}

export function validateTaxonomy({ taxonomy, schema, markdowns = null }) {
  const errors = [];
  const warnings = [];
  checkSchema(taxonomy, schema, errors);
  const stats = checkCounts(taxonomy, errors);
  checkUniqueIds(taxonomy, errors);
  checkDerivedGraph(taxonomy, errors);
  checkLayerStructure(taxonomy, errors);
  checkDocumentation(taxonomy, markdowns, errors);
  checkCausalRanges(taxonomy, errors);
  return { errors, warnings, stats };
}

function loadMarkdowns(root) {
  const directory = join(root, "layers");
  return Object.fromEntries(
    readdirSync(directory)
      .filter((filename) => filename.endsWith(".md"))
      .map((filename) => [filename, readFileSync(join(directory, filename), "utf8")])
  );
}

export function validateRepository(root = REPOSITORY_ROOT) {
  const taxonomy = readJson(join(root, "taxonomy.json"));
  const schema = readJson(join(root, "taxonomy.schema.json"));
  const markdowns = loadMarkdowns(root);
  const taxonomyResult = validateTaxonomy({ taxonomy, schema, markdowns });
  const schemas = readdirSync(join(root, "schemas"))
    .filter((filename) => filename.endsWith(".schema.json"))
    .map((filename) => ({ filename, data: readJson(join(root, "schemas", filename)) }));
  const examples = readdirSync(join(root, "examples", "machine-only"))
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) => ({ filename, data: readJson(join(root, "examples", "machine-only", filename)) }));
  const machineResult = validateMachineArtifacts({
    schemas,
    examples,
    taxonomyVersion: taxonomy.taxonomy_version,
    taxonomy
  });
  return {
    errors: [...taxonomyResult.errors, ...machineResult.errors],
    warnings: [...taxonomyResult.warnings, ...machineResult.warnings],
    stats: { ...taxonomyResult.stats, machine_records: machineResult.recordCount }
  };
}

function printReport(result) {
  const { stats, errors, warnings } = result;
  console.log("CN Failure Atlas v2 validation");
  console.log(`  entries: ${stats.total} = ${stats.symptoms} symptoms + ${stats.causal_hypotheses} hypotheses + ${stats.composites} composite + ${stats.uncertainty_markers} uncertainty marker`);
  console.log(`  machine records: ${stats.machine_records} examples validated against linked schemas`);

  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of warnings) console.log(`  [${warning.rule}] ${warning.message}`);
  }
  if (errors.length > 0) {
    console.error("\nErrors:");
    for (const error of errors) console.error(`  [${error.rule}] ${error.message}`);
    console.error(`\nValidation failed with ${errors.length} error(s).`);
    return;
  }
  console.log("  ✓ ontology schema, semantic graph, docs, machine-record schemas, and cross-record links");
  console.log("\nValidation passed.");
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  try {
    const result = validateRepository();
    printReport(result);
    if (result.errors.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`Validation crashed while reading ${basename(error?.path ?? "repository data")}:`);
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
