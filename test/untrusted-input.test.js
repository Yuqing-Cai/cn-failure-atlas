import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePromotion } from "../lib/evolution-gate.js";
import {
  describeStructureFailure,
  inspectUntrustedStructure,
} from "../lib/untrusted-input.js";

test("accepts exactly JSON-shaped values, including shared acyclic subtrees", () => {
  const shared = { nested: [null, true, false, 0, -0, 1.5, "😀"] };
  const nullPrototype = Object.create(null);
  nullPrototype.value = "ok";
  const input = {
    first: shared,
    second: shared,
    null_prototype: nullPrototype,
  };

  const result = inspectUntrustedStructure(input);
  assert.equal(result.pass, true);
  assert.equal(result.reason, null);
  assert.equal(result.invalid_json, false);
});

test("rejects values outside the JSON data model without throwing", async (t) => {
  const cases = [
    ["undefined", undefined, "unsupported_value_type"],
    ["bigint", 1n, "unsupported_value_type"],
    ["symbol", Symbol("value"), "unsupported_value_type"],
    ["function", () => {}, "unsupported_value_type"],
    ["NaN", Number.NaN, "non_finite_number"],
    ["positive infinity", Number.POSITIVE_INFINITY, "non_finite_number"],
    ["negative infinity", Number.NEGATIVE_INFINITY, "non_finite_number"],
  ];

  for (const [name, value, reason] of cases) {
    await t.test(name, () => {
      let result;
      assert.doesNotThrow(() => {
        result = inspectUntrustedStructure(value);
      });
      assert.equal(result.pass, false);
      assert.equal(result.invalid_json, true);
      assert.equal(result.reason, reason);
    });
  }
});

test("rejects direct and indirect cycles while allowing non-cyclic aliasing", () => {
  const direct = {};
  direct.self = direct;

  const left = {};
  const right = { left };
  left.right = right;

  const arrayCycle = [];
  arrayCycle.push(arrayCycle);

  for (const value of [direct, left, arrayCycle]) {
    const result = inspectUntrustedStructure(value);
    assert.equal(result.pass, false);
    assert.equal(result.reason, "cyclic_reference");
    assert.equal(result.cycle_detected, true);
    assert.equal(result.limit_exceeded, false);
  }

  const shared = { value: 1 };
  assert.equal(inspectUntrustedStructure([shared, shared]).pass, true);
});

test("rejects accessors without invoking their getters", () => {
  let calls = 0;
  const ordinaryGetter = {};
  Object.defineProperty(ordinaryGetter, "value", {
    enumerable: true,
    get() {
      calls += 1;
      return 1;
    },
  });
  const throwingGetter = {};
  Object.defineProperty(throwingGetter, "value", {
    enumerable: true,
    get() {
      calls += 1;
      throw new Error("must not execute");
    },
  });

  for (const value of [ordinaryGetter, throwingGetter]) {
    let result;
    assert.doesNotThrow(() => {
      result = inspectUntrustedStructure(value);
    });
    assert.equal(result.pass, false);
    assert.equal(result.reason, "accessor_property");
  }
  assert.equal(calls, 0);
});

test("rejects proxies before executing reflection traps", () => {
  let trapCalls = 0;
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error("must not execute");
      },
      ownKeys() {
        trapCalls += 1;
        throw new Error("must not execute");
      },
      get() {
        trapCalls += 1;
        throw new Error("must not execute");
      },
    },
  );
  const { proxy: revokedProxy, revoke } = Proxy.revocable({}, {});
  revoke();

  for (const value of [proxy, revokedProxy]) {
    let result;
    assert.doesNotThrow(() => {
      result = inspectUntrustedStructure(value);
    });
    assert.equal(result.pass, false);
    assert.equal(result.reason, "non_plain_object");
  }
  assert.equal(trapCalls, 0);
});

