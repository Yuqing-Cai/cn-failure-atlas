import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  REPOSITORY_ROOT,
  collectSymptoms,
  validateRepository,
  validateTaxonomy
} from "../validate.js";

const taxonomy = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "taxonomy.json"), "utf8"));
const schema = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "taxonomy.schema.json"), "utf8"));
const markdowns = Object.fromEntries(
  readdirSync(join(REPOSITORY_ROOT, "layers"))
    .filter((filename) => filename.endsWith(".md"))
    .map((filename) => [filename, readFileSync(join(REPOSITORY_ROOT, "layers", filename), "utf8")])
);

function validateMutation(mutate) {
  const candidate = structuredClone(taxonomy);
  mutate(candidate);
  return validateTaxonomy({ taxonomy: candidate, schema });
}

test("repository taxonomy and Markdown heading inventories are synchronized", () => {
  const result = validateRepository();
  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.total, 78);
  assert.equal(result.stats.symptoms, 70);
});

test("full JSON Schema rejects malformed label fields", () => {
  const result = validateMutation((candidate) => {
    candidate.layers[0].subcategories[0].labels[0].definition = 42;
    candidate.layers[0].subcategories[0].labels[0].invented_field = true;
  });
  assert.ok(result.errors.some((error) => error.rule === "R1" && error.message.includes("definition")));
  assert.ok(result.errors.some((error) => error.rule === "R1" && error.message.includes("additional properties")));
});

test("declared per-kind counts cannot drift from the ontology", () => {
  const result = validateMutation((candidate) => {
    candidate.item_counts.symptoms += 1;
    candidate.total_items += 1;
  });
  assert.ok(result.errors.some((error) => error.rule === "R2" && error.message.includes("symptoms")));
  assert.ok(result.errors.some((error) => error.rule === "R2" && error.message.includes("total_items")));
});

test("IDs are unique across epistemically different item kinds", () => {
  const result = validateMutation((candidate) => {
    candidate.causal_hypotheses[0].id = candidate.layers[0].subcategories[0].labels[0].id;
  });
  assert.ok(result.errors.some((error) => error.rule === "R3"));
});

test("derived_from must resolve and remain acyclic", () => {
  const result = validateMutation((candidate) => {
    const symptoms = collectSymptoms(candidate);
    symptoms[0].derived_from = [symptoms[1].id];
    symptoms[1].derived_from = [symptoms[0].id, "missing_symptom"];

    const first = candidate.layers[0].subcategories[0].labels[0];
    const second = candidate.layers[0].subcategories[0].labels[1];
    first.derived_from = symptoms[0].derived_from;
    second.derived_from = symptoms[1].derived_from;
  });
  assert.ok(result.errors.some((error) => error.rule === "R4" && error.message.includes("不存在")));
  assert.ok(result.errors.some((error) => error.rule === "R4" && error.message.includes("循环")));
});

test("confusable and related edges reject self-loops and unknown targets", () => {
  const result = validateMutation((candidate) => {
    const symptom = candidate.layers[0].subcategories[0].labels[0];
    symptom.confusable_with = [symptom.id, "missing_symptom"];
    symptom.related_to = [
      { target_id: symptom.id, relation_type: "same_domain_as" },
      { target_id: "missing_entry", relation_type: "contrasts_with" },
    ];
  });
  assert.ok(result.errors.some((error) => error.rule === "R4" && error.message.includes("与自身混淆")));
  assert.ok(result.errors.some((error) => error.rule === "R4" && error.message.includes("不存在的症状")));
  assert.ok(result.errors.some((error) => error.rule === "R4" && error.message.includes("不能指向自身")));
  assert.ok(result.errors.some((error) => error.rule === "R4" && error.message.includes("不存在的条目")));
});

test("diagnostic layer order is executable data, not decoration", () => {
  const result = validateMutation((candidate) => {
    [candidate.layers[0], candidate.layers[1]] = [candidate.layers[1], candidate.layers[0]];
  });
  assert.ok(result.errors.some((error) => error.rule === "R5"));
});

test("causal layer ranges must move forward through diagnostic order", () => {
  const result = validateMutation((candidate) => {
    candidate.causal_hypotheses[0].primary_layer = "V-III";
  });
  assert.ok(result.errors.some((error) => error.rule === "R7"));
});

test("causal support contracts cannot name unknown symptoms", () => {
  const result = validateMutation((candidate) => {
    candidate.causal_hypotheses[0].support_contract.admissible_symptom_ids.push(
      "missing_symptom",
    );
  });
  assert.ok(
    result.errors.some(
      (error) => error.rule === "R7" && error.message.includes("不存在的症状"),
    ),
  );
});

test("cross-layer docs reject stale or duplicated canonical entries", () => {
  const candidateMarkdowns = structuredClone(markdowns);
  candidateMarkdowns["cross-layer.md"] += "\n| `obsolete_auxiliary_item` | III | stale |\n";
  candidateMarkdowns["cross-layer.md"] += "\n##### `supportive_but_wrong`（重复）\n";
  const result = validateTaxonomy({ taxonomy, schema, markdowns: candidateMarkdowns });
  assert.ok(result.errors.some((error) => error.rule === "R6" && error.message.includes("不存在")));
  assert.ok(result.errors.some((error) => error.rule === "R6" && error.message.includes("重复")));
});
