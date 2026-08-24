import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  parseJsonWithUniqueKeys,
  sha256Json,
} from "../lib/content-integrity.js";

test("canonical JSON sorts object keys and preserves array order", () => {
  assert.equal(
    canonicalJson({ z: [3, 2, 1], a: { y: true, x: null } }),
    '{"a":{"x":null,"y":true},"z":[3,2,1]}',
  );
  assert.equal(
    sha256Json({ b: 2, a: 1 }),
    sha256Json({ a: 1, b: 2 }),
  );
});

test("I-JSON parsing rejects duplicate decoded object keys at any depth", () => {
  assert.throws(
    () => parseJsonWithUniqueKeys('{"a":1,"a":2}'),
    /duplicate JSON object key: a/,
  );
  assert.throws(
    () => parseJsonWithUniqueKeys('{"outer":{"a":1,"\\u0061":2}}'),
    /duplicate JSON object key: a/,
  );
  assert.deepEqual(parseJsonWithUniqueKeys('{"a":1,"nested":[{"a":2}]}'), {
    a: 1,
    nested: [{ a: 2 }],
  });
});

test("canonical JSON rejects values outside the RFC 8785 data model", () => {
  assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
  assert.throws(() => canonicalJson("\ud800"), /lone high surrogate/);
  assert.throws(() => canonicalJson(undefined), /cannot encode/);
});
