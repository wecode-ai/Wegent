// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowUp, Bot, ChevronUp, ExternalLink, X } from "lucide-react";
import type {
  SharedWorkspaceApi,
  WorkspaceProjectManagerModelSelection,
  WorkspaceProjectManagerConfig,
  WorkspaceProjectManagerRun,
} from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAgent,
  CollaborationIssue,
  CollaborationProject,
} from "../types";
import { ComposerTextInput, ProjectComposerBody } from "../composer";
import type { ComposerInputHandle } from "../composer/composerInputTypes";
import { DEFAULT_PROJECT_MANAGER_PROMPT } from "./projectManagerDefaults";

const labels = {
  "zh-CN": {
    title: "项目 AI",
    placeholder: "问项目 AI，或让它管理 Issue…",
    send: "发送",
    close: "关闭对话",
    unavailable: "先在项目设置中选择管理者智能体",
    disabled: "项目 AI 已关闭，可在项目设置中开启",
    empty: "在下方输入，和项目 AI 对话",
    waiting: "项目 AI 正在处理…",
    waitingExecutor: "等待执行器启动…",
    failed: "运行失败",
    cancelled: "任务已取消",
    openTask: "完整任务",
  },
  en: {
    title: "Project AI",
    placeholder: "Ask project AI or manage Issues…",
    send: "Send",
    close: "Close conversation",
    unavailable: "Choose a manager Agent in project settings",
    disabled: "Project AI is off. Enable it in project settings",
    empty: "Type below to talk to project AI",
    waiting: "Project AI is working…",
    waitingExecutor: "Waiting for executor…",
    failed: "Run failed",
    cancelled: "Task cancelled",
    openTask: "Full task",
  },
};

