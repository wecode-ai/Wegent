import type { WorkbenchMessage } from "@wegent/chat-core/runtime-conversation";
import type { WorkspaceProjectManagerRun } from "../ports/SharedWorkspaceApi";

export function projectManagerFallbackMessages(
  runs: WorkspaceProjectManagerRun[],
  locale: "zh-CN" | "en",
): WorkbenchMessage[] {
  const messages: WorkbenchMessage[] = [];
  for (const run of runs) {
    if (run.instruction) {
      messages.push({
        id: `project-ai-user-${run.id}`,
        role: "user",
        content: run.instruction,
        status: "done",
        createdAt: run.createdAt ?? "",
      });
    }
    const waiting = run.status === "queued" || run.status === "pending";
    messages.push({
      id: `project-ai-assistant-${run.id}`,
      role: "assistant",
      content:
        run.response ??
        (run.status === "failed"
          ? `${locale === "zh-CN" ? "运行失败" : "Run failed"}: ${run.error ?? ""}`
          : ""),
      status:
        run.status === "failed"
          ? "failed"
          : waiting || run.status === "running"
            ? "streaming"
            : "done",
      streamingThinkingContent: waiting
        ? locale === "zh-CN"
          ? "等待执行器启动…"
          : "Waiting for executor…"
        : undefined,
      createdAt: run.createdAt ?? "",
    });
  }
  return messages;
}

export function projectManagerConversationMessages(
  messages: WorkbenchMessage[],
  run: WorkspaceProjectManagerRun | undefined,
): WorkbenchMessage[] {
  if (!run || !["failed", "cancelled"].includes(run.status)) return messages;

  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }

  if (assistantIndex >= 0) {
    return messages.map((message, index) =>
      index === assistantIndex
        ? {
            ...message,
            content:
              run.status === "failed"
                ? run.error || message.content
                : message.content,
            status: run.status === "failed" ? "failed" : "done",
            runtimeStatus: run.status === "cancelled" ? "cancelled" : "failed",
            stoppedNotice: run.status === "cancelled",
            streamingThinkingContent: undefined,
            completedAt: run.completedAt ?? message.completedAt,
          }
        : message,
    );
  }

  return [
    ...messages,
    {
      id: `project-ai-assistant-${run.id}`,
      role: "assistant",
      content: run.status === "failed" ? (run.error ?? "") : "",
      status: run.status === "failed" ? "failed" : "done",
      runtimeStatus: run.status === "cancelled" ? "cancelled" : "failed",
      stoppedNotice: run.status === "cancelled",
      createdAt: run.createdAt ?? "",
      completedAt: run.completedAt,
    },
  ];
}
