// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectChatClient, ProjectChatMessage } from "@wegent/chat-core";
import { createCollaborationTranslator } from "../i18n";
import { groupIssueActivityThreads } from "./IssueActivityThread";
import { IssueProjectChatThread } from "./IssueProjectChatThread";
import { IssueActivityMarkdown } from "./IssueActivityMarkdown";
import { IssueChatMessage } from "./IssueChatMessage";
import {
  backendTaskExecution,
  resolveMessageRunStatus,
} from "./activityMessageUtils";
import {
  mergeIssueChatMessages,
  useIssueProjectChat,
} from "./useIssueProjectChat";

const translate = createCollaborationTranslator("zh-CN");
const message: ProjectChatMessage = {
  messageId: "root",
  projectId: "project",
  taskId: "issue",
  sequenceNumber: 1,
  sender: { type: "agent", id: "bot", name: "Codex" },
  type: "text",
  content: "Run `pwd`\n\n3. **Check** the output\n4. Done",
  metadata: { run_status: "succeeded" },
  status: "completed",
  createdAt: "2026-09-17T00:00:00Z",
  updatedAt: "2026-09-17T00:00:00Z",
};

describe("shared Issue threads", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom has no text-range geometry; ProseMirror reads it when restoring selection.
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("groups shuffled events under the actual root and keeps replies chronological", () => {
    const reply = {
      ...message,
      messageId: "reply",
      rootMessageId: "root",
      sequenceNumber: 2,
    };
    const latest = { ...message, messageId: "latest", sequenceNumber: 3 };
    expect(groupIssueActivityThreads([reply, latest, message])).toEqual([
      { root: message, replies: [reply] },
      { root: latest, replies: [] },
    ]);
  });

  it("renders Markdown, bot avatar, reply row and separate execution events in the same thread", () => {
    act(() =>
      root.render(
        <IssueProjectChatThread
          thread={{ root: message, replies: [] }}
          canComment
          send={vi.fn()}
          translate={translate}
          executions={[]}
        />,
      ),
    );
    const card = container.querySelector(".task-detail-comment-card")!;
    expect(card.querySelector("code")?.textContent).toBe("pwd");
    expect(card.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(card.querySelector("strong")?.textContent).toBe("Check");
    expect(
      card.querySelector(".task-detail-thread-message-header .bg-text-primary"),
    ).not.toBeNull();
    expect(
      card.querySelector(".task-detail-comment-inline-composer"),
    ).not.toBeNull();
    expect(card.querySelector(".task-detail-run-events")).toBeNull();
    expect(
      container.querySelector(".task-detail-run-events")?.textContent,
    ).toContain("1 条运行动态");
    expect(
      container.querySelector(".task-detail-run-event")?.textContent,
    ).toContain("已完成");
  });

  it("keeps a failed reply draft and submits with the real root id", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(message);
    await act(async () =>
      root.render(
        <IssueProjectChatThread
          thread={{ root: message, replies: [] }}
          canComment
          send={send}
          translate={translate}
          executions={[]}
        />,
      ),
    );
    const input = container.querySelector<HTMLElement>(
      '[data-testid="collaboration-chat-reply-input-root"]',
    )!;
    act(() => {
      (input as HTMLElement & { value: string }).value = "Please check";
      input.dispatchEvent(
        new KeyboardEvent("keyup", { key: "k", bubbles: true }),
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".task-detail-comment-send")!
        .click();
    });
    expect(send).toHaveBeenCalledWith("Please check", "root");
    expect(input.value).toBe("Please check");
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "offline",
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".task-detail-comment-send")!
        .click();
    });
    expect(input.value).toBe("");
  });

  it("does not offer reply actions to read-only viewers", () => {
    act(() =>
      root.render(
        <IssueProjectChatThread
          thread={{ root: message, replies: [] }}
          canComment={false}
          send={vi.fn()}
          translate={translate}
          executions={[]}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="collaboration-chat-reply-input-root"]'),
    ).toBeNull();
  });

  it("uses the desktop run disclosure and execution action for web messages", () => {
    const open = vi.fn();
    act(() =>
      root.render(
        <IssueChatMessage
          message={{
            ...message,
            metadata: { run_id: "run-123", model: "test-model" },
          }}
          mine={false}
          compact
          plain
          eventOnly
          translate={translate}
          onOpenUrl={vi.fn()}
          onOpenExecution={open}
        />,
      ),
    );
    const badge = container.querySelector<HTMLButtonElement>(
      '[data-testid="cloud-task-activity-execution-badge-root"]',
    )!;
    expect(badge.dataset.status).toBe("succeeded");
    expect(badge.textContent).toContain("已完成");
    expect(badge.textContent).toContain("查看执行");
    act(() => badge.click());
    expect(open).toHaveBeenCalledOnce();
    expect(container.querySelector("details")?.textContent).toContain(
      "Run run-123",
    );
    expect(container.querySelector("details")?.textContent).toContain(
      "test-model",
    );
  });

  it("preserves terminal message status and distinguishes backend Task IDs from execution IDs", () => {
    expect(
      resolveMessageRunStatus(
        { project_chat_message_id: "root", status: "running" },
        {
          ...message,
          metadata: { run_status: "running" },
        },
      ),
    ).toBe("completed");
    expect(
      backendTaskExecution({
        ...message,
        metadata: {
          execution_id: 92,
          execution_url: "https://example.com/task/7",
        },
      }),
    ).toBeNull();
    expect(
      backendTaskExecution({
        ...message,
        metadata: { backend_task_id: 7, execution_url: "javascript:alert(1)" },
      }),
    ).toBeNull();
    expect(
      backendTaskExecution({
        ...message,
        metadata: {
          backend_task_id: 7,
          execution_url: "https://example.com/task/7",
        },
      }),
    ).toEqual({ taskId: "7", executionUrl: "https://example.com/task/7" });
  });

  it("opens stored attachments through the host instead of navigating to a custom URL", () => {
    const open = vi.fn();
    act(() =>
      root.render(
        <IssueActivityMarkdown
          content="[Report.pdf](wegent://attachments/file-1)"
          onOpenAttachment={open}
        />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(open).toHaveBeenCalledWith("file-1", "Report.pdf");
    expect(container.querySelector("a")).toBeNull();
  });

  it("does not let an old snapshot replace a completed live update", () => {
    const completed = {
      ...message,
      updatedAt: "2026-09-17T00:01:00Z",
      content: "Completed",
    };
    expect(mergeIssueChatMessages([completed], [message])).toEqual([completed]);
  });

  it("ignores a late subscription from an Issue that was closed", async () => {
    let resolveFirst!: (
      value: Awaited<ReturnType<ProjectChatClient["subscribe"]>>,
    ) => void;
    const unsubscribe = vi.fn();
    const client = {
      subscribe: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValueOnce({
          snapshot: { messages: [], latestSequence: 0, currentUserId: "1" },
          unsubscribe: vi.fn(),
        }),
    } as unknown as ProjectChatClient;
    function Harness({ issueId }: { issueId: string }) {
      const chat = useIssueProjectChat(client, "project", issueId);
      return <span>{chat.messages.map((item) => item.content).join("")}</span>;
    }
    await act(async () => root.render(<Harness issueId="first" />));
    await act(async () => root.render(<Harness issueId="second" />));
    await act(async () =>
      resolveFirst({
        snapshot: {
          messages: [message],
          latestSequence: 1,
          currentUserId: "1",
        },
        unsubscribe,
      }),
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("");
  });
});
