import { describe, expect, it, vi } from "vitest";
import { createRuntimeConversationSession } from "./runtime-conversation-session";
import type {
  RuntimeConversationClient,
  RuntimeConversationHandlers,
} from "./runtime-conversation-client";
import type {
  RuntimeContextUsage,
  RuntimeTranscriptResponse,
  RuntimeTranscriptTurn,
} from "./runtime";

const address = {
  deviceId: "device",
  taskId: "session",
  workspacePath: "/work",
};
function turn(id: string, index: number): RuntimeTranscriptTurn {
  return {
    id,
    status: "done",
    messageIndex: index,
    items: [
      {
        id: `user-${id}`,
        type: "user_message",
        message: {
          id: `user-${id}`,
          role: "user",
          content: `Question ${id}`,
          createdAt: "2026-09-17T00:00:00Z",
          messageIndex: index,
        },
      },
      {
        id: `text-${id}`,
        type: "assistant_text",
        content: `Answer ${id}`,
        createdAt: "2026-09-17T00:00:01Z",
      },
    ],
  };
}
function page(start = 50, end = 100): RuntimeTranscriptResponse {
  return {
    workspacePath: "/work",
    runtime: "codex",
    running: false,
    title: "Actual task",
    messages: [],
    turns: [turn(String(start), start)],
    rangeStart: start,
    rangeEnd: end,
    beforeCursor: start ? `offset:${start}` : null,
    hasMoreBefore: start > 0,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  let handlers!: RuntimeConversationHandlers;
  const unsubscribe = vi.fn();
  const client: RuntimeConversationClient = {
    getTranscript: vi.fn().mockResolvedValue(page()),
    subscribe: vi.fn(async (_address, next) => {
      handlers = next;
      return unsubscribe;
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
  const session = createRuntimeConversationSession(client, address);
  return { session, client, unsubscribe, handlers: () => handlers };
}

describe("shared runtime execution session", () => {
  it("clears a stale running result when the executor confirms idle with missing history", async () => {
    const { session, client, handlers } = setup();
    session.start();
    await session.reload();
    handlers().onAssistantStart?.({} as never);
    vi.mocked(client.getTranscript).mockResolvedValueOnce({
      ...page(0, 0),
      runtime: "claude_code",
      running: false,
      messages: [],
      turns: [],
      historyUnavailable: true,
    });
    await session.reload();
    expect(session.getSnapshot().running).toBe(false);
    expect(session.getSnapshot().runStatus).toBe("unknown");
    expect(session.getSnapshot().historyUnavailable).toBe(true);
    // An unavailable read cannot erase already confirmed conversation text.
    expect(session.getSnapshot().messages.length).toBeGreaterThan(0);
    session.stop();
  });

  const usage = (tokens: number): RuntimeContextUsage => {
    const breakdown = {
      totalTokens: tokens,
      inputTokens: tokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    };
    return { modelContextWindow: 1000, last: breakdown, total: breakdown };
  };
  it("keeps live usage when an older transcript finishes and ignores events after stop", async () => {
    const { session, client, handlers } = setup();
    const pending = deferred<RuntimeTranscriptResponse>();
    const requested = deferred<void>();
    vi.mocked(client.getTranscript).mockImplementationOnce(() => {
      requested.resolve();
      return pending.promise;
    });
    session.start();
    await requested.promise;
    handlers().onContextUsageUpdated?.(usage(700));
    pending.resolve({ ...page(), contextUsage: usage(100) });
    await session.reload();
    expect(session.getSnapshot().contextUsage).toEqual(usage(700));
    session.stop();
    handlers().onContextUsageUpdated?.(usage(900));
    expect(session.getSnapshot().contextUsage).toEqual(usage(700));
  });
  it("hydrates usage from the latest transcript while older history cannot replace it", async () => {
    const { session, client } = setup();
    vi.mocked(client.getTranscript).mockResolvedValueOnce({
      ...page(),
      contextUsage: usage(600),
    });
    session.start();
    await session.reload();
    expect(session.getSnapshot().contextUsage).toEqual(usage(600));
    vi.mocked(client.getTranscript).mockResolvedValueOnce({
      ...page(0, 50),
      contextUsage: usage(100),
    });
    await session.loadMoreBefore();
    expect(session.getSnapshot().contextUsage).toEqual(usage(600));
    vi.mocked(client.getTranscript).mockResolvedValueOnce({
      ...page(),
      contextUsage: usage(200),
    });
    await session.reload();
    expect(session.getSnapshot().contextUsage).toEqual(usage(200));
    session.stop();
  });
  it("keeps a live title and lifecycle change when an older snapshot arrives", async () => {
    const { session, client, handlers } = setup();
    const pending = deferred<RuntimeTranscriptResponse>();
    const requested = deferred<void>();
    vi.mocked(client.getTranscript).mockImplementationOnce(() => {
      requested.resolve();
      return pending.promise;
    });
    session.start();
    await requested.promise;
    handlers().onAssistantStart?.("live-turn");
    handlers().onRuntimeTaskTitleUpdated?.({ ...address, title: "Live title" });
    pending.resolve(page());
    await session.reload();
    expect(session.getSnapshot()).toMatchObject({
      title: "Live title",
      running: true,
      runStatus: "running",
    });
    session.stop();
  });

  it("does not reopen completed history when a partial request finishes later", async () => {
    const { session, client } = setup();
    session.start();
    await session.reload();
    const pending = deferred<RuntimeTranscriptResponse>();
    vi.mocked(client.getTranscript).mockReturnValueOnce(pending.promise);
    const older = session.loadMoreBefore();
    vi.mocked(client.getTranscript).mockResolvedValueOnce({
      ...page(0, 100),
      fullContent: true,
    });
    await session.reload();
    pending.resolve(page(10, 50));
    await older;
    expect(session.getSnapshot().hasMoreBefore).toBe(false);
    const calls = vi.mocked(client.getTranscript).mock.calls.length;
    await session.loadMoreBefore();
    expect(client.getTranscript).toHaveBeenCalledTimes(calls);
    session.stop();
  });
  it("subscribes before loading and projects canonical turns with the actual title", async () => {
    const { session, client } = setup();
    session.start();
    await session.reload();
    expect(
      vi.mocked(client.subscribe).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(client.getTranscript).mock.invocationCallOrder[0]);
    expect(client.getTranscript).toHaveBeenCalledWith({
      ...address,
      limit: 50,
      refresh: true,
    });
    expect(session.getSnapshot()).toMatchObject({
      title: "Actual task",
      loading: false,
      running: false,
      runStatus: "succeeded",
      loadedTranscriptRanges: [{ start: 50, end: 100 }],
    });
    expect(
      session.getSnapshot().messages.map((message) => message.content),
    ).toEqual(["Question 50", "Answer 50"]);
    session.stop();
  });
  it("keeps live completion when an older snapshot finishes later", async () => {
    const { session, client, handlers } = setup();
    const result = deferred<RuntimeTranscriptResponse>();
    vi.mocked(client.getTranscript).mockReturnValue(result.promise);
    session.start();
    await vi.waitFor(() => expect(client.getTranscript).toHaveBeenCalledOnce());
    handlers().onMessageAction({ type: "assistant_started", subtaskId: "50" });
    handlers().onAssistantStart?.("50");
    handlers().onMessageAction({
      type: "assistant_chunk",
      subtaskId: "50",
      itemId: "text-50",
      content: "Completed answer",
      offset: 0,
    });
    handlers().onMessageAction({
      type: "assistant_done",
      subtaskId: "50",
      itemId: "text-50",
      content: "Completed answer",
    });
    handlers().onAssistantSettled?.("50", "succeeded");
    result.resolve({
      ...page(),
      running: true,
      turns: [{ ...turn("50", 50), status: "streaming" }],
    });
    await session.reload();
    expect(session.getSnapshot()).toMatchObject({
      running: false,
      runStatus: "succeeded",
      loading: false,
    });
    expect(session.getSnapshot().messages.at(-1)?.status).toBe("done");
    session.stop();
  });
  it("merges older pages without resetting the reading history or oldest cursor on refresh", async () => {
    const { session, client } = setup();
    session.start();
    await session.reload();
    vi.mocked(client.getTranscript).mockResolvedValueOnce(page(0, 50));
    await session.loadMoreBefore();
    expect(client.getTranscript).toHaveBeenLastCalledWith({
      ...address,
      limit: 50,
      beforeCursor: "offset:50",
    });
    expect(session.getSnapshot().loadedTranscriptRanges).toEqual([
      { start: 0, end: 100 },
    ]);
    expect(session.getSnapshot().hasMoreBefore).toBe(false);
    await session.reload();
    expect(session.getSnapshot().hasMoreBefore).toBe(false);
    expect(
      session
        .getSnapshot()
        .messages.filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["Question 0", "Question 50"]);
    session.stop();
  });
  it("loads a navigation page and only the uncovered gap using native cursor rules", async () => {
    const { session, client } = setup();
    session.start();
    await session.reload();
    vi.mocked(client.getTranscript).mockResolvedValueOnce(page(10, 50));
    await session.loadTurn({
      id: "old-user",
      turnIndex: 1,
      messageIndex: 10,
      cursor: "offset:10",
      promptPreview: "old",
    });
    expect(client.getTranscript).toHaveBeenLastCalledWith({
      ...address,
      limit: 50,
      beforeCursor: "offset:50",
    });
    vi.mocked(client.getTranscript).mockResolvedValueOnce(page(0, 10));
    await session.loadGap({ start: 0, end: 10 });
    expect(client.getTranscript).toHaveBeenLastCalledWith({
      ...address,
      limit: 10,
      afterCursor: "offset:0",
    });
    session.stop();
  });
  it("keeps history errors visible and permits the failed page to be requested again", async () => {
    const { session, client } = setup();
    session.start();
    await session.reload();
    vi.mocked(client.getTranscript).mockRejectedValueOnce(
      new Error("History unavailable"),
    );
    await session.loadMoreBefore();
    expect(session.getSnapshot()).toMatchObject({
      error: "History unavailable",
      loadingMoreBefore: false,
      hasMoreBefore: true,
    });
    expect(session.getSnapshot().messages).toHaveLength(2);
    vi.mocked(client.getTranscript).mockResolvedValueOnce(page(0, 50));
    await session.loadMoreBefore();
    expect(session.getSnapshot()).toMatchObject({
      error: null,
      hasMoreBefore: false,
    });
    session.stop();
  });
  it("surfaces connection failures and reconnects on explicit retry", async () => {
    const { session, client } = setup();
    vi.mocked(client.subscribe).mockRejectedValueOnce(
      new Error("Disconnected"),
    );
    session.start();
    await session.reload();
    expect(session.getSnapshot()).toMatchObject({
      error: "Disconnected",
      loading: false,
    });
    expect(client.getTranscript).not.toHaveBeenCalled();
    await session.reload();
    expect(session.getSnapshot()).toMatchObject({
      error: null,
      loading: false,
    });
    expect(client.subscribe).toHaveBeenCalledTimes(2);
    session.stop();
  });
  it("releases a pending subscription after unmount and ignores its late completion", async () => {
    const { session, client, unsubscribe } = setup();
    const listener = deferred<() => void>();
    vi.mocked(client.subscribe).mockReturnValue(listener.promise);
    session.start();
    session.stop();
    listener.resolve(unsubscribe);
    await listener.promise;
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    expect(client.getTranscript).not.toHaveBeenCalled();
  });
  it("does not apply stale requests or events after a session restarts", async () => {
    const { session, client, handlers } = setup();
    const result = deferred<RuntimeTranscriptResponse>();
    vi.mocked(client.getTranscript).mockReturnValueOnce(result.promise);
    session.start();
    await vi.waitFor(() => expect(client.getTranscript).toHaveBeenCalledOnce());
    const oldHandlers = handlers();
    session.stop();
    session.start();
    await session.reload();
    result.resolve({ ...page(), title: "Stale title" });
    oldHandlers.onRuntimeTaskTitleUpdated?.({
      title: "Stale event",
      taskId: address.taskId,
      deviceId: address.deviceId,
    });
    await result.promise;
    expect(session.getSnapshot().title).toBe("Actual task");
    session.stop();
  });
  it("reloads after lost history and coalesces invalidations during an active request", async () => {
    const { session, client, handlers } = setup();
    const result = deferred<RuntimeTranscriptResponse>();
    vi.mocked(client.getTranscript).mockReturnValueOnce(result.promise);
    session.start();
    await vi.waitFor(() => expect(client.getTranscript).toHaveBeenCalledOnce());
    handlers().onHistoryInvalidated?.();
    handlers().onHistoryInvalidated?.();
    result.resolve(page());
    await session.reload();
    await vi.waitFor(() =>
      expect(client.getTranscript).toHaveBeenCalledTimes(2),
    );
    session.stop();
  });
  it.each(["reverted", "conflicted"] as const)(
    "retains %s file changes across stale history and accepts a new artifact",
    async (status) => {
      const { session, client } = setup();
      const artifact = {
        version: 1 as const,
        artifact_id: "artifact-1",
        device_id: "device",
        workspace_path: "/work",
        status: "active" as const,
        file_count: 0,
        additions: 0,
        deletions: 0,
        files: [],
      };
      const transcript = {
        ...page(),
        turns: [{ ...turn("50", 50), fileChanges: artifact }],
      };
      vi.mocked(client.getTranscript).mockResolvedValue(transcript);
      session.start();
      await session.reload();
      const message = session
        .getSnapshot()
        .messages.find((message) => message.role === "assistant")!;
      const pending = deferred<RuntimeTranscriptResponse>();
      vi.mocked(client.getTranscript).mockReturnValueOnce(pending.promise);
      const refresh = session.reload();
      session.applyFileChanges(message.subtaskId!, { ...artifact, status });
      expect(session.getSnapshot().messages.at(-1)?.fileChanges?.status).toBe(
        status,
      );
      pending.resolve(transcript);
      await refresh;
      expect(session.getSnapshot().messages.at(-1)?.fileChanges?.status).toBe(
        status,
      );
      vi.mocked(client.getTranscript).mockResolvedValue({
        ...transcript,
        turns: [
          {
            ...turn("50", 50),
            fileChanges: { ...artifact, artifact_id: "artifact-2" },
          },
        ],
      });
      await session.reload();
      expect(session.getSnapshot().messages.at(-1)?.fileChanges).toMatchObject({
        artifact_id: "artifact-2",
        status: "active",
      });
      session.stop();
    },
  );
  it("rolls back only the failed optimistic submission", async () => {
    const { session } = setup();
    session.start();
    await session.reload();
    const original = session.getSnapshot().messages;
    session.addUserMessage({
      id: "retry-1",
      role: "user",
      content: "Continue",
      status: "done",
      createdAt: "2026-09-17T00:01:00Z",
    });
    session.addUserMessage({
      id: "reply-2",
      role: "user",
      content: "Other reply",
      status: "done",
      createdAt: "2026-09-17T00:02:00Z",
    });
    session.removeUserMessage("retry-1");
    expect(session.getSnapshot().messages.map((message) => message.id)).toEqual(
      [...original.map((message) => message.id), "reply-2"],
    );
    session.stop();
  });
  it("attaches an accepted queued message to a turn that started before the send response", async () => {
    const { session, handlers } = setup();
    session.start();
    await session.reload();
    const before = new Set(
      session.getSnapshot().turns.flatMap((turn) => (turn.id ? [turn.id] : [])),
    );
    handlers().onMessageAction({
      type: "assistant_started",
      subtaskId: "new-turn",
    });
    session.acceptUserMessage(
      {
        id: "queued-reply",
        role: "user",
        content: "Follow up",
        status: "done",
        createdAt: "2026-09-17T00:01:00Z",
      },
      before,
      "new-turn",
    );
    expect(
      session.getSnapshot().turns.filter((turn) => turn.id === null),
    ).toEqual([]);
    expect(
      session.getSnapshot().turns.find((turn) => turn.id === "new-turn")
        ?.items[0],
    ).toMatchObject({ type: "user_message", message: { id: "queued-reply" } });
    expect(
      session
        .getSnapshot()
        .messages.filter((message) => message.id === "queued-reply"),
    ).toHaveLength(1);
    session.stop();
  });
  it("publishes applied guidance before history contains its turn and advances the lifecycle on settlement", async () => {
    const { session, handlers } = setup();
    session.start();
    await session.reload();
    const unsubscribe = session.subscribeGuidance((payload) =>
      session.applyGuidance(
        {
          id: payload.clientGuidanceId!,
          role: "user",
          content: payload.message,
          runtimeGuidance: true,
          status: "done",
          createdAt: new Date(payload.appliedAtMs).toISOString(),
        },
        payload.subtaskId,
      ),
    );
    handlers().onGuidanceApplied?.({
      guidanceId: "guidance-1",
      clientGuidanceId: "queued-guide",
      subtaskId: "not-loaded-yet",
      message: "Use this constraint",
      appliedAtMs: 1,
    });
    expect(
      session
        .getSnapshot()
        .messages.find((message) => message.id === "queued-guide"),
    ).toMatchObject({
      role: "user",
      runtimeGuidance: true,
      content: "Use this constraint",
    });
    const revision = session.getSnapshot().lifecycleRevision;
    handlers().onAssistantSettled?.("not-loaded-yet", "succeeded");
    expect(session.getSnapshot().lifecycleRevision).toBe(revision + 1);
    await session.reload();
    expect(
      session
        .getSnapshot()
        .messages.filter((message) => message.id === "queued-guide"),
    ).toHaveLength(1);
    unsubscribe();
    session.stop();
  });
});
