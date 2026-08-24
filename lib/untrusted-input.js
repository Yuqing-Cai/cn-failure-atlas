import { types as utilTypes } from "node:util";

export const UNTRUSTED_STRUCTURE_LIMITS = Object.freeze({
  maxNodes: 20_000,
  maxDepth: 128,
  maxStringUnits: 1_000_000,
});

export const MAX_JSON_SOURCE_BYTES = 4_000_000;

export function inspectUntrustedStructure(
  root,
  {
    maxNodes = UNTRUSTED_STRUCTURE_LIMITS.maxNodes,
    maxDepth = UNTRUSTED_STRUCTURE_LIMITS.maxDepth,
    maxStringUnits = UNTRUSTED_STRUCTURE_LIMITS.maxStringUnits,
  } = {},
) {
  const activeAncestors = new WeakSet();
  const stack = [{ value: root, depth: 0, exiting: false }];
  let nodes = 0;
  let stringUnits = 0;

  const result = (pass, reason = null) => ({
    pass,
    reason,
    lone_surrogate: reason === "lone_surrogate",
    limit_exceeded: reason === "structural_limit",
    cycle_detected: reason === "cyclic_reference",
    invalid_json:
      !pass && reason !== "lone_surrogate" && reason !== "structural_limit",
    nodes,
    string_units: stringUnits,
  });

  const inspectString = (value) => {
    stringUnits += value.length;
    if (stringUnits > maxStringUnits) return "structural_limit";
    return stringHasLoneSurrogate(value) ? "lone_surrogate" : null;
  };

  try {
    while (stack.length > 0) {
      const { value, depth, exiting } = stack.pop();
      if (exiting) {
        activeAncestors.delete(value);
        continue;
      }
      nodes += 1;
      if (nodes > maxNodes || depth > maxDepth) {
        return result(false, "structural_limit");
      }

      if (value === null || typeof value === "boolean") continue;
      if (typeof value === "number") {
        if (!Number.isFinite(value)) return result(false, "non_finite_number");
        continue;
      }
      if (typeof value === "string") {
        const reason = inspectString(value);
        if (reason) return result(false, reason);
        continue;
      }
      if (typeof value !== "object") {
        return result(false, "unsupported_value_type");
      }

      if (activeAncestors.has(value)) {
        return result(false, "cyclic_reference");
      }

      // A Proxy can make every reflective operation below execute arbitrary
      // user code. It is not a plain JSON container even when its target is.
      if (utilTypes.isProxy(value)) return result(false, "non_plain_object");

      const isArray = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      if (
        isArray
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      ) {
        return result(false, "non_plain_object");
      }

      let ownKeys;
      if (isArray) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (
          !lengthDescriptor ||
          !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0
        ) {
          return result(false, "invalid_array_shape");
        }
        // Every array slot contributes at least one node. Fail before asking
        // the engine to materialize an enormous property-key list.
        if (lengthDescriptor.value > maxNodes - nodes) {
          return result(false, "structural_limit");
        }
      }
      ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length > maxNodes - nodes + (isArray ? 1 : 0)) {
        return result(false, "structural_limit");
      }

      const children = [];
      let arrayIndexCount = 0;
      for (const key of ownKeys) {
        if (typeof key !== "string") return result(false, "symbol_key");
        if (isArray && key === "length") continue;

        const keyReason = inspectString(key);
        if (keyReason) return result(false, keyReason);

        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          return result(false, "accessor_property");
        }
        if (!descriptor.enumerable) {
          return result(false, "non_enumerable_property");
        }

        if (isArray) {
          const index = canonicalArrayIndex(key);
          if (index === null || index >= value.length) {
            return result(false, "extra_array_property");
          }
          arrayIndexCount += 1;
        }
        children.push(descriptor.value);
      }

      if (isArray && arrayIndexCount !== value.length) {
        return result(false, "sparse_array");
      }

      activeAncestors.add(value);
      stack.push({ value, depth, exiting: true });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: children[index],
          depth: depth + 1,
          exiting: false,
        });
      }
    }
  } catch {
    return result(false, "inspection_error");
  }
  return result(true);
}

export function assertJsonSourceSize(byteLength, label = "JSON input") {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new TypeError(`${label} has an invalid byte length`);
  }
  if (byteLength > MAX_JSON_SOURCE_BYTES) {
    throw new RangeError(
      `${label} exceeds the ${MAX_JSON_SOURCE_BYTES}-byte input limit`,
    );
  }
}

export function describeStructureFailure(result, label = "input") {
  if (result?.lone_surrogate) {
    return `${label} contains a lone Unicode surrogate`;
  }
  if (result?.cycle_detected) {
    return `${label} contains a cyclic object reference`;
  }
  if (result?.reason === "accessor_property") {
    return `${label} contains an accessor property`;
  }
  if (result?.reason === "inspection_error") {
    return `${label} could not be safely inspected`;
  }
  if (result?.invalid_json) {
    return `${label} is not a plain JSON data value`;
  }
  return `${label} exceeds structural input limits`;
}

function canonicalArrayIndex(key) {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return null;
  const index = Number(key);
  if (!Number.isSafeInteger(index) || String(index) !== key) return null;
  return index;
}

function stringHasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
