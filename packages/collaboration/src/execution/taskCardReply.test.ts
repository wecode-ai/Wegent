import { describe, expect, it, vi } from "vitest";
import type { ProjectChatClient, ProjectChatMessage } from "@wegent/chat-core";
import {
  cardSessionActive,
  cardSessionAddress,
  dispatchTaskCardReply,
} from "./taskCardReply";

const address = {
  deviceId: "device-1",
  taskId: "original-session",
  runtime: "codex",
};
const root = {
  messageId: "root",
  content: "Work",
  metadata: {},
  sender: { type: "user", id: "1", name: "Me" },
} as ProjectChatMessage;
const run = {
  ...root,
  messageId: "run",
  runtimeAddress: address,
  sender: { type: "agent", id: "agent", name: "AI" },
} as ProjectChatMessage;
const trigger = { ...root, messageId: "reply", content: "Continue" };
function setup() {
  const client = {
    send: vi.fn().mockResolvedValue(trigger),
    startAgentResponse: vi.fn().mockResolvedValue(run),
    failAgentResponse: vi.fn().mockResolvedValue({ ...run, status: "failed" }),
    continueWegentTask: vi.fn().mockResolvedValue(run),
  } as unknown as ProjectChatClient;
  const runtime = {
    createProjectRuntimeTask: vi.fn().mockResolvedValue(false),
    sendRuntimePaneMessage: vi.fn().mockResolvedValue(true),
  };
  const input = {
    client,
    runtime,
    project: {
      id: "project",
      name: "Project",
      project_key: "P",
      project_store: "backend" as const,
      task_provider: "local",
      provider_config: {},
    },
    task: { id: "issue", title: "Issue", status: "in_progress" },
    services: {},
    card: { root, replies: [run] },
    reply: {
      id: "queued-id",
      content: "Continue",
      createdAt: "",
      status: "queued" as const,
    },
    agent: { id: "agent", name: "AI", runtime: "codex" },
    messages: [root, run],
    onError: vi.fn(),
    onMessages: vi.fn(),
    sendFailedText: "Send failed",
    startFailedText: "Start failed",
  };
  return { input, client, runtime };
}
describe("shared PC card reply dispatch", () => {
  it("continues a local session without enqueue mentions even without self-managed mode", async () => {
    const { input, client, runtime } = setup();
    const result = await dispatchTaskCardReply({
      ...input,
      project: { ...input.project, project_store: "local" },
    });
    expect(result.ok).toBe(true);
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        mentions: [],
        replyToMessageId: "root",
      }),
    );
    expect(runtime.sendRuntimePaneMessage).toHaveBeenCalledOnce();
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled();
  });

  it("does not start another task when a local AI session no longer exists", async () => {
    const { input, runtime } = setup();
    runtime.sendRuntimePaneMessage.mockImplementationOnce(
      async (_request, options) => {
        options?.onError?.("Session not found");
        return false;
      },
    );
    expect(
      await dispatchTaskCardReply({
        ...input,
        project: { ...input.project, project_store: "local" },
      }),
    ).toEqual({ ok: false, persisted: true, error: "Session not found" });
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled();
  });
  it("rejects a local AI reply without its session instead of creating a replacement", async () => {
    const { input, runtime } = setup();
    const result = await dispatchTaskCardReply({
      ...input,
      project: { ...input.project, project_store: "local" },
      card: { root, replies: [{ ...run, runtimeAddress: undefined }] },
    });
    expect(result).toEqual({
      ok: false,
      persisted: true,
      error: "Start failed",
    });
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled();
  });
  it("saves a discussion reply without invoking the assigned AI", async () => {
    const { input, client, runtime } = setup();
    client.executeTaskComment = vi.fn();
    expect(
      await dispatchTaskCardReply({ ...input, card: { root, replies: [] } }),
    ).toEqual({ ok: true, persisted: true });
    expect(client.executeTaskComment).not.toHaveBeenCalled();
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled();
  });
  it("reports a cloud continuation that returned no execution", async () => {
    const { input, client } = setup();
    client.executeTaskComment = vi.fn().mockResolvedValue([]);
    expect(await dispatchTaskCardReply(input)).toEqual({
      ok: false,
      persisted: true,
      error: "Start failed",
    });
  });
  it("uses live session state instead of a historical terminal turn", () => {
    expect(
      cardSessionActive(
        {
          root,
          replies: [{ ...run, status: "completed" }],
        },
        () => true,
      ),
    ).toBe(true);
  });
  it("keeps a newly persisted active execution busy", () => {
    expect(
      cardSessionActive(
        {
          root,
          replies: [{ ...run, status: "streaming" }],
        },
        () => true,
      ),
    ).toBe(true);
  });
  it("continues the activity-owned session even when no runtime-work snapshot is available", async () => {
    const { input, client, runtime } = setup();
    const sessionAddress = {
      ...address,
      workspacePath: "/workspace",
      runtimeHandle: {
        modelSelection: {
          modelName: "bound-model",
          modelType: "runtime",
          options: { reasoning: "high" },
        },
      },
    };
    expect(cardSessionAddress(input.card)).toEqual(address);
    expect(await dispatchTaskCardReply({ ...input, sessionAddress })).toEqual({
      ok: true,
      persisted: true,
    });
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        clientMessageId: "queued-id",
        replyToMessageId: "root",
        text: "Continue",
      }),
    );
    expect(runtime.sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address: sessionAddress,
        message: "Continue",
        queueIfBusy: true,
      }),
      expect.anything(),
    );
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled();
  });
  it("records a continued turn on the existing local runtime session", async () => {
    const { input, client, runtime } = setup();
    expect(
      await dispatchTaskCardReply({
        ...input,
        project: { ...input.project, project_store: "local" },
      }),
    ).toEqual({ ok: true, persisted: true });
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: [] }),
    );
    expect(client.startAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeDeviceId: address.deviceId,
        runtimeTaskId: address.taskId,
      }),
    );
    expect(runtime.sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        address,
        message: "Continue",
      }),
      expect.anything(),
    );
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled();
  });
  it("reports a missing agent root session instead of silently saving an AI reply", async () => {
    const { input, runtime, client } = setup();
    const result = await dispatchTaskCardReply({
      ...input,
      card: { root: { ...run, runtimeAddress: undefined }, replies: [] },
    });
    expect(result).toEqual({
      ok: false,
      persisted: true,
      error: "Start failed",
    });
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: [] }),
    );
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled();
    expect(runtime.sendRuntimePaneMessage).not.toHaveBeenCalled();
  });
  it("reports whether the reply was saved when the runtime rejects continuation", async () => {
    const { input, runtime, client } = setup();
    runtime.sendRuntimePaneMessage.mockImplementationOnce(
      async (_request, options) => {
        options?.onError?.("Device offline");
        return false;
      },
    );
    expect(await dispatchTaskCardReply(input)).toEqual({
      ok: false,
      persisted: true,
      error: "Device offline",
    });
    expect(client.failAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Device offline" }),
    );
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled();
  });
  it("uses the Wegent continuation operation for a Wegent agent", async () => {
    const { input, client, runtime } = setup();
    expect(
      await dispatchTaskCardReply({
        ...input,
        agent: { ...input.agent, runtime: "wegent" },
      }),
    ).toEqual({ ok: true, persisted: true });
    expect(client.continueWegentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerMessageId: trigger.messageId,
        agentId: "agent",
      }),
    );
    expect(runtime.sendRuntimePaneMessage).not.toHaveBeenCalled();
  });
});

