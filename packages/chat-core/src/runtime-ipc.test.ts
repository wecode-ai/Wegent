// @vitest-environment jsdom
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudRuntimeIpcClient } from "./runtime-ipc";
import { createSocketClient } from "./socket";

const socket = {
  connected: true,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};
const ensureConnected = vi.fn().mockResolvedValue(undefined);
const connect = vi.fn().mockResolvedValue(undefined);
const disconnect = vi.fn();
const dispose = vi.fn();
const unsubscribeReconnect = vi.fn();
const onReconnect = vi.fn<(_callback: () => void) => () => void>(
  () => unsubscribeReconnect,
);

vi.mock("./socket", () => ({
  createSocketClient: vi.fn(() => ({
    socket,
    ensureConnected,
    connect,
    disconnect,
    dispose,
    onReconnect,
  })),
}));

describe("createCloudRuntimeIpcClient", () => {
  beforeEach(() => {
    socket.connected = true;
    socket.emit.mockReset();
    socket.on.mockReset();
    socket.off.mockReset();
    ensureConnected.mockReset().mockResolvedValue(undefined);
    connect.mockClear();
    disconnect.mockClear();
    dispose.mockClear();
    onReconnect.mockClear();
    unsubscribeReconnect.mockClear();
  });

  it("decompresses large runtime results returned through the socket acknowledgement", async () => {
    const expected = {
      success: true,
      messages: [{ id: "message-1", content: "历史消息🙂".repeat(1000) }],
    };
    const raw = Buffer.from(JSON.stringify(expected));
    const compressed = gzipSync(raw);
    socket.emit.mockImplementation((_event, _request, acknowledge) => {
      acknowledge({
        ok: true,
        result: {
          __runtimeRpcEncoding: "gzip+base64+json",
          payload: compressed.toString("base64"),
          rawBytes: raw.length,
          compressedBytes: compressed.length,
        },
      });
    });
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });

    await expect(
      client.request("runtime.tasks.transcript", {}, "cloud-device"),
    ).resolves.toEqual(expected);
  });

  it("preserves ordinary runtime results", async () => {
    socket.emit.mockImplementation((_event, request, acknowledge) => {
      expect(request.id).toMatch(/^cloud-runtime-/);
      acknowledge({ ok: true, result: { success: true } });
    });
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });

    await expect(
      client.request("runtime.tasks.list", {}, "cloud-device"),
    ).resolves.toEqual({
      success: true,
    });
  });

  it.each([
    "unsupported_method",
    "remote_control_disabled",
    "executor_offline",
  ])("preserves structured relay failure metadata for %s", async (code) => {
    socket.emit.mockImplementation((_event, _request, acknowledge) => {
      acknowledge({
        ok: false,
        error: {
          code,
          message: "Executor request failed",
          retryable: false,
          details: { deviceId: "failed-device" },
        },
      });
    });
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });
    await expect(
      client.request(
        "runtime.stand_in.assignment_tasks",
        { userId: 7, assignments: [] },
        "failed-device",
      ),
    ).rejects.toMatchObject({
      message: `${code}: Executor request failed`,
      code,
      retryable: false,
      details: { deviceId: "failed-device" },
    });
    client.dispose();
  });

  it("assembles transcript chunks through the owning cloud device", async () => {
    const content = Array.from({ length: 18_000 }, (_, index) =>
      createHash("sha256").update(String(index)).digest("hex"),
    ).join("");
    const expected = { success: true, messages: [{ content }], turns: [] };
    const bytes = gzipSync(
      JSON.stringify({ transcript: expected, strings: [], references: [] }),
    );
    const snapshotId = createHash("sha256").update(bytes).digest("hex");
    const chunkSize = 360 * 1024;
    expect(bytes.length).toBeGreaterThan(chunkSize);
    socket.emit.mockImplementation((_event, request, acknowledge) => {
      expect(request.device_id).toBe("cloud-device");
      expect(request.params.taskId).toBe("task-1");
      expect(request.params.transcriptProtocolVersion).toBe(2);
      const offset = request.params.transcriptTransfer?.offset ?? 0;
      if (offset)
        expect(request.params.transcriptTransfer.snapshotId).toBe(snapshotId);
      const end = Math.min(offset + chunkSize, bytes.length);
      acknowledge({
        ok: true,
        result: {
          success: true,
          transcriptProtocolVersion: 2,
          transfer: {
            snapshotId,
            offset,
            totalBytes: bytes.length,
            encoding: "gzip+base64+json",
            nextOffset: end < bytes.length ? end : null,
            payload: bytes.subarray(offset, end).toString("base64"),
          },
        },
      });
    });
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });
    await expect(
      client.request(
        "runtime.tasks.transcript",
        { taskId: "task-1" },
        "cloud-device",
      ),
    ).resolves.toEqual(expected);
    expect(socket.emit).toHaveBeenCalledTimes(
      Math.ceil(bytes.length / chunkSize),
    );
  });

  it("keeps one request id when the cloud socket connection fails", async () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    ensureConnected.mockRejectedValueOnce(new Error("socket unavailable"));
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });

    await expect(
      client.request("runtime.tasks.list", {}, "cloud-device"),
    ).rejects.toThrow("socket unavailable");
    expect(warning).toHaveBeenCalledWith(
      "[Wework] Cloud runtime RPC connection failed",
      expect.objectContaining({
        request_id: expect.stringMatching(/^cloud-runtime-/),
        method: "runtime.tasks.list",
        device_id: "cloud-device",
      }),
    );
    warning.mockRestore();
  });

  it("does not finish a timed out request when a late acknowledgement arrives", async () => {
    vi.useFakeTimers();
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const debug = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    let acknowledge:
      | ((ack: { ok: true; result: { success: boolean } }) => void)
      | undefined;
    socket.emit.mockImplementation((_event, _request, callback) => {
      acknowledge = callback;
    });
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });

    try {
      const request = client.request(
        "runtime.tasks.list",
        {},
        "cloud-device",
        10,
      );
      const timedOut = expect(request).rejects.toThrow(
        "runtime.tasks.list timed out",
      );
      await vi.advanceTimersByTimeAsync(10);
      await timedOut;

      acknowledge?.({ ok: true, result: { success: true } });

      expect(warning).toHaveBeenCalledWith(
        "[Wework] Cloud runtime RPC acknowledgement arrived after settlement",
        expect.objectContaining({
          request_id: expect.stringMatching(/^cloud-runtime-/),
          method: "runtime.tasks.list",
        }),
      );
      expect(debug).not.toHaveBeenCalledWith(
        "[Wework] Cloud runtime RPC request finished",
        expect.anything(),
      );
    } finally {
      warning.mockRestore();
      debug.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects in-flight discovery on disconnect and permits a fresh request", async () => {
    vi.useFakeTimers();
    let disconnected: ((reason: string) => void) | undefined;
    let acknowledge:
      | ((ack: { ok: true; result: { success: boolean } }) => void)
      | undefined;
    socket.on.mockImplementation((event, handler) => {
      if (event === "disconnect") disconnected = handler;
    });
    socket.emit.mockImplementation((_event, _request, callback) => {
      acknowledge = callback;
    });
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });
    try {
      const request = client.request(
        "runtime.tasks.list",
        { pendingOnly: true },
        "cloud-device",
      );
      const rejected = expect(request).rejects.toThrow(
        "runtime.tasks.list connection closed",
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(disconnected).toBeTypeOf("function");
      disconnected!("transport close");
      await rejected;
      expect(socket.off).toHaveBeenCalledWith("disconnect", disconnected);
      expect(vi.getTimerCount()).toBe(0);
      acknowledge?.({ ok: true, result: { success: true } });
      socket.emit.mockImplementation((_event, _request, callback) => {
        callback({ ok: true, result: { success: true } });
      });
      await expect(
        client.request("runtime.tasks.list", {}, "cloud-device"),
      ).resolves.toEqual({ success: true });
      expect(vi.getTimerCount()).toBe(0);
      expect(socket.off).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects if the connection closes before the request resumes from ensureConnected", async () => {
    vi.useFakeTimers();
    const connected = Promise.resolve();
    ensureConnected.mockReturnValueOnce(connected);
    void connected.then(() => {
      socket.connected = false;
    });
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });
    try {
      const request = client
        .request("runtime.tasks.list", {}, "cloud-device", 10)
        .catch((error) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(await request).toMatchObject({
        message: "runtime.tasks.list connection closed",
      });
      expect(socket.emit).not.toHaveBeenCalled();
      expect(socket.off).toHaveBeenCalledWith(
        "disconnect",
        expect.any(Function),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the requested device command timeout for the relay and acknowledgement", async () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    socket.emit.mockImplementation((_event, payload, ack) => {
      expect(payload).toMatchObject({
        method: "device.execute_command",
        device_id: "device-1",
        timeout_seconds: 300,
      });
      ack({ ok: true, result: { success: true } });
    });
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });

    await expect(
      client.request(
        "device.execute_command",
        { command_key: "git_clone", timeout_seconds: 300 },
        "device-1",
      ),
    ).resolves.toEqual({ success: true });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 310_000);
    timeoutSpy.mockRestore();
  });

  it("keeps the default timeout for ordinary runtime requests", async () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    socket.emit.mockImplementation((_event, payload, ack) => {
      expect(payload).toMatchObject({
        method: "runtime.tasks.list",
        device_id: "device-1",
        timeout_seconds: 75,
      });
      ack({ ok: true, result: [] });
    });
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });

    await expect(
      client.request("runtime.tasks.list", {}, "device-1"),
    ).resolves.toEqual([]);

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 75_000);
    timeoutSpy.mockRestore();
  });

  it("allows a paginated transcript search to finish after the ordinary history timeout", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    const result = { matches: [], totalMatches: 0, isCapped: false };
    let acknowledge:
      | ((ack: { ok: true; result: typeof result }) => void)
      | undefined;
    socket.emit.mockImplementation((_event, payload, callback) => {
      expect(payload).toMatchObject({
        method: "runtime.tasks.transcript.search",
        timeout_seconds: 120,
      });
      acknowledge = callback;
    });
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });

    try {
      const request = client.request(
        "runtime.tasks.transcript.search",
        { query: "needle" },
        "device-1",
      );
      const completed = expect(request).resolves.toEqual(result);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 130_000);
      acknowledge?.({ ok: true, result });
      await completed;
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("bounds transcript search acknowledgement waits even when the relay never responds", async () => {
    vi.useFakeTimers();
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });

    try {
      const request = client.request(
        "runtime.tasks.transcript.search",
        { query: "needle" },
        "device-1",
      );
      const timedOut = expect(request).rejects.toThrow(
        "runtime.tasks.transcript.search timed out",
      );
      await vi.advanceTimersByTimeAsync(130_000);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps device command timeouts at the executor maximum", async () => {
    socket.emit.mockImplementation((_event, payload, ack) => {
      expect(payload.timeout_seconds).toBe(600);
      ack({ ok: true, result: { success: true } });
    });
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });

    await expect(
      client.request(
        "device.execute_command",
        { timeout_seconds: 900 },
        "device-1",
      ),
    ).resolves.toEqual({ success: true });
  });

  it("replaces the runtime socket after system resume", async () => {
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });

    await client.reconnect();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(undefined, true);
    expect(ensureConnected).toHaveBeenCalledTimes(1);
  });

  it("invalidates missed history after reconnect and detaches both listeners", async () => {
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });
    const handler = vi.fn();
    const cleanup = await client.subscribe(handler);
    expect(handler).not.toHaveBeenCalled();
    const reconnect = onReconnect.mock.calls[0][0];

    reconnect();

    expect(handler).toHaveBeenCalledExactlyOnceWith({
      event: "executor.event_lagged",
      payload: { skipped: 0, reason: "transport_reconnected" },
    });
    cleanup();
    expect(unsubscribeReconnect).toHaveBeenCalledTimes(1);
    expect(socket.off).toHaveBeenCalledWith(
      "runtime:event",
      socket.on.mock.calls[0][1],
    );
  });

  it("registers the event listener before the connection handshake finishes", async () => {
    const event = {
      event: "response.completed",
      payload: { taskId: "cloud-task" },
    };
    connect.mockImplementationOnce(async () => {
      socket.on.mock.calls.find(([name]) => name === "runtime:event")![1](
        event,
      );
    });
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });
    const handler = vi.fn();

    await client.subscribe(handler);

    expect(handler).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("cleans up failed subscriptions and rejects a reconnect that never becomes ready", async () => {
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });
    connect.mockRejectedValueOnce(new Error("Network unavailable"));
    await expect(client.subscribe(vi.fn())).rejects.toThrow(
      "Network unavailable",
    );
    expect(socket.off).toHaveBeenCalledWith(
      "runtime:event",
      expect.any(Function),
    );
    expect(unsubscribeReconnect).toHaveBeenCalledTimes(1);

    ensureConnected.mockRejectedValueOnce(new Error("Handshake timed out"));
    await expect(client.reconnect()).rejects.toThrow("Handshake timed out");
  });
  it("resolves the current Web socket endpoint and token after credentials change", async () => {
    let token = "first-token";
    let endpoint = "https://first.example.com";
    createCloudRuntimeIpcClient({
      socketBaseUrl: async () => endpoint,
      socketPath: "/socket.io",
      getToken: () => token,
      clientOrigin: "web",
    });
    const options = vi.mocked(createSocketClient).mock.calls.at(-1)![0];
    expect(options.auth).toEqual({ client_origin: "web" });
    expect(options.getToken()).toBe("first-token");
    expect(await options.socketBaseUrl()).toBe(endpoint);
    token = "refreshed-token";
    endpoint = "https://second.example.com";
    expect(options.getToken()).toBe("refreshed-token");
    expect(await options.socketBaseUrl()).toBe(endpoint);
  });

  it("preserves event sequence and detaches the exact subscription handler", async () => {
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });
    const handler = vi.fn();
    const unsubscribe = await client.subscribe(handler);
    const [name, listener] = socket.on.mock.calls[0];
    const event = {
      event: "chat:chunk",
      payload: { taskId: "task-1" },
      sequence: 42,
    };
    expect(name).toBe("runtime:event");
    listener(event);
    expect(handler).toHaveBeenCalledWith(event);
    unsubscribe();
    expect(socket.off).toHaveBeenCalledWith(name, listener);
    client.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps the event subscription across an initial connection timeout", async () => {
    socket.connected = false;
    ensureConnected.mockRejectedValueOnce(
      new Error("Socket.IO connection timed out"),
    );
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });
    const handler = vi.fn();
    const subscription = client.subscribe(handler);
    await expect(subscription).resolves.toEqual(expect.any(Function));
    const unsubscribe = await subscription;
    expect(ensureConnected).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
    expect(socket.on.mock.invocationCallOrder[0]).toBeLessThan(
      connect.mock.invocationCallOrder[0],
    );

    socket.connected = true;
    const [name, listener] = socket.on.mock.calls[0];
    const event = {
      event: "response.completed",
      payload: { taskId: "task-1" },
    };
    listener(event);
    expect(handler).toHaveBeenCalledWith(event);
    unsubscribe();
    expect(socket.off).toHaveBeenCalledWith(name, listener);
    client.dispose();
  });

  it("requires an actual device address before connecting or sending", async () => {
    const client = createCloudRuntimeIpcClient({
      socketBaseUrl: "https://cloud.example.com",
      socketPath: "/socket.io",
      getToken: () => "token",
    });
    await expect(
      client.request("runtime.tasks.transcript", { taskId: "task-1" }),
    ).rejects.toThrow("missing deviceId");
    expect(ensureConnected).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
