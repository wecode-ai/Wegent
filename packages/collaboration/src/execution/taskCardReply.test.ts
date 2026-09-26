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
  it("treats a persisted terminal execution as idle even while liveness is stale", () => {
    expect(
      cardSessionActive(
        {
          root,
          replies: [{ ...run, status: "completed" }],
        },
        () => true,
      ),
    ).toBe(false);
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
    expect(cardSessionAddress(input.card)).toEqual(address);
    expect(await dispatchTaskCardReply(input)).toEqual({
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
        address: { deviceId: "device-1", taskId: "original-session" },
        message: "Continue",
      }),
      expect.anything(),
    );
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled();
  });
  it("continues a self-managed local card without enqueueing through an agent mention", async () => {
    const { input, client, runtime } = setup();
    expect(
      await dispatchTaskCardReply({
        ...input,
        selfManagedExecution: true,
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
        address: { deviceId: address.deviceId, taskId: address.taskId },
        message: "Continue",
      }),
      expect.anything(),
    );
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled();
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
