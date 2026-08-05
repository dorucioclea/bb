import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  AI_DAILY_BUDGET_MICROUSD,
  AI_INFERENCE_MAX_PROMPT_BYTES,
  AI_INFERENCE_MAX_SCHEMA_BYTES,
  AI_TRANSCRIPTION_MAX_FILE_BYTES,
  AI_TRANSCRIPTION_MAX_PROMPT_BYTES,
  aiUsage,
  schema,
  type ConnectDb,
} from "@bb/connect-db";
import { withStrictObjectSchemas, type JsonValue } from "./ai-schema.js";
import { affectedRows } from "./machine-label.js";
import { verifyServerCredential } from "./servers.js";
import { verifyMachineCredential } from "./session.js";
import type { Env } from "./tunnel-do.js";

// bb Cloud AI proxy for paired bbs: the client sends a prompt+schema or an
// audio file, never a model name. Models and cost-estimate rates are a gate
// implementation detail so they can change without a client release.
const AI_INFERENCE_MODEL = "gpt-5.6-luna";
const AI_TRANSCRIPTION_MODEL = "gpt-transcribe";

// Rough, conservative-high cost estimates reserved against the daily budget.
// They only need to be monotone in request size (so hammering big requests
// exhausts the budget fastest) — the budget has order-of-magnitude headroom
// over legitimate use, so estimate error is irrelevant.
// gpt-5.6-luna: $0.20/M input tokens at ~4 bytes/token → ~0.05 μ$/byte, plus a
// flat structured-output allowance (~500 output tokens at $1.20/M).
const INFERENCE_COST_MICROUSD_PER_KB = 52;
const INFERENCE_OUTPUT_ALLOWANCE_MICROUSD = 600;
// gpt-transcribe: $0.0045/min; assume audio compresses no better than ~2KB/s
// (cost-maximizing for low-bitrate voice opus) → ~38,400 μ$ per MB.
const TRANSCRIPTION_COST_MICROUSD_PER_MB = 38_400;
const TRANSCRIPTION_BASE_MICROUSD = 100;

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_TRANSCRIPTIONS_URL =
  "https://api.openai.com/v1/audio/transcriptions";

const AI_INFERENCE_UPSTREAM_TIMEOUT_MS = 60_000;
const AI_TRANSCRIPTION_UPSTREAM_TIMEOUT_MS = 120_000;

// Slack over the payload caps for multipart/JSON framing when pre-checking
// Content-Length, so oversized bodies are refused before buffering.
const REQUEST_OVERHEAD_BYTES = 64 * 1024;

const CREDENTIAL_HEADER = "x-bb-connect-machine";

export interface AiProxyDeps {
  db: ConnectDb;
  openAiApiKey: string;
  fetchImpl?: typeof fetch;
  now?: number;
  /** Defer a refund write past the response (ctx.waitUntil in production). */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function estimateInferenceCostMicroUsd(promptBytes: number): number {
  return (
    INFERENCE_OUTPUT_ALLOWANCE_MICROUSD +
    Math.ceil((promptBytes / 1024) * INFERENCE_COST_MICROUSD_PER_KB)
  );
}

export function estimateTranscriptionCostMicroUsd(fileBytes: number): number {
  return (
    TRANSCRIPTION_BASE_MICROUSD +
    Math.ceil((fileBytes / (1024 * 1024)) * TRANSCRIPTION_COST_MICROUSD_PER_MB)
  );
}

/**
 * Header-only auth for the AI endpoints: a machine credential (daemon) or a
 * paired server's tunnel credential. Deliberately NOT `resolveAccountUserId` —
 * a session-cookie path would make these endpoints form-POSTable cross-site,
 * letting a hostile page burn an account's budget and upstream spend.
 */
export async function resolveCredentialUserId(
  request: Request,
  db: ConnectDb,
): Promise<string | null> {
  const presented = request.headers.get(CREDENTIAL_HEADER) ?? "";
  if (!presented) return null;
  const machineUserId = await verifyMachineCredential(presented, db);
  if (machineUserId) return machineUserId;
  return verifyServerCredential(presented, db);
}

/** UTC "YYYY-MM-DD" budget bucket; rollover is implicit via the primary key. */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function secondsToUtcMidnight(now: number): number {
  const date = new Date(now);
  const nextMidnight = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((nextMidnight - now) / 1000));
}

/**
 * Reserve an estimated cost against the daily budget. Single-statement upsert
 * so concurrent requests cannot overrun it: the conditional `setWhere` reports
 * zero affected rows once the reservation would cross the budget.
 */
export async function reserveAiUsage(
  db: ConnectDb,
  userId: string,
  costMicroUsd: number,
  now: number,
): Promise<boolean> {
  const day = utcDayKey(now);
  const result = await db
    .insert(aiUsage)
    .values({ userId, day, costMicroUsd })
    .onConflictDoUpdate({
      target: [aiUsage.userId, aiUsage.day],
      set: {
        costMicroUsd: sql`${aiUsage.costMicroUsd} + ${costMicroUsd}`,
      },
      setWhere: sql`${aiUsage.costMicroUsd} + ${costMicroUsd} <= ${AI_DAILY_BUDGET_MICROUSD}`,
    })
    .run();
  return affectedRows(result) === 1;
}