export function ProjectAiBoardAssistant({
  api,
  project,
  issues,
  agents,
  locale,
  onOpenSettings,
  onOpenIssue,
  onOpenTask,
  renderComposer,
  renderConversation,
}: {
  api: SharedWorkspaceApi;
  project: CollaborationProject;
  issues: CollaborationIssue[];
  agents: CollaborationAgent[];
  locale: "zh-CN" | "en";
  onOpenSettings(): void;
  onOpenIssue(issue: CollaborationIssue): void;
  onOpenTask?(run: WorkspaceProjectManagerRun): void;
  renderComposer?(props: {
    project: CollaborationProject;
    issues: CollaborationIssue[];
    value: string;
    onChange(value: string): void;
    onSubmit(
      value: string,
      modelSelection?: WorkspaceProjectManagerModelSelection,
    ): void;
    disabled: boolean;
    busy: boolean;
    placeholder: string;
  }): ReactNode;
  renderConversation?(props: {
    runs: WorkspaceProjectManagerRun[];
    issues: CollaborationIssue[];
    locale: "zh-CN" | "en";
    onOpenIssue(issue: CollaborationIssue): void;
    onOpenTask?(run: WorkspaceProjectManagerRun): void;
  }): ReactNode;
}) {
  const manager = api.projectManager;
  const copy = labels[locale];
  const canManage =
    project.access_role === "Owner" || project.access_role === "Maintainer";
  const candidate =
    agents.find(
      (agent) =>
        agent.status !== "archived" &&
        (project.project_store === "local" || agent.runtime === "wegent") &&
        (project.project_store !== "local" ||
          agent.agent_id === "current-device-agent"),
    ) ??
    agents.find(
      (agent) =>
        agent.status !== "archived" &&
        (project.project_store === "local" || agent.runtime === "wegent"),
    );
  const [config, setConfig] = useState<WorkspaceProjectManagerConfig | null>(
    null,
  );
  const [runs, setRuns] = useState<WorkspaceProjectManagerRun[]>([]);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const bootstrapping = useRef(new Set<string>());
  const composer = useRef<ComposerInputHandle>(null);
  const responses = useRef(new Map<string, WorkspaceProjectManagerRun>());
  const sentInstructions = useRef(new Map<string, string>());

  useEffect(() => {
    setConfig(null);
    setRuns([]);
    setMessage("");
    setOpen(false);
    setPinned(false);
    setError("");
    responses.current.clear();
    sentInstructions.current.clear();
  }, [project.id]);

  useEffect(() => {
    if (open && !renderComposer) composer.current?.focus();
  }, [open, renderComposer]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (
        root.current &&
        !root.current.contains(event.target as Node) &&
        !pinned
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("click", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("click", onPointerDown);
    };
  }, [pinned]);

  useEffect(
    () => () => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const onHover = (inside: boolean) => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    if (pinned) return;
    if (inside && !open)
      hoverTimer.current = window.setTimeout(() => setOpen(true), 400);
    if (!inside && open)
      closeTimer.current = window.setTimeout(() => setOpen(false), 1500);
  };

  const refresh = useCallback(async () => {
    if (!manager) return;
    const listed = await manager.listRuns(project.id);
    const manual = listed
      .filter((run) => run.trigger === "manual")
      .slice(0, 20);
    const detailed = await Promise.all(
      manual.map(async (run) => {
        if (run.response || run.status !== "succeeded") return run;
        const cached = responses.current.get(run.id);
        if (cached) return cached;
        const detail = await manager.getRun(project.id, run.id);
        responses.current.set(run.id, detail);
        return detail;
      }),
    );
    setRuns(
      detailed.reverse().map((run) => ({
        ...run,
        instruction: run.instruction || sentInstructions.current.get(run.id),
      })),
    );
  }, [manager, project.id]);

  useEffect(() => {
    if (!manager) return;
    let cancelled = false;
    void manager
      .get(project.id)
      .then(async (current) => {
        if (cancelled) return;
        if (
          canManage &&
          candidate &&
          !bootstrapping.current.has(project.id) &&
          !current.enabled &&
          !current.agentId &&
          !current.prompt
        ) {
          bootstrapping.current.add(project.id);
          try {
            current = await manager.save(project.id, {
              version: current.version,
              enabled: true,
              agentId: candidate.id,
              prompt: DEFAULT_PROJECT_MANAGER_PROMPT,
              triggers: current.triggers,
            });
          } finally {
            bootstrapping.current.delete(project.id);
          }
        }
        if (!cancelled) setConfig(current);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [manager, project.id, canManage, candidate?.id]);

  useEffect(() => {
    if (!open) return;
    void refresh().catch((cause) => setError(String(cause)));
    const timer = window.setInterval(() => {
      void refresh().catch((cause) => setError(String(cause)));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  const send = async (
    value: string,
    modelSelection?: WorkspaceProjectManagerModelSelection,
  ) => {
    if (!manager || !config?.enabled || !value.trim() || busy) return;
    setBusy(true);
    setError("");
    setOpen(true);
    setPinned(true);
    try {
      const run = await manager.run(project.id, value.trim(), modelSelection);
      sentInstructions.current.set(run.id, value.trim());
      setRuns((previous) => [
        ...previous,
        { ...run, instruction: value.trim() },
      ]);
      setMessage("");
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!manager) return null;
  const hint = config?.enabled
    ? ""
    : config?.agentId
      ? copy.disabled
      : copy.unavailable;
  const hasConversation = runs.length > 0 || Boolean(hint);
  const closeConversation = () => {
    setPinned(false);
    setOpen(false);
  };
  return (
    <div
      ref={root}
      className="pointer-events-none absolute bottom-4 left-4 right-4 z-20 mx-auto flex max-w-3xl justify-center"
      data-testid="project-ai-board-assistant"
      data-pinned={pinned}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <div
        className={`pointer-events-auto overflow-hidden text-text-primary transition-[width,max-height,opacity,transform] duration-200 ease-out ${open ? "w-full max-h-[min(68vh,46rem)]" : "w-28 max-h-10"}`}
      >
        {!open ? (
          <button
            type="button"
            data-testid="project-ai-expand"
            aria-expanded="false"
            className="flex h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-full border border-border bg-background text-sm shadow-sm hover:shadow-md"
            onClick={() => setOpen(true)}
          >
            <Bot className="h-4 w-4" aria-hidden="true" />
            {copy.title}
            <ChevronUp className="h-3 w-3" aria-hidden="true" />
          </button>
        ) : (
          <section
            data-testid="project-ai-conversation"
            className="flex max-h-[min(68vh,46rem)] flex-col gap-2"
          >
            {hasConversation && <div className="overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
              <div className="flex h-11 items-center gap-2 border-b border-border px-4 text-sm">
                <Bot className="h-4 w-4" aria-hidden="true" />
                <span className="flex-1 font-medium">{copy.title}</span>
                <button
                  type="button"
                  data-testid="project-ai-open-current-task"
                  aria-label={copy.openTask}
                  title={copy.openTask}
                  disabled={
                    !onOpenTask ||
                    !runs.some(
                      (run) =>
                        run.executionUrl ||
                        (run.runtimeTaskId && run.runtimeDeviceId),
                    )
                  }
                  onClick={() => {
                    const run = [...runs]
                      .reverse()
                      .find(
                        (item) =>
                          item.executionUrl ||
                          (item.runtimeTaskId && item.runtimeDeviceId),
                      );
                    if (run) onOpenTask?.(run);
                  }}
                  className="rounded-lg p-1.5 hover:bg-muted disabled:opacity-35"
                >
                  <ExternalLink className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  data-testid="project-ai-close-conversation"
                  aria-label={copy.close}
                  onClick={closeConversation}
                  className="rounded-lg p-1.5 hover:bg-muted"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {runs.length > 0 && (
                <div
                  className="max-h-72"
                  data-testid="project-ai-conversation-messages"
                  aria-live="polite"
                >
                  {renderConversation?.({
                    runs,
                    issues,
                    locale,
                    onOpenIssue,
                    onOpenTask,
                  }) ?? (
                    <div className="max-h-72 space-y-3 overflow-y-auto px-4 py-3 text-sm">
                      {runs.map((run) => (
                        <div key={run.id}>
                          {run.instruction && (
                            <p className="ml-auto w-fit max-w-[85%] rounded-2xl bg-muted px-3 py-2">
                              {run.instruction}
                            </p>
                          )}
                          <p
                            data-testid={`project-ai-response-${run.id}`}
                            className="whitespace-pre-wrap py-2"
                          >
                            {run.response ||
                              (run.status === "failed"
                                ? `${copy.failed}: ${run.error ?? ""}`
                                : run.status === "cancelled"
                                  ? copy.cancelled
                                  : run.status === "queued" || run.status === "pending"
                                    ? copy.waitingExecutor
                                    : copy.waiting)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {hint && (
                <button
                  type="button"
                  data-testid="project-ai-configure"
                  className="px-5 py-2 text-left text-sm text-text-secondary"
                  onClick={onOpenSettings}
                >
                  {hint}
                </button>
              )}
            </div>}
            <div
              data-testid="project-ai-composer"
              className="relative"
              onPointerDownCapture={() => setPinned(true)}
              onClickCapture={() => setPinned(true)}
              onKeyDownCapture={() => setPinned(true)}
            >
              {!hasConversation && <button
                type="button"
                data-testid="project-ai-close-conversation"
                aria-label={copy.close}
                onClick={closeConversation}
                className="absolute -top-3 right-3 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background shadow-sm hover:bg-muted"
              ><X className="h-3.5 w-3.5" /></button>}
              {renderComposer ? (
                renderComposer({
                  project,
                  issues,
                  value: message,
                  onChange: setMessage,
                  onSubmit: (value, selection) => void send(value, selection),
                  disabled: !config?.enabled,
                  busy,
                  placeholder: copy.placeholder,
                })
              ) : (
                <ProjectComposerBody
                  ref={composer}
                  translate={(key, fallback) => fallback ?? key}
                  value={message}
                  onChange={setMessage}
                  onSubmit={(value) => void send(value)}
                  disabled={!config?.enabled}
                  submitDisabled={busy}
                  requireText
                  isModelSelectionReady={Boolean(config?.enabled)}
                  placeholder={copy.placeholder}
                  inputTestId="project-ai-message"
                  attachments={[]}
                  uploadingCount={0}
                  attachmentErrorCount={0}
                  onFileSelect={() => {}}
                  onRemoveAttachment={() => {}}
                  renderAttachments={() => null}
                  renderEditor={(props) => <ComposerTextInput {...props} />}
                  renderToolbar={({ canSend, onSubmit, className }) => (
                    <div className={`${className} flex justify-end`}>
                      <button
                        type="button"
                        data-testid="project-ai-send"
                        aria-label={copy.send}
                        disabled={!canSend}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => onSubmit()}
                        className="flex h-8 w-8 items-center justify-center rounded-full bg-text-primary text-background disabled:opacity-40"
                      >
                        <ArrowUp className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                />
              )}
            </div>
            {error && (
              <p
                role="alert"
                data-testid="project-ai-board-error"
                className="px-5 pb-2 text-sm"
              >
                {error}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
