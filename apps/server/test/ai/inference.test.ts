import type { CloudAiProvider, CloudAiResult, JsonValue } from "@bb/plugin-sdk";
import { Type } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  registerCloudAiProvider,
  resetCloudAiProviderForTests,
} from "../../src/services/ai/cloud-ai-provider.js";
import {
  InferenceTimeoutError,
  inferenceComplete,
} from "../../src/services/ai/inference.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { seedHostSession } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const titleSchema = Type.Object({
  title: Type.String(),
});

describe("inferenceComplete", () => {
  it("surfaces missing host for codex inference", async () => {
    await withTestHarness({
      inferenceModel: "codex/gpt-5.6-luna",
    }, async (harness) => {
      await expect(
        inferenceComplete(harness.deps, {
          prompt: "Generate a title",
          schema: titleSchema,
          timeoutMs: 5000,
        }),
      ).rejects.toMatchObject({
        body: {
          code: "host_unavailable",
        },
        status: 502,
      });
    });
  });

  it("routes codex inference through the host daemon and validates structured output", async () => {
    await withTestHarness({
      inferenceModel: "codex/gpt-5.6-luna",
    }, async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const completion = inferenceComplete(harness.deps, {
        prompt: "Generate a title",
        schema: titleSchema,
        timeoutMs: 5000,
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "codex.inference.complete",
      );
      expect(queued.row.hostId).toBe(host.id);
      expect(queued.command).toMatchObject({
        type: "codex.inference.complete",
        model: "gpt-5.6-luna",
        reasoningEffort: "none",
        prompt: "Generate a title",
        timeoutMs: 5000,
      });

      await reportQueuedCommandSuccess(harness, queued, {
        model: "gpt-5.6-luna",
        value: { title: "Generated title" },
      });

      await expect(completion).resolves.toEqual({
        title: "Generated title",
      });
    });
  });

  it("converts codex daemon timeouts into inference timeouts", async () => {
    await withTestHarness({
      inferenceModel: "codex/gpt-5.6-luna",
    }, async (harness) => {
      seedHostSession(harness.deps);
      const completion = inferenceComplete(harness.deps, {
        prompt: "Generate a title",
        schema: titleSchema,
        timeoutMs: 5000,
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "codex.inference.complete",
      );
      const completionExpectation =
        expect(completion).rejects.toBeInstanceOf(InferenceTimeoutError);
      await reportQueuedCommandError(harness, queued, {
        errorCode: "codex_request_timeout",
        errorMessage: "Codex request timed out after 5000ms",
      });

      await completionExpectation;
    });
  });

  it("surfaces codex daemon auth errors", async () => {
    await withTestHarness({
      inferenceModel: "codex/gpt-5.6-luna",
    }, async (harness) => {
      seedHostSession(harness.deps);
      const completion = inferenceComplete(harness.deps, {
        prompt: "Generate a title",
        schema: titleSchema,
        timeoutMs: 5000,
      });

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "codex.inference.complete",
      );
      const completionExpectation = expect(completion).rejects.toMatchObject({
        body: {
          code: "codex_auth_missing",
        },
        status: 502,
      });
      await reportQueuedCommandError(harness, queued, {
        errorCode: "codex_auth_missing",
        errorMessage: "Codex auth file not found",
      });

      await completionExpectation;
    });
  });
});

