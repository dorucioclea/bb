import {
  ConnectAiError,
  fetchAiInference,
  fetchAiTranscription,
  type ConnectCredential,
} from "@bb/connect-client";
import type {
  CloudAiCompleteArgs,
  CloudAiFailureCode,
  CloudAiProvider,
  CloudAiResult,
  CloudAiTranscribeArgs,
  JsonValue,
  PluginKvStorage,
  PluginLogger,
} from "@bb/plugin-sdk";

// bb Cloud AI routing for this bb: when paired and enabled, thread titles,
// commit messages, and voice transcription run through the gate's
// /api/connect/ai/* proxy instead of locally configured providers. Registered
// with the host via bb.experimental_registerCloudAiProvider; the host falls
// back to local providers on any `ok: false` result.

export const CLOUD_AI_ENABLED_KV_KEY = "cloudAiEnabled";

/** Skip the cloud for a while after a budget 429 so exhaustion doesn't add a
 * failed round-trip to every call. Transient failures are not latched — the
 * host's local fallback already absorbs them. */
const QUOTA_COOLDOWN_MS = 5 * 60 * 1000;

export interface CloudAiControllerOptions {
  kv: Pick<PluginKvStorage, "get" | "set">;
  /** Live pairing credential (the tunnel's), or null when unpaired. */
  getCredential: () => ConnectCredential | null;
  log: PluginLogger;
  /** Fired when the enabled setting changes (drives status/realtime pushes). */
  onChange?: () => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class CloudAiController implements CloudAiProvider {
  private enabled = true;
  /** Credential string the gate rejected (401/403); cleared naturally when
   * re-pairing stores a different credential. */
  private rejectedCredential: string | null = null;
  /** Epoch ms until which budget-exhausted cloud calls are skipped. */
  private quotaCooldownUntil = 0;

  constructor(private readonly options: CloudAiControllerOptions) {}

  /** Load the persisted setting; missing key means enabled (the default). */
  async init(): Promise<void> {
    const stored = await this.options.kv.get<boolean>(CLOUD_AI_ENABLED_KV_KEY);
    this.enabled = stored ?? true;
  }

  cloudAiEnabled(): boolean {
    return this.enabled;
  }

  async setCloudAiEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    await this.options.kv.set(CLOUD_AI_ENABLED_KV_KEY, enabled);
    this.options.onChange?.();
  }

  isAvailable(): boolean {
    if (!this.enabled) return false;
    const credential = this.options.getCredential();
    if (credential === null) return false;
    if (this.rejectedCredential === credential.credential) return false;
    if (this.now() < this.quotaCooldownUntil) return false;
    return true;
  }

  async complete(args: CloudAiCompleteArgs): Promise<CloudAiResult<JsonValue>> {
    const credential = this.options.getCredential();
    if (credential === null) {
      return { ok: false, code: "unavailable", message: "not paired" };
    }
    try {
      const value = await fetchAiInference(
        credential,
        { prompt: args.prompt, schema: args.schema, signal: args.signal },
        this.options.fetchImpl ?? globalThis.fetch,
      );
      // Wire boundary: the gate returned zod-validated JSON, so the record's
      // values are JsonValue by construction.
      return { ok: true, value: value as JsonValue };
    } catch (error) {
      return this.failure(credential, error);
    }
  }

  async transcribe(args: CloudAiTranscribeArgs): Promise<CloudAiResult<string>> {
    const credential = this.options.getCredential();
    if (credential === null) {
      return { ok: false, code: "unavailable", message: "not paired" };
    }
    try {
      const text = await fetchAiTranscription(
        credential,
        {
          file: args.file,
          ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
          signal: args.signal,
        },
        this.options.fetchImpl ?? globalThis.fetch,
      );
      return { ok: true, value: text };
    } catch (error) {
      return this.failure(credential, error);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private failure(
    credential: ConnectCredential,
    error: unknown,
  ): CloudAiResult<never> {
    if (!(error instanceof ConnectAiError)) {
      // Aborts (host timeout) and unexpected bugs propagate; the host owns
      // both cases.
      throw error;
    }
    if (error.code === "unauthorized") {
      this.rejectedCredential = credential.credential;
      this.options.log.warn(
        "bb Cloud rejected the pairing credential; cloud AI paused until re-pair",
      );
      return { ok: false, code: "unauthorized", message: error.message };
    }
    if (error.code === "quota_exhausted") {
      this.quotaCooldownUntil = this.now() + QUOTA_COOLDOWN_MS;
      this.options.log.info(
        "bb Cloud AI daily budget reached; using local providers for a while",
      );
      return { ok: false, code: "quota_exhausted", message: error.message };
    }
    this.options.log.warn(`bb Cloud AI call failed: ${error.message}`);
    const code: CloudAiFailureCode = "unavailable";
    return { ok: false, code, message: error.message };
  }
}
