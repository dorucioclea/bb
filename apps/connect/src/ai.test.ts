import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AI_DAILY_BUDGET_MICROUSD,
  AI_INFERENCE_MAX_PROMPT_BYTES,
  aiUsage,
  machine,
  schema,
  server,
  user,
} from "@bb/connect-db";

import {
  estimateInferenceCostMicroUsd,
  estimateTranscriptionCostMicroUsd,
  processAiInference,
  processAiTranscription,
  refundAiUsage,
  reserveAiUsage,
  secondsToUtcMidnight,
  utcDayKey,
} from "./ai.js";

// Real in-memory SQLite (never mock the DB). Same harness as servers.test.ts.
const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../packages/connect-db/migrations", import.meta.url),
);

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith(".sql")) continue;
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  db = drizzle(sqlite, { schema });
});

afterEach(() => {
  sqlite.close();
});

const now = new Date("2026-08-05T18:00:00.000Z");

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function seedUser(id: string): void {
  db.insert(user)
    .values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

// verifyServerCredential keeps a 20s isolate cache keyed by the plaintext, so
// every test seeds a unique credential.
let credentialCounter = 0;
async function seedPairedServer(
  userId: string,
  over: { revokedAt?: Date | null } = {},
): Promise<string> {
  credentialCounter += 1;
  const credential = `bbcred_test-${credentialCounter}-${Math.floor(now.getTime() / 1000)}`;
  db.insert(server)
    .values({
      id: `srv-${credentialCounter}`,
      userId,
      name: `srv-${credentialCounter}`,
      subdomain: `handle-${credentialCounter}`,
      credentialHash: await sha256Hex(credential),
      revokedAt: over.revokedAt ?? null,
      createdAt: now,
    })
    .run();
  return credential;
}

async function seedMachine(userId: string): Promise<string> {
  credentialCounter += 1;
  const credential = `bbcm_test-${credentialCounter}`;
  db.insert(machine)
    .values({
      id: `mach-${credentialCounter}`,
      userId,
      credentialHash: await sha256Hex(credential),
      createdAt: now,
    })
    .run();
  return credential;
}

function usageCost(userId: string): number | null {
  const row = db
    .select({ costMicroUsd: aiUsage.costMicroUsd })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.userId, userId),
        eq(aiUsage.day, utcDayKey(now.getTime())),
      ),
    )
    .get();
  return row?.costMicroUsd ?? null;
}

function setUsageCost(userId: string, costMicroUsd: number): void {
  db.insert(aiUsage)
    .values({ userId, day: utcDayKey(now.getTime()), costMicroUsd })
    .onConflictDoUpdate({
      target: [aiUsage.userId, aiUsage.day],
      set: { costMicroUsd },
    })
    .run();
}

const RESULT_VALUE = { title: "Fix login flow" };

function responsesPayload(outputText: string): unknown {
  return {
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: outputText }],
      },
    ],
  };
}

interface RecordedFetch {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  respond: (url: string, init?: RequestInit) => Response | Error,
  recorded: RecordedFetch[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    recorded.push({ url, init });
    const result = respond(url, init);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
}

const okInferenceFetch = () =>
  fakeFetch(() => Response.json(responsesPayload(JSON.stringify(RESULT_VALUE))));

function inferenceRequest(over: {
  credential?: string;
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
}): Request {
  return new Request("https://sawyer.getbb.app/api/connect/ai/inference", {
    method: over.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(over.credential ? { "x-bb-connect-machine": over.credential } : {}),
      ...over.headers,
    },
    body:
      over.method === "GET"
        ? undefined
        : JSON.stringify(
            over.body ?? {
              prompt: "Summarize this thread",
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
              },
            },
          ),
  });
}

function transcriptionRequest(over: {
  credential?: string;
  file?: File | null;
  prompt?: string;
  extraField?: string;
}): Request {
  const form = new FormData();
  if (over.file !== null) {
    form.set(
      "file",
      over.file ??
        new File(["audio-bytes"], "recording.webm", { type: "audio/webm" }),
    );
  }
  if (over.prompt !== undefined) form.set("prompt", over.prompt);
  if (over.extraField !== undefined) form.set("extra", over.extraField);
  return new Request("https://sawyer.getbb.app/api/connect/ai/transcription", {
    method: "POST",
    headers: over.credential
      ? { "x-bb-connect-machine": over.credential }
      : {},
    body: form,
  });
}