describe("project-authorized comment dispatch", () => {
  it("queues a local reply once against its saved session with device attachments", async () => {
    const { input, client, runtime } = setup();
    client.executeTaskComment = vi.fn().mockResolvedValue([run]);
    const attachment = {
      id: -1,
      filename: "evidence.txt",
      local_path: "C:\\Evidence\\evidence.txt",
    };
    expect(
      await dispatchTaskCardReply({
        ...input,
        project: { ...input.project, project_store: "local" },
        agent: {
          id: "reassigned-agent",
          name: "Another AI",
          runtime: "claude",
        },
        reply: { ...input.reply, attachments: [attachment as never] },
      }),
    ).toEqual({ ok: true, persisted: true });
    expect(client.executeTaskComment).toHaveBeenCalledOnce();
    expect(client.executeTaskComment).toHaveBeenCalledWith({
      projectId: "project",
      taskId: "issue",
      triggerMessageId: trigger.messageId,
      attachmentIds: [],
      attachments: [attachment],
    });
    expect(client.startAgentResponse).not.toHaveBeenCalled();
    expect(runtime.sendRuntimePaneMessage).not.toHaveBeenCalled();
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled();
  });
  it("continues the server-owned thread without a visible assigned agent or personal runtime", async () => {
    const { input, client, runtime } = setup();
    client.executeTaskComment = vi.fn().mockResolvedValue([run]);
    expect(await dispatchTaskCardReply({ ...input, agent: undefined })).toEqual(
      { ok: true, persisted: true },
    );
    expect(client.executeTaskComment).toHaveBeenCalledWith({
      projectId: "project",
      taskId: "issue",
      triggerMessageId: "reply",
      attachmentIds: [],
    });
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: [] }),
    );
    expect(client.startAgentResponse).not.toHaveBeenCalled();
    expect(runtime.sendRuntimePaneMessage).not.toHaveBeenCalled();
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled();
  });
  it("reports a saved reply whose server execution was rejected", async () => {
    const { input, client, runtime } = setup();
    client.executeTaskComment = vi
      .fn()
      .mockRejectedValue(new Error("Device offline"));
    expect(await dispatchTaskCardReply({ ...input, agent: undefined })).toEqual(
      { ok: false, persisted: true, error: "Device offline" },
    );
    expect(input.onError).toHaveBeenCalledWith("Device offline");
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled();
  });
  it("uses the thread agent after reassignment for a local project", async () => {
    const { input, client } = setup();
    await dispatchTaskCardReply({
      ...input,
      project: { ...input.project, project_store: "local" },
      agent: { id: "new-agent", name: "New" },
    });
    expect(client.startAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent" }),
    );
  });
});
