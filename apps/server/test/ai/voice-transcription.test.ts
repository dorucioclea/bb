import { Buffer } from "node:buffer";
import type { HostDaemonOnlineRpcRequestMessage } from "@bb/host-daemon-contract";
import type { CloudAiProvider, CloudAiResult } from "@bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  registerCloudAiProvider,
  resetCloudAiProviderForTests,
} from "../../src/services/ai/cloud-ai-provider.js";
import {
  resolveVoiceTranscriptionEnabled,
  transcribeVoiceInput,
} from "../../src/services/ai/voice-transcription.js";
import {
  registerHostRpcResponder,
  type HostRpcResponder,
  type RegisterHostRpcResponderArgs,
} from "../helpers/host-rpc.js";
import { seedHostSession } from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchResult = ReturnType<typeof fetch>;

type CodexVoiceTranscribeCommand = Extract<
  HostDaemonOnlineRpcRequestMessage["command"],
  { type: "codex.voice.transcribe" }
>;

interface CodexTranscriptionHarness {
  app: TestAppHarness["app"];
  cleanup: TestAppHarness["cleanup"];
  deps: TestAppHarness["deps"];
  requests: HostRpcResponder["requests"];
}

interface CreateCodexTranscriptionHarnessArgs {
  handle: RegisterHostRpcResponderArgs["handle"];
}

function voiceFile(): File {
  return new File([Buffer.from("audio")], "prompt.webm", {
    type: "audio/webm",
  });
}

function emptyVoiceFile(): File {
  return new File([], "prompt.webm", { type: "audio/webm" });
}

function requireCodexVoiceTranscribeCommand(
  request: HostDaemonOnlineRpcRequestMessage,
): CodexVoiceTranscribeCommand {
  const command = request.command;
  if (command.type !== "codex.voice.transcribe") {
    throw new Error(`Unexpected command ${command.type}`);
  }
  return command;
}

async function createCodexTranscriptionHarness({
  handle,
}: CreateCodexTranscriptionHarnessArgs): Promise<CodexTranscriptionHarness> {
  const harness = await createTestAppHarness({
    transcriptionModel: "codex/gpt-4o-mini-transcribe",
  });
  const { host, session } = seedHostSession(harness.deps);
  const responder = registerHostRpcResponder(harness, {
    hostId: host.id,
    sessionId: session.id,
    handle,
  });
  return {
    app: harness.app,
    cleanup: harness.cleanup,
    deps: harness.deps,
    requests: responder.requests,
  };
}

function expectRetryableApiError(
  error: unknown,
  expected: { code: string; status: number },
): void {
  expect(error).toBeInstanceOf(ApiError);
  if (!(error instanceof ApiError)) {
    throw new Error("Expected ApiError.");
  }
  expect(error.status).toBe(expected.status);
  expect(error.body).toMatchObject({
    code: expected.code,
    retryable: true,
  });
}

