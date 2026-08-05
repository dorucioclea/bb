import { describe, expect, it } from "vitest";
import { withStrictObjectSchemas } from "./ai-schema.js";

// Parity cases with the host-daemon original (codex-chatgpt-client.ts) — if
// these diverge, the daemon and gate would strictify the same bb schema
// differently and one upstream would reject it.
describe("withStrictObjectSchemas", () => {
  it("marks object schemas strict and requires every property", () => {
    expect(
      withStrictObjectSchemas({
        type: "object",
        properties: {
          title: { type: "string" },
          count: { type: "number" },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
        count: { type: "number" },
      },
      additionalProperties: false,
      required: ["title", "count"],
    });
  });

  it("recurses into nested objects, arrays, and union branches", () => {
    expect(
      withStrictObjectSchemas({
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" } } },
          },
        },
        anyOf: [{ type: "object", properties: {} }],
      }),
    ).toEqual({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" } },
            additionalProperties: false,
            required: ["id"],
          },
        },
      },
      anyOf: [
        {
          type: "object",
          properties: {},
          additionalProperties: false,
          required: [],
        },
      ],
      additionalProperties: false,
      required: ["items"],
    });
  });

  it("preserves an explicit additionalProperties value and non-object schemas", () => {
    expect(
      withStrictObjectSchemas({
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: true,
      }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: true,
      required: ["a"],
    });
    expect(withStrictObjectSchemas({ type: "string" })).toEqual({
      type: "string",
    });
    expect(withStrictObjectSchemas("keep")).toBe("keep");
  });
});