/** Best-effort refund when the upstream call failed; never goes below zero. */
export async function refundAiUsage(
  db: ConnectDb,
  userId: string,
  costMicroUsd: number,
  now: number,
): Promise<void> {
  const day = utcDayKey(now);
  await db
    .update(aiUsage)
    .set({
      costMicroUsd: sql`MAX(${aiUsage.costMicroUsd} - ${costMicroUsd}, 0)`,
    })
    .where(and(eq(aiUsage.userId, userId), eq(aiUsage.day, day)))
    .run();
}

function jsonError(
  error: string,
  status: number,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error, ...extra }, { status, headers });
}

function quotaExhaustedResponse(now: number): Response {
  const retryAfterSeconds = secondsToUtcMidnight(now);
  return jsonError(
    "quota_exhausted",
    429,
    { retryAfterSeconds },
    { "retry-after": String(retryAfterSeconds) },
  );
}

function contentLengthExceeds(request: Request, maxBytes: number): boolean {
  const header = request.headers.get("content-length");
  if (header === null) return false;
  const length = Number(header);
  return Number.isFinite(length) && length > maxBytes + REQUEST_OVERHEAD_BYTES;
}

interface UpstreamFailure {
  kind: "timeout" | "rejected" | "failed";
}

function upstreamFailureResponse(failure: UpstreamFailure): Response {
  if (failure.kind === "timeout") return jsonError("upstream_timeout", 504);
  if (failure.kind === "rejected") return jsonError("upstream_rejected", 422);
  return jsonError("upstream_failed", 502);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

async function callOpenAi(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<
  { ok: true; response: Response } | { ok: false; failure: UpstreamFailure }
> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbortError(error)) return { ok: false, failure: { kind: "timeout" } };
    console.error("bb-connect ai: upstream fetch failed", error);
    return { ok: false, failure: { kind: "failed" } };
  }
  if (!response.ok) {
    // Log upstream error bodies for ops; never echo them to the client. A 401
    // here means OUR key is broken — still upstream_failed to the caller.
    const body = await response.text().catch(() => "");
    console.error(
      `bb-connect ai: upstream ${response.status} from ${url}: ${body.slice(0, 500)}`,
    );
    const rejected = response.status >= 400 && response.status < 500;
    return {
      ok: false,
      failure: {
        kind: rejected && response.status !== 401 ? "rejected" : "failed",
      },
    };
  }
  return { ok: true, response };
}

/** Extract the structured-output text from a non-streaming Responses payload. */
function responsesOutputText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  if (
    "output_text" in payload &&
    typeof payload.output_text === "string" &&
    payload.output_text.length > 0
  ) {
    return payload.output_text;
  }
  if (!("output" in payload) || !Array.isArray(payload.output)) return null;
  const parts: string[] = [];
  for (const item of payload.output) {
    if (typeof item !== "object" || item === null) continue;
    if (!("content" in item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (
        typeof content === "object" &&
        content !== null &&
        "type" in content &&
        content.type === "output_text" &&
        "text" in content &&
        typeof content.text === "string"
      ) {
        parts.push(content.text);
      }
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

export async function processAiInference(
  request: Request,
  deps: AiProxyDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("method_not_allowed", 405, {}, { allow: "POST" });
  }
  const now = deps.now ?? Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;

  const userId = await resolveCredentialUserId(request, deps.db);
  if (!userId) return jsonError("not_authorized", 401);

  const maxBodyBytes =
    AI_INFERENCE_MAX_PROMPT_BYTES + AI_INFERENCE_MAX_SCHEMA_BYTES;
  if (contentLengthExceeds(request, maxBodyBytes)) {
    return jsonError("too_large", 413);
  }

  const body: unknown = await request.json().catch(() => null);
  if (
    typeof body !== "object" ||
    body === null ||
    !("prompt" in body) ||
    typeof body.prompt !== "string" ||
    body.prompt.length === 0 ||
    !("schema" in body) ||
    typeof body.schema !== "object" ||
    body.schema === null ||
    Array.isArray(body.schema) ||
    (body.schema as Record<string, unknown>).type !== "object"
  ) {
    return jsonError("invalid_request", 400);
  }
  const prompt = body.prompt;
  const outputSchema = body.schema as JsonValue;
  const encoder = new TextEncoder();
  const promptBytes = encoder.encode(prompt).length;
  if (promptBytes > AI_INFERENCE_MAX_PROMPT_BYTES) {
    return jsonError("too_large", 413);
  }
  if (
    encoder.encode(JSON.stringify(outputSchema)).length >
    AI_INFERENCE_MAX_SCHEMA_BYTES
  ) {
    return jsonError("too_large", 413);
  }

  const estimate = estimateInferenceCostMicroUsd(promptBytes);
  const reserved = await reserveAiUsage(deps.db, userId, estimate, now);
  if (!reserved) return quotaExhaustedResponse(now);

  const refund = () => {
    const promise = refundAiUsage(deps.db, userId, estimate, now);
    if (deps.waitUntil) deps.waitUntil(promise);
    return promise.catch(() => undefined);
  };

  const upstream = await callOpenAi(
    fetchImpl,
    OPENAI_RESPONSES_URL,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.openAiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: AI_INFERENCE_MODEL,
        instructions:
          "Follow the user prompt and respond with structured JSON that matches the requested schema.",
        store: false,
        stream: false,
        input: [
          { role: "user", content: [{ type: "input_text", text: prompt }] },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "result",
            strict: true,
            schema: withStrictObjectSchemas(outputSchema),
          },
        },
      }),
    },
    AI_INFERENCE_UPSTREAM_TIMEOUT_MS,
  );
  if (!upstream.ok) {
    void refund();
    return upstreamFailureResponse(upstream.failure);
  }

  const payload: unknown = await upstream.response.json().catch(() => null);
  const outputText = responsesOutputText(payload);
  if (outputText === null) {
    console.error("bb-connect ai: responses payload had no output text");
    void refund();
    return jsonError("upstream_failed", 502);
  }
  let value: unknown;
  try {
    value = JSON.parse(outputText);
  } catch {
    console.error("bb-connect ai: structured output was not valid JSON");
    void refund();
    return jsonError("upstream_failed", 502);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    void refund();
    return jsonError("upstream_failed", 502);
  }
  return Response.json({ value });
}

