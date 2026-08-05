import { z } from "zod";
import type { ConnectCredential } from "./credential.js";

// bb Cloud AI proxy calls for a paired bb (`/api/connect/ai/*` on the gate).
// The client sends a prompt+schema or an audio file — never a model name;
// models are a gate-side choice so they can change without a client release.

export type ConnectAiErrorCode =
  | "unauthorized"
  | "quota_exhausted"
  | "server_error"
  | "network"
  | "invalid_response";

/**
 * Typed AI-proxy failure. `code` is stable for routing decisions (fall back to
 * a local provider, latch a dead credential); `message` carries detail for
 * logs. Aborts are re-thrown untouched so callers keep their own timeout
 * semantics.
 */
export class ConnectAiError extends Error {
  constructor(
    readonly code: ConnectAiErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ConnectAiError";
  }
}

const aiInferenceResponseSchema = z.object({
  value: z.record(z.string(), z.unknown()),
});
const aiTranscriptionResponseSchema = z.object({ text: z.string() });

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function postAi(
  credential: ConnectCredential,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const url = `${credential.serverUrl.replace(/\/$/, "")}${path}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      method: "POST",
      headers: {
        ...init.headers,
        "x-bb-connect-machine": credential.credential,
      },
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ConnectAiError(
      "network",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ConnectAiError(
      "unauthorized",
      "bb Cloud AI request not authorized",
      response.status,
    );
  }
  if (response.status === 429) {
    throw new ConnectAiError(
      "quota_exhausted",
      "Daily bb Cloud AI budget reached",
      response.status,
    );
  }
  if (!response.ok) {
    throw new ConnectAiError(
      "server_error",
      `bb Cloud AI request failed (${response.status})`,
      response.status,
    );
  }
  return response;
}

/**
 * Structured completion through the gate. Returns the raw value for
 * caller-side schema validation (bb validates against its TypeBox schema).
 */
export async function fetchAiInference(
  credential: ConnectCredential,
  args: {
    prompt: string;
    schema: Record<string, unknown>;
    signal?: AbortSignal;
  },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<unknown> {
  const response = await postAi(
    credential,
    "/api/connect/ai/inference",
    {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: args.prompt, schema: args.schema }),
      ...(args.signal ? { signal: args.signal } : {}),
    },
    fetchImpl,
  );
  const parsed = aiInferenceResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    throw new ConnectAiError(
      "invalid_response",
      "bb Cloud AI inference response failed schema validation",
    );
  }
  return parsed.data.value;
}

/** Voice transcription through the gate (multipart file + optional prompt). */
export async function fetchAiTranscription(
  credential: ConnectCredential,
  args: { file: File; prompt?: string; signal?: AbortSignal },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const form = new FormData();
  form.set("file", args.file, args.file.name);
  if (args.prompt !== undefined) form.set("prompt", args.prompt);
  const response = await postAi(
    credential,
    "/api/connect/ai/transcription",
    {
      body: form,
      ...(args.signal ? { signal: args.signal } : {}),
    },
    fetchImpl,
  );
  const parsed = aiTranscriptionResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) {
    throw new ConnectAiError(
      "invalid_response",
      "bb Cloud AI transcription response failed schema validation",
    );
  }
  return parsed.data.text;
}