function deps(fetchImpl: typeof fetch): Parameters<typeof processAiInference>[1] {
  return {
    db,
    openAiApiKey: "sk-test",
    fetchImpl,
    now: now.getTime(),
  };
}

describe("auth", () => {
  it("accepts a paired server tunnel credential and meters the cost", async () => {
    seedUser("acct-a");
    const credential = await seedPairedServer("acct-a");
    const response = await processAiInference(
      inferenceRequest({ credential }),
      deps(okInferenceFetch()),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ value: RESULT_VALUE });
    expect(usageCost("acct-a")).toBe(
      estimateInferenceCostMicroUsd(
        new TextEncoder().encode("Summarize this thread").length,
      ),
    );
  });

  it("accepts a machine credential", async () => {
    seedUser("acct-a");
    const credential = await seedMachine("acct-a");
    const response = await processAiInference(
      inferenceRequest({ credential }),
      deps(okInferenceFetch()),
    );
    expect(response.status).toBe(200);
  });

  it("rejects unknown and revoked credentials", async () => {
    seedUser("acct-a");
    const revoked = await seedPairedServer("acct-a", { revokedAt: now });
    for (const credential of ["bbcred_unknown-cred", revoked]) {
      const response = await processAiInference(
        inferenceRequest({ credential }),
        deps(okInferenceFetch()),
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "not_authorized",
      });
    }
    expect(usageCost("acct-a")).toBeNull();
  });

  it("never authenticates via cookies — header only", async () => {
    seedUser("acct-a");
    const response = await processAiInference(
      inferenceRequest({
        headers: { cookie: "__Secure-better-auth.session_token=whatever" },
      }),
      deps(okInferenceFetch()),
    );
    expect(response.status).toBe(401);
  });
});

describe("budget", () => {
  it("estimates are monotone in request size", () => {
    expect(estimateInferenceCostMicroUsd(64 * 1024)).toBeGreaterThan(
      estimateInferenceCostMicroUsd(300),
    );
    expect(estimateTranscriptionCostMicroUsd(25 * 1024 * 1024)).toBeGreaterThan(
      estimateTranscriptionCostMicroUsd(64 * 1024),
    );
    // Sanity: worst-case single calls stay well inside the daily budget.
    expect(estimateInferenceCostMicroUsd(64 * 1024)).toBeLessThan(
      AI_DAILY_BUDGET_MICROUSD / 100,
    );
    expect(estimateTranscriptionCostMicroUsd(25 * 1024 * 1024)).toBeLessThan(
      AI_DAILY_BUDGET_MICROUSD,
    );
  });

  it("reserves atomically up to the budget boundary", async () => {
    seedUser("acct-a");
    expect(
      await reserveAiUsage(
        db,
        "acct-a",
        AI_DAILY_BUDGET_MICROUSD - 10,
        now.getTime(),
      ),
    ).toBe(true);
    // Crossing the boundary is refused; landing exactly on it is allowed.
    expect(await reserveAiUsage(db, "acct-a", 11, now.getTime())).toBe(false);
    expect(await reserveAiUsage(db, "acct-a", 10, now.getTime())).toBe(true);
    expect(usageCost("acct-a")).toBe(AI_DAILY_BUDGET_MICROUSD);
  });

  it("shares one budget across inference and transcription and resets by UTC day", async () => {
    seedUser("acct-a");
    const credential = await seedPairedServer("acct-a");
    setUsageCost("acct-a", AI_DAILY_BUDGET_MICROUSD);

    const inference = await processAiInference(
      inferenceRequest({ credential }),
      deps(okInferenceFetch()),
    );
    expect(inference.status).toBe(429);
    const transcription = await processAiTranscription(
      transcriptionRequest({ credential }),
      deps(okInferenceFetch()),
    );
    expect(transcription.status).toBe(429);
    // 18:00Z → six hours to UTC midnight.
    expect(inference.headers.get("retry-after")).toBe(String(6 * 3600));
    await expect(inference.clone().json()).resolves.toEqual({
      error: "quota_exhausted",
      retryAfterSeconds: 6 * 3600,
    });

    const nextDay = now.getTime() + 24 * 3600 * 1000;
    expect(await reserveAiUsage(db, "acct-a", 100, nextDay)).toBe(true);
  });

  it("refunds never drop below zero", async () => {
    seedUser("acct-a");
    await reserveAiUsage(db, "acct-a", 500, now.getTime());
    await refundAiUsage(db, "acct-a", 300, now.getTime());
    await refundAiUsage(db, "acct-a", 300, now.getTime());
    expect(usageCost("acct-a")).toBe(0);
  });

  it("computes seconds to UTC midnight", () => {
    expect(secondsToUtcMidnight(Date.parse("2026-08-05T23:59:59.000Z"))).toBe(1);
    expect(secondsToUtcMidnight(Date.parse("2026-08-05T00:00:00.000Z"))).toBe(
      24 * 3600,
    );
  });
});

