import { describe, expect, it, vi } from "vitest";
import {
  buildLocalRuntimeExecutionRequest,
  createRuntimeExecutionIdsFromSeed,
  createRuntimeTurnSeed,
  type LocalRuntimeExecutionInput,
} from "./local-runtime-execution";

const input: LocalRuntimeExecutionInput = {
  runtime: "codex",
  title: "Implement the mobile runtime",
  message: "Continue the implementation",
  turnSeed: 42,
  localDeviceId: "phone-installation",
  workspacePath: "/root/projects/app",
  workspaceSource: "local_path",
  newSession: true,
  user: { id: 17, user_name: "developer", email: "developer@example.com" },
  modelConfig: {
    runtime_config: { codex: { use_user_config: true, configured: true } },
  },
  reasoningConfig: null,
};

describe("local executor request contract", () => {
  it("separates same-millisecond continuations with the shared PC turn seed", () => {
    vi.spyOn(Date, "now").mockReturnValue(1794657600000);
    vi.spyOn(Math, "random").mockReturnValueOnce(0.1).mockReturnValueOnce(0.2);
    try {
      const requests = [0, 1].map(() =>
        buildLocalRuntimeExecutionRequest({
          ...input,
          taskId: "same-millisecond-conversation",
          newSession: false,
          turnSeed: createRuntimeTurnSeed(),
        }),
      );
      expect(requests[0].task_id).toBe(requests[1].task_id);
      expect(requests[0].subtask_id).not.toBe(requests[1].subtask_id);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps task identity stable while assigning each continuation its own execution", () => {
    expect(createRuntimeExecutionIdsFromSeed("abc")).toEqual([
      "runtime-96355",
      "runtime-96355-0",
    ]);
    const first = buildLocalRuntimeExecutionRequest({
      ...input,
      taskId: "conversation",
    });
    const followup = buildLocalRuntimeExecutionRequest({
      ...input,
      taskId: "conversation",
      newSession: false,
    });
    const next = buildLocalRuntimeExecutionRequest({
      ...input,
      taskId: "conversation",
      newSession: false,
      turnSeed: 43,
    });
    expect([first.task_id, followup.task_id, next.task_id]).toEqual([
      "conversation",
      "conversation",
      "conversation",
    ]);
    expect(
      new Set([first.subtask_id, followup.subtask_id, next.subtask_id]).size,
    ).toBe(3);
  });

  it("preserves cloud model credentials, workspace ownership and permissions on local execution", () => {
    const modelConfig = {
      model_id: "configured-cloud-model",
      base_url: "https://wegent.example/api/runtime-work/llm-responses-proxy",
      api_key: "test-token",
      default_headers: { "X-Wegent-Model-Namespace": "team" },
    };
    const origin = {
      type: "board_comment" as const,
      cloudProjectId: "project-1",
      loopItemId: "issue-2",
      rootCommentId: "comment-3",
      projectStore: "backend",
    };
    const result = buildLocalRuntimeExecutionRequest({
      ...input,
      modelConfig,
      modelOptions: {
        permissionMode: "workspace-write",
        collaborationMode: "plan",
      },
      reasoningConfig: { effort: "xhigh" },
      cloudModelGateway: {
        backendUrl: "https://wegent.example",
        apiKey: "test-token",
      },
      cloudProjectId: "project-1",
      executionDeviceId: "project-device-route",
      workspaceSource: "git_worktree",
      branch: "feature/mobile",
      origin,
      clientUserMessageId: "user-message-4",
    });
    expect(result).toMatchObject({
      user_id: 17,
      user_name: "developer",
      backend_url: "https://wegent.example",
      auth_token: "test-token",
      execution_target_type: "local",
      device_id: "phone-installation",
      execution_device_id: "project-device-route",
      workspace: {
        project: {
          source: "git_worktree",
          path: "/root/projects/app",
          branch: "feature/mobile",
        },
      },
      workspace_source: "git_worktree",
      project_workspace_path: "/root/projects/app",
      client_user_message_id: "user-message-4",
      collaborationMode: "plan",
      reasoning_config: { effort: "xhigh" },
      runtime_permission_profile: ":workspace",
    });
    expect(result.origin).toBe(origin);
    expect(result.model_config).toBe(modelConfig);
    expect(modelConfig).not.toHaveProperty("proxy");
  });

  it("keeps native Codex authentication independent of cloud gateway configuration", () => {
    const result = buildLocalRuntimeExecutionRequest({
      ...input,
      modelOptions: { permissionMode: "read-only" },
    });
    expect(result.model_config).toBe(input.modelConfig);
    expect(result).not.toHaveProperty("backend_url");
    expect(result).not.toHaveProperty("auth_token");
    expect(result.runtime_permission_profile).toBe(":read-only");
    expect(result.bot).toEqual([{ id: 0, shell_type: "Codex" }]);
  });

  it("keeps attachment metadata and passes typed context separately from user input", () => {
    const skill = {
      name: "workspace-tools",
      namespace: "team",
      is_public: false,
    };
    const result = buildLocalRuntimeExecutionRequest({
      ...input,
      additionalSkills: [skill, skill],
      additionalContext: {
        project: { kind: "application", value: "Trusted project instructions" },
        externalDocument: {
          kind: "untrusted",
          value: "Untrusted document contents",
        },
        dingtalkAITableProject: {
          kind: "application",
          value: "Use the configured table",
        },
      },
      attachments: [
        {
          id: 0,
          filename: "input.txt",
          file_size: 12,
          mime_type: "text/plain",
          status: "ready",
          file_extension: "txt",
          created_at: "2026-11-14T00:00:00Z",
          local_path: "/root/projects/app/input.txt",
          text_length: 12,
          text_preview: "Input text",
        },
      ],
    });
    expect(result.prompt).toBe(input.message);
    expect(result.additionalContext).toEqual({
      project: { kind: "application", value: "Trusted project instructions" },
      externalDocument: {
        kind: "untrusted",
        value: "Untrusted document contents",
      },
      dingtalkAITableProject: {
        kind: "application",
        value: "Use the configured table",
      },
    });
    expect(result.skill_names).toEqual(["workspace-tools", "dws"]);
    expect(result.preload_skills).toEqual([skill, skill, "dws"]);
    expect(result.attachments).toEqual([
      expect.objectContaining({
        id: 0,
        filename: "input.txt",
        local_path: "/root/projects/app/input.txt",
        subtask_id: result.subtask_id,
        text_length: 12,
        text_preview: "Input text",
      }),
    ]);
  });
  it.each([true, false])(
    "keeps Codex input separate on newSession=%s",
    (newSession) => {
      const additionalContext = {
        cloudCollaboration: {
          kind: "application" as const,
          value: "Current project reference",
        },
        selectedCode: { kind: "untrusted" as const, value: "Quoted source" },
      };
      const result = buildLocalRuntimeExecutionRequest({
        ...input,
        newSession,
        additionalContext,
      });
      expect(result.prompt).toBe(input.message);
      expect(result.additionalContext).toEqual(additionalContext);
    },
  );

  it("preserves Claude-specific context delivery", () => {
    const result = buildLocalRuntimeExecutionRequest({
      ...input,
      runtime: "claude_code",
      additionalContext: {
        project: { kind: "application", value: "Claude project reference" },
      },
    });
    expect(result.prompt).toContain("[project]\nClaude project reference");
    expect(String(result.prompt).endsWith(input.message)).toBe(true);
  });
});