describe("inferenceComplete cloud provider routing", () => {
  afterEach(() => {
    resetCloudAiProviderForTests();
  });

  function stubProvider(over: {
    available?: boolean;
    complete?: CloudAiProvider["complete"];
  }): CloudAiProvider & { completeCalls: number } {
    const provider = {
      completeCalls: 0,
      isAvailable: () => over.available ?? true,
      async complete(
        args: Parameters<CloudAiProvider["complete"]>[0],
      ): Promise<CloudAiResult<JsonValue>> {
        provider.completeCalls += 1;
        if (over.complete) return over.complete(args);
        return { ok: true, value: { title: "Cloud title" } };
      },
      async transcribe(): Promise<CloudAiResult<string>> {
        throw new Error("not under test");
      },
    };
    return provider;
  }

  it("routes through an available provider instead of the codex daemon", async () => {
    // codex model configured and NO host connected: success proves the daemon
    // path was never consulted (it would throw host_unavailable).
    await withTestHarness({
      inferenceModel: "codex/gpt-5.4-mini",
    }, async (harness) => {
      const provider = stubProvider({});
      registerCloudAiProvider("connect", provider);
      let sentSchema: JsonValue | null = null;
      provider.complete = async (args) => {
        provider.completeCalls += 1;
        sentSchema = args.schema;
        return { ok: true, value: { title: "Cloud title" } };
      };

      await expect(
        inferenceComplete(harness.deps, {
          prompt: "Generate a title",
          schema: titleSchema,
          timeoutMs: 5000,
        }),
      ).resolves.toEqual({ title: "Cloud title" });
      expect(sentSchema).toMatchObject({ type: "object" });
    });
  });

  it("skips an unavailable provider and returns null on invalid results", async () => {
    await withTestHarness(async (harness) => {
      const unavailable = stubProvider({ available: false });
      registerCloudAiProvider("connect", unavailable);
      // Local config is test/mock-model (unsupported) → local path yields null.
      await expect(
        inferenceComplete(harness.deps, {
          prompt: "Generate a title",
          schema: titleSchema,
        }),
      ).resolves.toBeNull();
      expect(unavailable.completeCalls).toBe(0);

      const invalidResult = stubProvider({
        complete: async () => ({ ok: true, value: { wrong: 1 } }),
      });
      registerCloudAiProvider("connect", invalidResult);
      await expect(
        inferenceComplete(harness.deps, {
          prompt: "Generate a title",
          schema: titleSchema,
        }),
      ).resolves.toBeNull();
    });
  });

  it("falls through to local on provider failure or a provider bug", async () => {
    await withTestHarness(async (harness) => {
      const failing = stubProvider({
        complete: async () => ({
          ok: false,
          code: "quota_exhausted",
          message: "budget reached",
        }),
      });
      registerCloudAiProvider("connect", failing);
      await expect(
        inferenceComplete(harness.deps, {
          prompt: "Generate a title",
          schema: titleSchema,
        }),
      ).resolves.toBeNull();
      expect(failing.completeCalls).toBe(1);

      const throwing = stubProvider({
        complete: async () => {
          throw new Error("plugin bug");
        },
      });
      registerCloudAiProvider("connect", throwing);
      await expect(
        inferenceComplete(harness.deps, {
          prompt: "Generate a title",
          schema: titleSchema,
        }),
      ).resolves.toBeNull();
    });
  });

  it("turns a provider timeout into InferenceTimeoutError without local fallback", async () => {
    await withTestHarness(async (harness) => {
      registerCloudAiProvider(
        "connect",
        stubProvider({
          complete: (args) =>
            new Promise((_, reject) => {
              args.signal.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"));
              });
            }),
        }),
      );

      await expect(
        inferenceComplete(harness.deps, {
          prompt: "Generate a title",
          schema: titleSchema,
          timeoutMs: 50,
        }),
      ).rejects.toBeInstanceOf(InferenceTimeoutError);
    });
  });

  it("stale unregister hooks cannot tear down a newer registration", async () => {
    await withTestHarness(async (harness) => {
      const first = stubProvider({});
      const unregisterFirst = registerCloudAiProvider("connect", first);
      const second = stubProvider({});
      registerCloudAiProvider("connect", second);
      unregisterFirst();

      await expect(
        inferenceComplete(harness.deps, {
          prompt: "Generate a title",
          schema: titleSchema,
        }),
      ).resolves.toEqual({ title: "Cloud title" });
      expect(second.completeCalls).toBe(1);
      expect(first.completeCalls).toBe(0);
    });
  });
});