export async function processAiTranscription(
  request: Request,
  deps: AiProxyDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError("method_not_allowed", 405, {}, { allow: "POST" });
  }
  const now = deps.now ?? Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;

  const userId = await resolveCredentialUserId(request, deps.db);
  if (!userId) return jsonError("not_authorized", 401);

  if (contentLengthExceeds(request, AI_TRANSCRIPTION_MAX_FILE_BYTES)) {
    return jsonError("too_large", 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("invalid_request", 400);
  }
  // workers-types declares FormData values as string; the runtime hands back a
  // File for file parts. Narrow through unknown at this boundary.
  const file: unknown = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return jsonError("invalid_request", 400);
  }
  if (file.size > AI_TRANSCRIPTION_MAX_FILE_BYTES) {
    return jsonError("too_large", 413);
  }
  const promptEntry = form.get("prompt");
  if (promptEntry !== null && typeof promptEntry !== "string") {
    return jsonError("invalid_request", 400);
  }
  const prompt = promptEntry ?? undefined;
  if (
    prompt !== undefined &&
    new TextEncoder().encode(prompt).length > AI_TRANSCRIPTION_MAX_PROMPT_BYTES
  ) {
    return jsonError("too_large", 413);
  }

  const estimate = estimateTranscriptionCostMicroUsd(file.size);
  const reserved = await reserveAiUsage(deps.db, userId, estimate, now);
  if (!reserved) return quotaExhaustedResponse(now);

  const refund = () => {
    const promise = refundAiUsage(deps.db, userId, estimate, now);
    if (deps.waitUntil) deps.waitUntil(promise);
    return promise.catch(() => undefined);
  };

  // Rebuild the upstream form from scratch — client headers and any extra
  // multipart fields never reach OpenAI.
  const upstreamForm = new FormData();
  upstreamForm.set("model", AI_TRANSCRIPTION_MODEL);
  upstreamForm.set("file", file, file.name || "voice-input");
  if (prompt !== undefined) upstreamForm.set("prompt", prompt);
  upstreamForm.set("response_format", "json");

  const upstream = await callOpenAi(
    fetchImpl,
    OPENAI_TRANSCRIPTIONS_URL,
    {
      method: "POST",
      headers: { authorization: `Bearer ${deps.openAiApiKey}` },
      body: upstreamForm,
    },
    AI_TRANSCRIPTION_UPSTREAM_TIMEOUT_MS,
  );
  if (!upstream.ok) {
    void refund();
    return upstreamFailureResponse(upstream.failure);
  }

  const payload: unknown = await upstream.response.json().catch(() => null);
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("text" in payload) ||
    typeof payload.text !== "string"
  ) {
    console.error("bb-connect ai: transcription payload had no text");
    void refund();
    return jsonError("upstream_failed", 502);
  }
  return Response.json({ text: payload.text });
}

/** `POST /api/connect/ai/inference` — structured completion for a paired bb. */
export async function handleAiInference(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  return processAiInference(request, {
    db: drizzle(env.DB, { schema }),
    openAiApiKey: env.OPENAI_API_KEY,
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
}

/** `POST /api/connect/ai/transcription` — voice transcription for a paired bb. */
export async function handleAiTranscription(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  return processAiTranscription(request, {
    db: drizzle(env.DB, { schema }),
    openAiApiKey: env.OPENAI_API_KEY,
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
}
