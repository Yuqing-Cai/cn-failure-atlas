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
import { validateTaxonomySemantics } from "../lib/taxonomy-semantic-validator.js";

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

function inspectMutation(mutate) {
  const candidate = structuredClone(taxonomy);
  mutate(candidate);
  return {
    schema: validateTaxonomy({ taxonomy: candidate, schema }),
    semantics: validateTaxonomySemantics(candidate),
  };
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

test("schema-invalid taxonomy data fails closed before semantic traversal", () => {
  const result = validateMutation((candidate) => {
    candidate.layers[0].subcategories[0].labels[0].discriminating_tests = {
      malformed: true,
    };
  });
  assert.ok(result.errors.some((error) => error.rule === "R1"));
  assert.equal(result.stats.total, 0);
});

test("taxonomy reports specified and underspecified boundary tests honestly", () => {
  const symptoms = collectSymptoms(taxonomy);
  const specified = symptoms.filter(
    (symptom) => symptom.discriminating_test_status === "specified",
  );
  const underspecified = symptoms.filter(
    (symptom) => symptom.discriminating_test_status === "underspecified",
  );

  assert.equal(taxonomy.taxonomy_version, "2.0.0-alpha.2");
  assert.equal(taxonomy.updated_at, "2026-08-25");
  assert.equal(specified.length, 23);
  assert.equal(underspecified.length, 47);
  assert.ok(specified.every((symptom) => symptom.discriminating_tests.length > 0));
  assert.ok(underspecified.every((symptom) => symptom.discriminating_tests.length === 0));
  assert.ok(
    symptoms.every(
      (symptom) =>
        !symptom.discriminating_tests.includes(taxonomy.diagnostic_guardrail),
    ),
  );
});

test("boundary-test status and content cannot contradict each other", () => {
  const emptySpecified = inspectMutation((candidate) => {
    const symptom = candidate.layers
      .flatMap((layer) => layer.subcategories)
      .flatMap((subcategory) => subcategory.labels)
      .find((label) => label.discriminating_test_status === "specified");
    symptom.discriminating_tests = [];
  });
  assert.ok(emptySpecified.schema.errors.some((error) => error.rule === "R1"));
  assert.ok(
    emptySpecified.semantics.errors.some(
      (error) => error.rule === "R4" && error.message.includes("声明边界测试已指定"),
    ),
  );

  const populatedUnderspecified = inspectMutation((candidate) => {
    const symptom = candidate.layers
      .flatMap((layer) => layer.subcategories)
      .flatMap((subcategory) => subcategory.labels)
      .find((label) => label.discriminating_test_status === "underspecified");
    symptom.discriminating_tests = ["尚未冻结的占位测试"];
  });
  assert.ok(populatedUnderspecified.schema.errors.some((error) => error.rule === "R1"));
  assert.ok(
    populatedUnderspecified.semantics.errors.some(
      (error) => error.rule === "R4" && error.message.includes("仍待定义"),
    ),
  );
});

test("the global diagnostic guardrail cannot masquerade as a label-specific test", () => {
  const result = validateMutation((candidate) => {
    const symptom = candidate.layers
      .flatMap((layer) => layer.subcategories)
      .flatMap((subcategory) => subcategory.labels)
      .find((label) => label.discriminating_test_status === "specified");
    symptom.discriminating_tests.push(candidate.diagnostic_guardrail);
  });
  assert.ok(
    result.errors.some(
      (error) => error.rule === "R4" && error.message.includes("重复了全局"),
    ),
  );
});

test("underspecified symptoms cannot carry executable test recipes", () => {
  const result = validateMutation((candidate) => {
    const symptoms = candidate.layers
      .flatMap((layer) => layer.subcategories)
      .flatMap((subcategory) => subcategory.labels);
    const underspecified = symptoms.find(
      (label) => label.discriminating_test_status === "underspecified",
    );
    const executable = symptoms.find((label) => (label.test_recipes?.length ?? 0) > 0);
    underspecified.test_recipes = structuredClone(executable.test_recipes);
  });
  assert.ok(
    result.errors.some(
      (error) =>
        error.rule === "R4" && error.message.includes("结构化 recipe"),
    ),
  );
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
    const hypothesis = candidate.causal_hypotheses.find(
      (item) => item.support_contract.status === "specified",
    );
    hypothesis.support_contract.admissible_symptom_ids.push("missing_symptom");
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