describe("inference validation", () => {
  it("rejects malformed bodies and non-object schemas", async () => {
    seedUser("acct-a");
    const credential = await seedPairedServer("acct-a");
    const cases: unknown[] = [
      { prompt: "", schema: { type: "object" } },
      { prompt: 42, schema: { type: "object" } },
      { prompt: "hi" },
      { prompt: "hi", schema: { type: "string" } },
      { prompt: "hi", schema: ["not-an-object"] },
    ];
    for (const body of cases) {
      const response = await processAiInference(
        inferenceRequest({ credential, body }),
        deps(okInferenceFetch()),
      );
      expect(response.status).toBe(400);
    }
    expect(usageCost("acct-a")).toBeNull();
  });

  it("rejects oversized prompts before reserving budget", async () => {
    seedUser("acct-a");
    const credential = await seedPairedServer("acct-a");
    const response = await processAiInference(
      inferenceRequest({
        credential,
        body: {
          prompt: "x".repeat(AI_INFERENCE_MAX_PROMPT_BYTES + 1),
          schema: { type: "object" },
        },
      }),
      deps(okInferenceFetch()),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "too_large" });
    expect(usageCost("acct-a")).toBeNull();
  });

  it("refuses oversized declared bodies via content-length before buffering", async () => {
    seedUser("acct-a");
    const credential = await seedPairedServer("acct-a");
    const request = new Request(
      "https://sawyer.getbb.app/api/connect/ai/inference",
      {
        method: "POST",
        headers: {
          "x-bb-connect-machine": credential,
          "content-length": String(500 * 1024 * 1024),
        },
        body: JSON.stringify({ prompt: "hi", schema: { type: "object" } }),
      },
    );
    const response = await processAiInference(request, deps(okInferenceFetch()));
    expect(response.status).toBe(413);
  });

  it("rejects non-POST methods", async () => {
    const response = await processAiInference(
      inferenceRequest({ method: "GET" }),
      deps(okInferenceFetch()),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("inference upstream", () => {
  async function failingUpstream(
    respond: (url: string, init?: RequestInit) => Response | Error,
  ): Promise<Response> {
    seedUser("acct-a");
    const credential = await seedPairedServer("acct-a");
    return processAiInference(
      inferenceRequest({ credential }),
      deps(fakeFetch(respond)),
    );
  }

  it("maps OpenAI 4xx to 422 and refunds", async () => {
    const response = await failingUpstream(() =>
      Response.json({ error: { message: "schema rejected" } }, { status: 400 }),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "upstream_rejected",
    });
    expect(usageCost("acct-a")).toBe(0);
  });

  it("maps OpenAI 5xx to 502 and refunds", async () => {
    const response = await failingUpstream(
      () => new Response("oops", { status: 503 }),
    );
    expect(response.status).toBe(502);
    expect(usageCost("acct-a")).toBe(0);
  });

  it("maps our own broken key (upstream 401) to 502, not 422", async () => {
    const response = await failingUpstream(
      () => new Response("bad key", { status: 401 }),
    );
    expect(response.status).toBe(502);
  });

  it("maps timeouts to 504 and refunds", async () => {
    const response = await failingUpstream(
      () => new DOMException("timed out", "TimeoutError"),
    );
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: "upstream_timeout",
    });
    expect(usageCost("acct-a")).toBe(0);
  });

  it("maps unparseable structured output to 502 and refunds", async () => {
    const response = await failingUpstream(() =>
      Response.json(responsesPayload("not json {")),
    );
    expect(response.status).toBe(502);
    expect(usageCost("acct-a")).toBe(0);
  });

  it("prefers output_text when present", async () => {
    const response = await failingUpstream(() =>
      Response.json({ output_text: JSON.stringify(RESULT_VALUE) }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ value: RESULT_VALUE });
  });

  it("sends a strictified schema and never forwards client headers", async () => {
    seedUser("acct-a");
    const credential = await seedPairedServer("acct-a");
    const recorded: RecordedFetch[] = [];
    const response = await processAiInference(
      inferenceRequest({
        credential,
        headers: { "x-forwarded-for": "1.2.3.4" },
      }),
      deps(
        fakeFetch(
          () => Response.json(responsesPayload(JSON.stringify(RESULT_VALUE))),
          recorded,
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe("https://api.openai.com/v1/responses");
    const headers = recorded[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(Object.keys(headers)).not.toContain("x-bb-connect-machine");
    expect(Object.keys(headers)).not.toContain("x-forwarded-for");
    const sent = JSON.parse(String(recorded[0].init?.body));
    expect(sent.model).toBe("gpt-5.6-luna");
    expect(sent.store).toBe(false);
    expect(sent.stream).toBe(false);
    expect(sent.text.format).toMatchObject({
      type: "json_schema",
      name: "result",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
      },
    });
  });
});

describe("transcription", () => {
  it("proxies multipart and returns the text", async () => {
    seedUser("acct-a");
    const credential = await seedPairedServer("acct-a");
    const recorded: RecordedFetch[] = [];
    const response = await processAiTranscription(
      transcriptionRequest({ credential, prompt: "context before cursor" }),
      deps(fakeFetch(() => Response.json({ text: "hello world" }), recorded)),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: "hello world" });
    expect(usageCost("acct-a")).toBe(
      estimateTranscriptionCostMicroUsd("audio-bytes".length),
    );

    expect(recorded[0].url).toBe(
      "https://api.openai.com/v1/audio/transcriptions",
    );
    const form = recorded[0].init?.body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("prompt")).toBe("context before cursor");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("extra")).toBeNull();
    const sentFile = form.get("file") as unknown as File;
    expect(sentFile.name).toBe("recording.webm");
  });

  it("rejects non-multipart bodies and missing/empty files", async () => {
    seedUser("acct-a");
    const credential = await seedPairedServer("acct-a");
    const jsonBody = await processAiTranscription(
      new Request("https://sawyer.getbb.app/api/connect/ai/transcription", {
        method: "POST",
        headers: {
          "x-bb-connect-machine": credential,
          "content-type": "application/json",
        },
        body: "{}",
      }),
      deps(okInferenceFetch()),
    );
    expect(jsonBody.status).toBe(400);

    const missingFile = await processAiTranscription(
      transcriptionRequest({ credential, file: null }),
      deps(okInferenceFetch()),
    );
    expect(missingFile.status).toBe(400);

    const emptyFile = await processAiTranscription(
      transcriptionRequest({
        credential,
        file: new File([], "empty.webm", { type: "audio/webm" }),
      }),
      deps(okInferenceFetch()),
    );
    expect(emptyFile.status).toBe(400);
    expect(usageCost("acct-a")).toBeNull();
  });

  it("refunds the reservation on upstream failure", async () => {
    seedUser("acct-a");
    const credential = await seedPairedServer("acct-a");
    const failed = await processAiTranscription(
      transcriptionRequest({ credential }),
      deps(fakeFetch(() => new Response("oops", { status: 500 }))),
    );
    expect(failed.status).toBe(502);
    expect(usageCost("acct-a")).toBe(0);
  });
});