describe("voice transcription", () => {
  it("rejects empty audio before sending a host RPC command", async () => {
    const harness = await createCodexTranscriptionHarness({
      handle() {
        throw new Error("Empty audio must not reach the host daemon");
      },
    });
    try {
      const form = new FormData();
      form.set("file", emptyVoiceFile());
      const response = await harness.app.request(
        "/api/v1/system/voice-transcription",
        { body: form, method: "POST" },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_request",
        message: "Audio file must not be empty",
      });
      expect(harness.requests).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("retries transient Codex transcription rate limits", async () => {
    let requestCount = 0;
    const harness = await createCodexTranscriptionHarness({
      handle(request) {
        const command = requireCodexVoiceTranscribeCommand(request);
        requestCount += 1;
        if (requestCount === 1) {
          return {
            ok: false,
            errorCode: "codex_rate_limited",
            errorMessage:
              "Codex transcription request failed with HTTP 429: Transcription is temporarily unavailable. Please try again later.",
          };
        }
        return {
          ok: true,
          result: {
            model: command.model,
            text: "hello world",
          },
        };
      },
    });
    try {
      await expect(
        transcribeVoiceInput(harness.deps, { file: voiceFile() }),
      ).resolves.toBe("hello world");
      expect(harness.requests).toHaveLength(2);
      expect(harness.requests[0]?.command).toMatchObject({
        timeoutMs: 10_000,
        type: "codex.voice.transcribe",
      });
      expect(harness.requests[1]?.command).toMatchObject({
        timeoutMs: 10_000,
        type: "codex.voice.transcribe",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns retryable unavailable after exhausting Codex rate limit retries", async () => {
    const harness = await createCodexTranscriptionHarness({
      handle(request) {
        requireCodexVoiceTranscribeCommand(request);
        return {
          ok: false,
          errorCode: "codex_rate_limited",
          errorMessage:
            "Codex transcription request failed with HTTP 429: Transcription is temporarily unavailable. Please try again later.",
        };
      },
    });
    try {
      let thrown: unknown = null;
      try {
        await transcribeVoiceInput(harness.deps, { file: voiceFile() });
      } catch (error) {
        thrown = error;
      }

      expectRetryableApiError(thrown, {
        code: "transcription_unavailable",
        status: 503,
      });
      expect(harness.requests).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns retryable timeout after exhausting Codex timeout retries", async () => {
    const harness = await createCodexTranscriptionHarness({
      handle(request) {
        requireCodexVoiceTranscribeCommand(request);
        return {
          ok: false,
          errorCode: "command_timeout",
          errorMessage: "Timed out waiting for command result",
        };
      },
    });
    try {
      let thrown: unknown = null;
      try {
        await transcribeVoiceInput(harness.deps, { file: voiceFile() });
      } catch (error) {
        thrown = error;
      }

      expectRetryableApiError(thrown, {
        code: "transcription_timeout",
        status: 504,
      });
      expect(harness.requests).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not retry non-retryable Codex auth failures", async () => {
    const harness = await createCodexTranscriptionHarness({
      handle(request) {
        requireCodexVoiceTranscribeCommand(request);
        return {
          ok: false,
          errorCode: "codex_auth_failed",
          errorMessage:
            "Codex transcription request failed with HTTP 401: Unauthorized",
        };
      },
    });
    try {
      await expect(
        transcribeVoiceInput(harness.deps, { file: voiceFile() }),
      ).rejects.toMatchObject({
        body: {
          code: "codex_auth_failed",
          retryable: false,
        },
        status: 502,
      });
      expect(harness.requests).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("uses the 10 second timeout budget for OpenAI transcription", async () => {
    const harness = await createTestAppHarness({
      transcriptionModel: "openai/gpt-4o-transcribe",
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchStub = vi.fn(
      (_url: FetchInput, init?: FetchInit): FetchResult => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve(
          new Response(JSON.stringify({ text: "hello openai" }), {
            status: 200,
          }),
        );
      },
    );
    vi.stubGlobal("fetch", fetchStub);
    try {
      await expect(
        transcribeVoiceInput(harness.deps, { file: voiceFile() }),
      ).resolves.toBe("hello openai");
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
    } finally {
      vi.unstubAllGlobals();
      setTimeoutSpy.mockRestore();
      await harness.cleanup();
    }
  });
});

describe("voice transcription cloud provider routing", () => {
  afterEach(() => {
    resetCloudAiProviderForTests();
  });

  function stubProvider(over: {
    available?: boolean;
    transcribe?: CloudAiProvider["transcribe"];
  }): CloudAiProvider {
    return {
      isAvailable: () => over.available ?? true,
      async complete(): Promise<CloudAiResult<never>> {
        throw new Error("not under test");
      },
      async transcribe(
        args: Parameters<CloudAiProvider["transcribe"]>[0],
      ): Promise<CloudAiResult<string>> {
        if (over.transcribe) return over.transcribe(args);
        return { ok: true, value: "hello cloud" };
      },
    };
  }

  it("transcribes through an available provider with the trimmed prompt", async () => {
    const harness = await createTestAppHarness({});
    try {
      let sentPrompt: string | undefined;
      registerCloudAiProvider(
        "connect",
        stubProvider({
          transcribe: async (args) => {
            sentPrompt = args.prompt;
            return { ok: true, value: "hello cloud" };
          },
        }),
      );
      await expect(
        transcribeVoiceInput(harness.deps, {
          file: voiceFile(),
          prompt: "  context  ",
        }),
      ).resolves.toBe("hello cloud");
      expect(sentPrompt).toBe("context");
    } finally {
      await harness.cleanup();
    }
  });

  it("falls back to the codex daemon when the provider fails", async () => {
    const harness = await createCodexTranscriptionHarness({
      handle(request) {
        const command = requireCodexVoiceTranscribeCommand(request);
        return {
          ok: true,
          result: { model: command.model, text: "hello daemon" },
        };
      },
    });
    try {
      registerCloudAiProvider(
        "connect",
        stubProvider({
          transcribe: async () => ({
            ok: false,
            code: "quota_exhausted",
            message: "budget reached",
          }),
        }),
      );
      await expect(
        transcribeVoiceInput(harness.deps, { file: voiceFile() }),
      ).resolves.toBe("hello daemon");
      expect(harness.requests).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("maps quota exhaustion to a retryable 503 when no local provider exists", async () => {
    const harness = await createTestAppHarness({});
    try {
      registerCloudAiProvider(
        "connect",
        stubProvider({
          transcribe: async () => ({
            ok: false,
            code: "quota_exhausted",
            message: "budget reached",
          }),
        }),
      );
      await transcribeVoiceInput(harness.deps, { file: voiceFile() }).then(
        () => {
          throw new Error("Expected transcription to fail");
        },
        (error: unknown) => {
          expectRetryableApiError(error, {
            code: "transcription_unavailable",
            status: 503,
          });
          expect((error as ApiError).body.message).toContain("budget");
        },
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("maps a provider timeout to the standard 504 without a local attempt", async () => {
    const harness = await createTestAppHarness({});
    try {
      registerCloudAiProvider(
        "connect",
        stubProvider({
          transcribe: (args) =>
            new Promise((_, reject) => {
              args.signal.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"));
              });
            }),
        }),
      );
      vi.useFakeTimers();
      const attempt = transcribeVoiceInput(harness.deps, {
        file: voiceFile(),
      });
      const expectation = expect(attempt).rejects.toMatchObject({
        status: 504,
        body: { code: "transcription_timeout" },
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await expectation;
    } finally {
      vi.useRealTimers();
      await harness.cleanup();
    }
  });

  it("reports voice transcription enabled from provider availability alone", async () => {
    const harness = await createTestAppHarness({});
    try {
      // Default harness config: unsupported local transcription provider.
      expect(resolveVoiceTranscriptionEnabled(harness.deps)).toBe(false);
      registerCloudAiProvider("connect", stubProvider({ available: false }));
      expect(resolveVoiceTranscriptionEnabled(harness.deps)).toBe(false);
      registerCloudAiProvider("connect", stubProvider({}));
      expect(resolveVoiceTranscriptionEnabled(harness.deps)).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });
});
