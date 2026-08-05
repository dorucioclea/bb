import { describe, expect, it, vi } from "vitest";
import {
  ConnectListError,
  ConnectMachineRedeemError,
  deriveConnectBaseUrl,
  fetchAiInference,
  fetchAiTranscription,
  listAccountServers,
  redeemMachineCredential,
  serverUrlForHandle,
} from "../src/index.js";

const CREDENTIAL = {
  credential: "bbcm_desktop",
  handle: "laptop",
  serverUrl: "https://laptop.getbb.app",
};

describe("connect URL helpers", () => {
  it("drops and re-adds the routing label", () => {
    expect(deriveConnectBaseUrl("https://laptop.getbb.app")).toBe(
      "https://getbb.app",
    );
    expect(serverUrlForHandle("https://getbb.app", "phone")).toBe(
      "https://phone.getbb.app",
    );
    // Self-hosted apex, non-default port kept.
    expect(deriveConnectBaseUrl("https://laptop.bb.example:8443")).toBe(
      "https://bb.example:8443",
    );
  });
});

describe("listAccountServers", () => {
  it("adds a public URL per handle and reports the self handle", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            servers: [
              { handle: "laptop", name: "Laptop", live: true },
              { handle: "phone", name: "Phone", live: false },
            ],
          }),
        ),
    );

    await expect(listAccountServers(CREDENTIAL, fetchImpl)).resolves.toEqual({
      selfHandle: "laptop",
      servers: [
        {
          handle: "laptop",
          name: "Laptop",
          live: true,
          url: "https://laptop.getbb.app",
        },
        {
          handle: "phone",
          name: "Phone",
          live: false,
          url: "https://phone.getbb.app",
        },
      ],
    });
  });

  it("marks a refused credential unauthorized", async () => {
    await expect(
      listAccountServers(
        CREDENTIAL,
        async () => new Response("no", { status: 401 }),
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      listAccountServers(CREDENTIAL, async () => {
        throw new Error("offline");
      }),
    ).rejects.toBeInstanceOf(ConnectListError);
  });
});

describe("redeemMachineCredential", () => {
  it("labels the credential with the target server, not the account handle", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            credential: "bbcm_desktop",
            machineId: "machine-1",
            // The account's primary handle, which is not the server the code
            // targeted. serverUrl names that server.
            handle: "sawyer",
            serverUrl: "https://laptop.getbb.app",
          }),
        ),
    );

    await expect(
      redeemMachineCredential(
        { apexUrl: "https://getbb.app", code: "ABCD-1234" },
        fetchImpl,
      ),
    ).resolves.toEqual(CREDENTIAL);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://getbb.app/api/connect/redeem-machine",
      expect.objectContaining({
        body: JSON.stringify({ code: "ABCD-1234" }),
        method: "POST",
      }),
    );
  });

  it("maps the gate's rejections to stable codes", async () => {
    const cases: Array<[number, string, string]> = [
      [409, "already-used", "already_used"],
      [409, "machine-limit", "machine_limit"],
      [410, "expired", "expired"],
      [404, "invalid-code", "invalid_code"],
      [500, "boom", "network"],
    ];
    for (const [status, wireError, expected] of cases) {
      await expect(
        redeemMachineCredential(
          { apexUrl: "https://getbb.app", code: "ABCD-1234" },
          async () =>
            new Response(JSON.stringify({ error: wireError }), { status }),
        ),
      ).rejects.toMatchObject({ code: expected });
    }
  });

  it("rejects a response with no server to point at", async () => {
    await expect(
      redeemMachineCredential(
        { apexUrl: "https://getbb.app", code: "ABCD-1234" },
        async () =>
          new Response(
            JSON.stringify({
              credential: "bbcm_desktop",
              machineId: "machine-1",
              serverUrl: null,
            }),
          ),
      ),
    ).rejects.toBeInstanceOf(ConnectMachineRedeemError);
  });

  it("rejects a server URL the asked-for apex does not own", async () => {
    const outsiders = [
      "https://laptop.evil.app",
      "https://laptop.getbb.app.evil.app",
      "http://laptop.getbb.app",
      "https://getbb.app",
    ];
    for (const serverUrl of outsiders) {
      await expect(
        redeemMachineCredential(
          { apexUrl: "https://getbb.app", code: "ABCD-1234" },
          async () =>
            new Response(
              JSON.stringify({
                credential: "bbcm_desktop",
                machineId: "machine-1",
                serverUrl,
              }),
            ),
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("accepts a self-hosted apex", async () => {
    await expect(
      redeemMachineCredential(
        { apexUrl: "https://bb.example", code: "ABCD-1234" },
        async () =>
          new Response(
            JSON.stringify({
              credential: "bbcm_desktop",
              machineId: "machine-1",
              serverUrl: "https://laptop.bb.example",
            }),
          ),
      ),
    ).resolves.toMatchObject({ handle: "laptop" });
  });
});

describe("fetchAiInference", () => {
  it("posts prompt+schema with the credential header and no model name", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ value: { title: "Hi" } })),
    );
    await expect(
      fetchAiInference(
        CREDENTIAL,
        {
          prompt: "Summarize",
          schema: { type: "object", properties: {} },
        },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toEqual({ title: "Hi" });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://laptop.getbb.app/api/connect/ai/inference");
    expect(init.method).toBe("POST");
    expect(
      (init.headers as Record<string, string>)["x-bb-connect-machine"],
    ).toBe("bbcm_desktop");
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: "Summarize",
      schema: { type: "object", properties: {} },
    });
  });

  it("maps statuses to stable codes", async () => {
    const cases: Array<[number, string]> = [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [429, "quota_exhausted"],
      [500, "server_error"],
    ];
    for (const [status, code] of cases) {
      await expect(
        fetchAiInference(
          CREDENTIAL,
          { prompt: "p", schema: {} },
          async () => new Response("{}", { status }),
        ),
      ).rejects.toMatchObject({ name: "ConnectAiError", code, status });
    }
  });

  it("rejects malformed bodies and network failures with typed codes", async () => {
    await expect(
      fetchAiInference(
        CREDENTIAL,
        { prompt: "p", schema: {} },
        async () => new Response(JSON.stringify({ value: "not-an-object" })),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      fetchAiInference(CREDENTIAL, { prompt: "p", schema: {} }, async () => {
        throw new Error("socket hang up");
      }),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("re-throws aborts untouched so callers keep timeout semantics", async () => {
    await expect(
      fetchAiInference(CREDENTIAL, { prompt: "p", schema: {} }, async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("fetchAiTranscription", () => {
  it("posts multipart with filename and optional prompt", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ text: "hello" })),
    );
    const file = new File(["audio"], "recording.webm", { type: "audio/webm" });
    await expect(
      fetchAiTranscription(
        CREDENTIAL,
        { file, prompt: "ctx" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toBe("hello");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://laptop.getbb.app/api/connect/ai/transcription");
    const form = init.body as FormData;
    expect((form.get("file") as File).name).toBe("recording.webm");
    expect(form.get("prompt")).toBe("ctx");
  });

  it("maps a 429 to quota_exhausted", async () => {
    const file = new File(["audio"], "recording.webm", { type: "audio/webm" });
    await expect(
      fetchAiTranscription(
        CREDENTIAL,
        { file },
        async () => new Response("{}", { status: 429 }),
      ),
    ).rejects.toMatchObject({ code: "quota_exhausted" });
  });
});
