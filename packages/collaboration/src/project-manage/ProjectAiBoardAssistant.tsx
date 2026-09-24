// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, ChevronUp } from "lucide-react";
import type {
  SharedWorkspaceApi,
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
    settings: "设置",
    unavailable: "先在项目设置中选择管理者智能体",
    disabled: "项目 AI 已关闭，可在项目设置中开启",
    empty: "在下方输入，和项目 AI 对话",
    waiting: "项目 AI 正在处理…",
    failed: "运行失败",
    issues: "查看 Issue",
  },
  en: {
    title: "Project AI",
    placeholder: "Ask project AI or manage Issues…",
    send: "Send",
    close: "Close conversation",
    settings: "Settings",
    unavailable: "Choose a manager Agent in project settings",
    disabled: "Project AI is off. Enable it in project settings",
    empty: "Type below to talk to project AI",
    waiting: "Project AI is working…",
    failed: "Run failed",
    issues: "Open Issue",
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
}: {
  api: SharedWorkspaceApi;
  project: CollaborationProject;
  issues: CollaborationIssue[];
  agents: CollaborationAgent[];
  locale: "zh-CN" | "en";
  onOpenSettings(): void;
  onOpenIssue(issue: CollaborationIssue): void;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bootstrapping = useRef(new Set<string>());
  const composer = useRef<ComposerInputHandle>(null);
  const responses = useRef(new Map<string, WorkspaceProjectManagerRun>());

  useEffect(() => {
    setConfig(null);
    setRuns([]);
    setMessage("");
    setOpen(false);
    setError("");
    responses.current.clear();
  }, [project.id]);

  useEffect(() => {
    if (open) composer.current?.focus();
  }, [open]);

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
    setRuns(detailed.reverse());
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

  const send = async (value: string) => {
    if (!manager || !config?.enabled || !value.trim() || busy) return;
    setBusy(true);
    setError("");
    setOpen(true);
    try {
      const run = await manager.run(project.id, value.trim());
      setRuns((previous) => [...previous, run]);
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
  return (
    <div
      className="pointer-events-none absolute bottom-4 left-4 right-4 z-20 mx-auto flex max-w-2xl justify-center"
      data-testid="project-ai-board-assistant"
    >
      {!open ? (
        <button
          type="button"
          data-testid="project-ai-expand"
          aria-expanded="false"
          className="pointer-events-auto flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-3 text-text-primary shadow-sm hover:bg-muted"
          onClick={() => setOpen(true)}
        >
          <Bot className="h-4 w-4" aria-hidden="true" />
          <span>{copy.title}</span>
          <ChevronUp
            className="h-3 w-3 text-text-secondary"
            aria-hidden="true"
          />
        </button>
      ) : (
        <section
          className="pointer-events-auto flex w-full max-h-[min(60vh,38rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-md"
          data-testid="project-ai-conversation"
        >
          <header className="flex items-center justify-between border-b border-border px-4 py-2">
            <strong className="flex items-center gap-2 text-text-primary">
              <Bot className="h-4 w-4" aria-hidden="true" />
              {copy.title}
            </strong>
            <div className="flex items-center gap-2">
              <details className="relative">
                <summary
                  data-testid="project-ai-issue-picker"
                  className="cursor-pointer rounded px-2 py-1 text-text-secondary hover:bg-muted"
                >
                  {copy.issues}
                </summary>
                <div className="absolute right-0 top-full z-30 mt-2 max-h-64 w-64 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-md">
                  {issues.map((issue) => (
                    <button
                      key={issue.id}
                      type="button"
                      data-testid={`project-ai-open-issue-${issue.id}`}
                      className="block w-full truncate rounded px-2 py-1 text-left text-text-primary hover:bg-muted"
                      onClick={() => onOpenIssue(issue)}
                    >
                      #{issue.sequence_number} {issue.title}
                    </button>
                  ))}
                </div>
              </details>
              <button
                type="button"
                data-testid="project-ai-open-settings"
                className="rounded px-2 py-1 text-text-secondary hover:bg-muted"
                onClick={onOpenSettings}
              >
                {copy.settings}
              </button>
              <button
                type="button"
                data-testid="project-ai-close-conversation"
                aria-label={copy.close}
                className="rounded px-2 py-1 text-text-secondary hover:bg-muted"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
          </header>
          <div
            className="min-h-32 space-y-3 overflow-y-auto px-4 py-4"
            data-testid="project-ai-conversation-history"
            aria-live="polite"
          >
            {runs.length === 0 && (
              <p className="text-text-secondary">{copy.empty}</p>
            )}
            {runs.map((run) => (
              <div
                key={run.id}
                className="space-y-2"
                data-testid={`project-ai-conversation-run-${run.id}`}
              >
                {run.instruction && (
                  <p className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-text-primary">
                    {run.instruction}
                  </p>
                )}
                <p
                  className="max-w-[85%] whitespace-pre-wrap rounded-lg border border-border px-3 py-2 text-text-primary"
                  data-testid={`project-ai-response-${run.id}`}
                >
                  {run.response ||
                    (run.status === "failed"
                      ? `${copy.failed}: ${run.error ?? ""}`
                      : copy.waiting)}
                </p>
                {run.actions?.map((action) => {
                  const issue = issues.find(
                    (item) => item.id === action.itemId,
                  );
                  return issue ? (
                    <button
                      key={action.id}
                      type="button"
                      data-testid={`project-ai-run-issue-${action.id}`}
                      className="rounded px-2 py-1 text-text-secondary hover:bg-muted hover:text-text-primary"
                      onClick={() => onOpenIssue(issue)}
                    >
                      #{issue.sequence_number} {issue.title} ↗
                    </button>
                  ) : null;
                })}
              </div>
            ))}
          </div>
          {hint && (
            <button
              type="button"
              data-testid="project-ai-configure"
              className="border-t border-border px-4 py-2 text-left text-text-secondary hover:text-text-primary"
              onClick={onOpenSettings}
            >
              {hint}
            </button>
          )}
          <div
            className="border-t border-border p-2"
            data-testid="project-ai-composer"
          >
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
              onFileSelect={() =>
                setError(
                  locale === "zh-CN"
                    ? "项目 AI 暂不支持附件"
                    : "Project AI does not support attachments yet",
                )
              }
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
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              )}
            />
            {error && (
              <p
                role="alert"
                data-testid="project-ai-board-error"
                className="px-2 text-text-primary"
              >
                {error}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