test("rejects non-plain containers and unrepresented object state", () => {
  class RecordLike {
    constructor() {
      this.value = 1;
    }
  }

  const inherited = Object.create({ inherited: true });
  inherited.value = 1;
  const hidden = {};
  Object.defineProperty(hidden, "hidden", { value: 1 });
  const symbolKey = { value: 1 };
  symbolKey[Symbol("hidden")] = 2;

  const cases = [
    [new Date(0), "non_plain_object"],
    [new Map(), "non_plain_object"],
    [new Set(), "non_plain_object"],
    [/value/u, "non_plain_object"],
    [new Uint8Array([1]), "non_plain_object"],
    [new RecordLike(), "non_plain_object"],
    [inherited, "non_plain_object"],
    [hidden, "non_enumerable_property"],
    [symbolKey, "symbol_key"],
  ];

  for (const [value, reason] of cases) {
    const result = inspectUntrustedStructure(value);
    assert.equal(result.pass, false);
    assert.equal(result.reason, reason);
  }
});

test("arrays must be dense and contain only enumerable data indices", () => {
  const sparse = new Array(1);
  const accessor = [];
  Object.defineProperty(accessor, "0", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  accessor.length = 1;
  const extra = [1];
  extra.extra = 2;
  const symbolKey = [1];
  symbolKey[Symbol("hidden")] = 2;
  const hidden = [1];
  Object.defineProperty(hidden, "extra", { value: 2 });

  const cases = [
    [sparse, "sparse_array"],
    [accessor, "accessor_property"],
    [extra, "extra_array_property"],
    [symbolKey, "symbol_key"],
    [hidden, "non_enumerable_property"],
  ];

  for (const [value, reason] of cases) {
    const result = inspectUntrustedStructure(value);
    assert.equal(result.pass, false);
    assert.equal(result.reason, reason);
  }
});

test("applies structural limits and validates Unicode in keys and values", () => {
  const tooDeep = { next: { next: null } };
  assert.equal(
    inspectUntrustedStructure(tooDeep, { maxDepth: 1 }).reason,
    "structural_limit",
  );
  assert.equal(
    inspectUntrustedStructure([1, 2], { maxNodes: 2 }).reason,
    "structural_limit",
  );
  assert.equal(
    inspectUntrustedStructure("abc", { maxStringUnits: 2 }).reason,
    "structural_limit",
  );

  const badKey = {};
  badKey["\ud800"] = 1;
  const badKeyResult = inspectUntrustedStructure(badKey);
  assert.equal(badKeyResult.reason, "lone_surrogate");
  assert.match(
    describeStructureFailure(badKeyResult, "record"),
    /record contains a lone Unicode surrogate/u,
  );

  const badValueResult = inspectUntrustedStructure("\udc00");
  assert.equal(badValueResult.reason, "lone_surrogate");
  assert.equal(inspectUntrustedStructure("\ud83d\ude00").pass, true);
});

test("the promotion API fail-closes every untrusted root", () => {
  const cycle = {};
  cycle.self = cycle;
  const throwingProxy = new Proxy(
    {},
    {
      get() {
        throw new Error("must not execute");
      },
    },
  );

  const cases = [
    {
      name: "policy cycle",
      args: [cycle, {}],
      reasonCode: "INVALID_POLICY",
    },
    {
      name: "policy proxy",
      args: [throwingProxy, {}],
      reasonCode: "INVALID_POLICY",
    },
    {
      name: "verification run bigint",
      args: [{}, 1n],
      reasonCode: "INVALID_VERIFICATION_RUN",
    },
    {
      name: "verification run proxy",
      args: [{}, throwingProxy],
      reasonCode: "INVALID_VERIFICATION_RUN",
    },
    {
      name: "artifact bundle cycle",
      args: [{}, {}, cycle],
      reasonCode: "ARTIFACT_BUNDLE_INVALID",
    },
    {
      name: "trust root function",
      args: [{}, {}, null, () => {}],
      reasonCode: "POLICY_TRUST_ROOT_MISMATCH",
    },
    {
      name: "run receipt non-finite number",
      args: [{}, {}, null, null, Number.POSITIVE_INFINITY],
      reasonCode: "RUN_RECEIPT_INVALID",
    },
  ];

  for (const { name, args, reasonCode } of cases) {
    let decision;
    assert.doesNotThrow(() => {
      decision = evaluatePromotion(...args);
    }, name);
    assert.equal(decision.status, "inconclusive", name);
    assert.deepEqual(decision.reason_codes, [reasonCode], name);
  }
});
