// Copy of `withStrictObjectSchemas` from
// apps/host-daemon/src/codex-chatgpt-client.ts — the worker cannot import
// daemon code. Keep the two in sync; extract a shared package only if a third
// consumer appears.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function asObject(value: JsonValue): { [key: string]: JsonValue } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value;
}

/**
 * OpenAI's json_schema strict mode requires every object schema to set
 * `additionalProperties: false` and list every property as required.
 */
export function withStrictObjectSchemas(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => withStrictObjectSchemas(item));
  }

  const object = asObject(value);
  if (!object) {
    return value;
  }

  const normalized: { [key: string]: JsonValue } = {};
  for (const [key, childValue] of Object.entries(object)) {
    normalized[key] = withStrictObjectSchemas(childValue);
  }
  if (
    normalized.type === "object" &&
    normalized.additionalProperties === undefined
  ) {
    normalized.additionalProperties = false;
  }
  if (normalized.type === "object") {
    normalized.required = Object.keys(asObject(normalized.properties) ?? {});
  }
  return normalized;
}
