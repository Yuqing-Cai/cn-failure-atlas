import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        assertValidUnicode(key);
        return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
      })
      .join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("RFC 8785 canonical JSON does not permit non-finite numbers");
  }
  if (typeof value === "string") assertValidUnicode(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError(`RFC 8785 canonical JSON cannot encode ${typeof value}`);
  }
  return serialized;
}

export function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Json(value) {
  return sha256Text(canonicalJson(value));
}

export function digestMatchesText(value, claimedDigest) {
  return typeof value === "string" && sha256Text(value) === claimedDigest;
}

export function parseJsonWithUniqueKeys(source) {
  let index = 0;
  const whitespace = /[\u0009\u000a\u000d\u0020]/;
  const skipWhitespace = () => {
    while (whitespace.test(source[index] ?? "")) index += 1;
  };
  const parseStringToken = () => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      if (!escaped && character === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
      index += 1;
    }
    throw new SyntaxError("unterminated JSON string");
  };
  const parseValue = () => {
    skipWhitespace();
    if (source[index] === "{") return parseObject();
    if (source[index] === "[") return parseArray();
    if (source[index] === '"') {
      parseStringToken();
      return;
    }
    const start = index;
    while (
      index < source.length &&
      !/[\u0009\u000a\u000d\u0020,\]}]/.test(source[index])
    ) {
      index += 1;
    }
    if (start === index) throw new SyntaxError("expected JSON value");
    JSON.parse(source.slice(start, index));
  };
  const parseObject = () => {
    const keys = new Set();
    index += 1;
    skipWhitespace();
    if (source[index] === "}") {
      index += 1;
      return;
    }
    while (index < source.length) {
      skipWhitespace();
      if (source[index] !== '"') throw new SyntaxError("expected object key");
      const key = parseStringToken();
      if (keys.has(key)) {
        throw new SyntaxError(`duplicate JSON object key: ${key}`);
      }
      keys.add(key);
      skipWhitespace();
      if (source[index] !== ":") throw new SyntaxError("expected colon");
      index += 1;
      parseValue();
      skipWhitespace();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      if (source[index] !== ",") throw new SyntaxError("expected comma");
      index += 1;
    }
    throw new SyntaxError("unterminated JSON object");
  };
  const parseArray = () => {
    index += 1;
    skipWhitespace();
    if (source[index] === "]") {
      index += 1;
      return;
    }
    while (index < source.length) {
      parseValue();
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      if (source[index] !== ",") throw new SyntaxError("expected comma");
      index += 1;
    }
    throw new SyntaxError("unterminated JSON array");
  };

  parseValue();
  skipWhitespace();
  if (index !== source.length) throw new SyntaxError("unexpected trailing JSON data");
  return JSON.parse(source);
}

function assertValidUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("RFC 8785 canonical JSON rejects lone high surrogates");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("RFC 8785 canonical JSON rejects lone low surrogates");
    }
  }
}
