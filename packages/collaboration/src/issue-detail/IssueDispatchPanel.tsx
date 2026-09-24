import {
  Bot,
  CircleStop,
  RotateCcw,
  Send,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CreateIssueDispatchRoundInput,
  IssueDispatch,
  IssueDispatchCandidate,
  IssueDispatchRound,
  IssueDispatchTargetKind,
  IssueDispatchTask,
  SharedWorkspaceDispatchesApi,
} from "../ports/IssueDispatch";
import type { CollaborationTranslate } from "../i18n";
import {
  IssueActivityAvatar,
  IssueActivityCard,
} from "./IssueActivityPresentation";
import { formatIssueTimestamp } from "./issueTimestamp";

const cancellableTaskStatuses = new Set(["assigned", "queued", "running"]);
const finishedTaskStatuses = new Set([
  "submitted",
  "failed",
  "needs_rework",
  "cancelled",
]);

function targetLabel(
  kind: IssueDispatchTargetKind,
  t: CollaborationTranslate,
): string {
  if (kind === "human") return t("dispatch.target_human", "成员");
  if (kind === "agent") return t("dispatch.target_agent", "智能体");
  return t("dispatch.target_group", "协作小组");
}

function taskStatusLabel(
  status: IssueDispatchTask["status"],
  t: CollaborationTranslate,
): string {
  const labels: Record<IssueDispatchTask["status"], string> = {
    assigned: t("dispatch.task_pending", "等待调度"),
    queued: t("dispatch.task_queued", "排队中"),
    running: t("dispatch.task_running", "执行中"),
    submitted: t("dispatch.task_submitted", "已交付"),
    failed: t("dispatch.task_failed", "执行失败"),
    needs_rework: t("dispatch.task_needs_rework", "需返工"),
    cancelled: t("dispatch.task_cancelled", "已取消"),
  };
  return labels[status];
}

interface DispatchDialogProps {
  api: SharedWorkspaceDispatchesApi;
  issueId: string;
  desktop: boolean;
  translate: CollaborationTranslate;
  onClose(): void;
  onCreated(dispatch: IssueDispatch): void;
}

function DispatchDialog({
  api,
  issueId,
  desktop,
  translate: t,
  onClose,
  onCreated,
}: DispatchDialogProps) {
  const [kind, setKind] = useState<IssueDispatchTargetKind>("human");
  const [candidates, setCandidates] = useState<IssueDispatchCandidate[]>([]);
  const [selected, setSelected] = useState<IssueDispatchCandidate | null>(null);
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSelected(null);
    setCandidates([]);
    void api
      .listCandidates(issueId, kind)
      .then((items) => {
        if (active) setCandidates(items);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [api, issueId, kind]);

  const submit = async () => {
    if (!selected || !title.trim() || !instruction.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await api.create(issueId, {
          target: { kind: selected.kind, id: selected.id },
          taskTitle: title.trim(),
          instructions: instruction.trim(),
        }),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30 p-4"
      data-testid="issue-dispatch-dialog"
    >
      <section className="w-full max-w-lg rounded-2xl border border-border bg-background p-5 shadow-xl">
        <header className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-text-primary">
            {t("dispatch.title", "分配任务")}
          </h2>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close", "关闭")}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {(["human", "agent", "collaboration_group"] as const).map((value) => {
            const testKind = value === "collaboration_group" ? "group" : value;
            return (
              <button
                key={value}
                type="button"
                data-testid={`issue-dispatch-target-${testKind}`}
                data-selected={kind === value ? "true" : "false"}
                onClick={() => setKind(value)}
                className="rounded-lg border border-border px-3 py-2 text-sm data-[selected=true]:border-blue-500 data-[selected=true]:bg-blue-500/10"
              >
                {targetLabel(value, t)}
              </button>
            );
          })}
        </div>
        <div className="mt-3 max-h-40 space-y-1 overflow-y-auto">
          {candidates.map((candidate) => {
            const testKind =
              candidate.kind === "collaboration_group"
                ? "group"
                : candidate.kind;
            const hostTestId = desktop
              ? `issue-dispatch-candidate-${testKind}-${candidate.id}`
              : `issue-dispatch-target-option-${testKind}:${candidate.id}`;
            return (
              <button
                key={`${candidate.kind}:${candidate.id}`}
                type="button"
                data-testid={hostTestId}
                data-selected={selected?.id === candidate.id ? "true" : "false"}
                onClick={() => setSelected(candidate)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted data-[selected=true]:bg-blue-500/10"
              >
                {candidate.kind === "human" ? (
                  <UserRound className="h-4 w-4" />
                ) : candidate.kind === "agent" ? (
                  <Bot className="h-4 w-4" />
                ) : (
                  <UsersRound className="h-4 w-4" />
                )}
                <span>{candidate.name}</span>
              </button>
            );
          })}
        </div>
        <label className="mt-4 block text-xs font-medium text-text-secondary">
          {t("dispatch.task_title", "任务标题")}
          <input
            data-testid="issue-dispatch-task-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="mt-3 block text-xs font-medium text-text-secondary">
          {t("dispatch.instructions", "执行说明")}
          <textarea
            data-testid={
              desktop
                ? "issue-dispatch-task-instructions"
                : "issue-dispatch-instructions"
            }
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            className="mt-1 min-h-24 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
        {error ? (
          <p className="mt-2 text-sm text-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-text-secondary"
          >
            {t("common.cancel", "取消")}
          </button>
          <button
            type="button"
            data-testid={
              desktop ? "issue-dispatch-submit" : "issue-dispatch-confirm"
            }
            disabled={!selected || !title.trim() || !instruction.trim() || busy}
            onClick={() => void submit()}
            className="rounded-lg bg-text-primary px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
          >
            {t("dispatch.submit", "分配")}
          </button>
        </div>
      </section>
    </div>
  );
}

interface RoundDraftTask {
  title: string;
  instruction: string;
  target: IssueDispatchCandidate | null;
}

function RoundDialog({
  api,
  dispatch,
  desktop,
  translate: t,
  onClose,
  onChanged,
}: {
  api: SharedWorkspaceDispatchesApi;
  dispatch: IssueDispatch;
  desktop: boolean;
  translate: CollaborationTranslate;
  onClose(): void;
  onChanged(dispatch: IssueDispatch): void;
}) {
  const [tasks, setTasks] = useState<RoundDraftTask[]>(
    [{ title: "", instruction: "", target: null }],
  );
  const [candidates, setCandidates] = useState<IssueDispatchCandidate[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([
      api.listCandidates(dispatch.issueId, "human"),
      api.listCandidates(dispatch.issueId, "agent"),
    ]).then(([humans, agents]) => setCandidates([...agents, ...humans]));
  }, [api, dispatch.issueId]);

  const updateTask = (index: number, patch: Partial<RoundDraftTask>) =>
    setTasks((current) =>
      current.map((task, taskIndex) =>
        taskIndex === index ? { ...task, ...patch } : task,
      ),
    );
  const addTask = () =>
    setTasks((current) => [
      ...current,
      { title: "", instruction: "", target: null },
    ]);
  const valid =
    tasks.length > 0 &&
    tasks.every(
      (task) => task.title.trim() && task.instruction.trim() && task.target,
    );
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const input: CreateIssueDispatchRoundInput = {
        tasks: tasks.map((task) => ({
          title: task.title.trim(),
          instruction: task.instruction.trim(),
          target: { kind: task.target!.kind, id: task.target!.id },
        })),
      };
      onChanged(await api.createRound(dispatch.id, input));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30 p-4"
      data-testid="issue-dispatch-round-dialog"
    >
      <section className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-background p-5 shadow-xl">
        <h2 className="text-base font-semibold">
          {t("dispatch.create_round", "分配下一轮任务")}
        </h2>
        <div className="mt-4 space-y-3">
          {tasks.map((task, index) => (
            <div
              key={index}
              data-testid={`issue-dispatch-round-task-${index}`}
              className="rounded-xl border border-border p-3"
            >
              <input
                data-testid={
                  desktop
                    ? "issue-dispatch-round-task-title"
                    : `issue-dispatch-round-task-title-${index}`
                }
                value={task.title}
                onChange={(event) =>
                  updateTask(index, { title: event.target.value })
                }
                placeholder={t("dispatch.task_title", "任务标题")}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm"
              />
              <textarea
                data-testid="issue-dispatch-round-task-instructions"
                value={task.instruction}
                onChange={(event) =>
                  updateTask(index, { instruction: event.target.value })
                }
                placeholder={t("dispatch.instructions", "执行说明")}
                className="mt-2 min-h-16 w-full rounded-lg border border-border px-3 py-2 text-sm"
              />
              <select
                data-testid={
                  desktop
                    ? "issue-dispatch-round-task-assignee"
                    : `issue-dispatch-round-task-assignee-${index}`
                }
                value={
                  task.target ? `${task.target.kind}:${task.target.id}` : ""
                }
                onChange={(event) => {
                  const candidate =
                    candidates.find(
                      (item) =>
                        `${item.kind}:${item.id}` === event.target.value,
                    ) ?? null;
                  updateTask(index, { target: candidate });
                }}
                className="mt-2 w-full rounded-lg border border-border px-3 py-2 text-sm"
              >
                <option value="">
                  {t("dispatch.choose_assignee", "选择执行者")}
                </option>
                {candidates.map((candidate) => (
                  <option
                    key={`${candidate.kind}:${candidate.id}`}
                    value={`${candidate.kind}:${candidate.id}`}
                  >
                    {candidate.name}
                  </option>
                ))}
              </select>
              {desktop
                ? candidates.map((candidate) => (
                    <button
                      key={`${candidate.kind}:${candidate.id}`}
                      type="button"
                      data-testid={`issue-dispatch-round-assignee-${candidate.kind}-${candidate.id}`}
                      onClick={() => updateTask(index, { target: candidate })}
                      className="mr-2 mt-2 rounded-md border border-border px-2 py-1 text-xs"
                    >
                      {candidate.name}
                    </button>
                  ))
                : null}
            </div>
          ))}
        </div>
        <button
          type="button"
          data-testid={
            desktop
              ? "issue-dispatch-round-add-task"
              : "issue-dispatch-round-task-add"
          }
          onClick={addTask}
          className="mt-3 text-sm text-blue-600"
        >
          + {t("dispatch.add_task", "添加任务")}
        </button>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose}>
            {t("common.cancel", "取消")}
          </button>
          <button
            type="button"
            data-testid="issue-dispatch-round-submit"
            disabled={!valid || busy}
            onClick={() => void submit()}
            className="rounded-lg bg-text-primary px-4 py-2 text-sm text-background disabled:opacity-40"
          >
            {t("dispatch.submit_round", "开始本轮")}
          </button>
        </div>
      </section>
    </div>
  );
}

function TaskActivity({
  task,
  translate: t,
  onCancel,
}: {
  task: IssueDispatchTask;
  translate: CollaborationTranslate;
  onCancel(task: IssueDispatchTask): void;
}) {
  const assigneeType =
    task.target.kind === "collaboration_group" ? "group" : task.target.kind;
  return (
    <article
      data-testid={`issue-dispatch-task-${task.id}`}
      data-state={task.status}
      data-assignee-type={assigneeType}
      data-execution-location={task.executionLocation ?? undefined}
      className="border-t border-border py-3 first:border-t-0"
    >
      <div
        data-testid={`issue-dispatch-task-activity-${task.id}`}
        data-status={task.status === "submitted" ? "succeeded" : task.status}
        className="flex gap-3"
      >
        <span
          data-testid="issue-dispatch-assignee-avatar"
          title={task.target.name}
        >
          <IssueActivityAvatar
            author={task.target.name}
            agent={task.target.kind === "agent"}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <strong className="truncate text-sm text-text-primary">
              {task.title}
            </strong>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary">
              {taskStatusLabel(task.status, t)}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-text-secondary">
            {task.instruction}
          </p>
          {task.outcome?.summary ? (
            <p className="mt-2 text-sm text-text-primary">
              {taskOutcomeSummary(task.outcome.summary, t)}
            </p>
          ) : null}
        </div>
        {cancellableTaskStatuses.has(task.status) ? (
          <button
            type="button"
            data-testid="issue-dispatch-task-cancel"
            onClick={() => onCancel(task)}
            className="self-start rounded-lg p-2 text-text-muted hover:bg-muted hover:text-error"
            aria-label={t("dispatch.cancel_task", "终止执行")}
          >
            <CircleStop className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </article>
  );
}

function taskOutcomeSummary(
  summary: string,
  t: CollaborationTranslate,
): string {
  if (summary === "Runtime confirmed cancellation") {
    return t("dispatch.runtime_cancelled", "执行已终止");
  }
  if (summary === "Delivery submitted") {
    return t("dispatch.delivery_submitted", "已提交交付");
  }
  return summary;
}

function RoundActivity({
  round,
  translate: t,
  onCancel,
}: {
  round: IssueDispatchRound;
  translate: CollaborationTranslate;
  onCancel(task: IssueDispatchTask): void;
}) {
  const finished = round.tasks.filter((task) =>
    finishedTaskStatuses.has(task.status),
  ).length;
  return (
    <section
      data-testid={`issue-dispatch-round-${round.sequence}`}
      data-state={round.status}
      className="mt-3 rounded-xl border border-border p-3"
    >
      <header className="flex items-center gap-2 text-sm">
        <strong>
          {t("dispatch.round", "第 {{count}} 轮", { count: round.sequence })}
        </strong>
        <span
          className="text-text-muted"
          data-testid="issue-dispatch-round-progress"
        >
          {finished} / {round.tasks.length}
        </span>
      </header>
      {round.tasks.map((task) => (
        <TaskActivity
          key={task.id}
          task={task}
          translate={t}
          onCancel={onCancel}
        />
      ))}
    </section>
  );
}

export function useIssueDispatchController({
  api,
  issueId,
  desktop,
  translate: t,
  onIssueChanged,
}: {
  api?: SharedWorkspaceDispatchesApi;
  issueId: string;
  desktop: boolean;
  translate: CollaborationTranslate;
  onIssueChanged?(): void | Promise<void>;
}) {
  const [dispatches, setDispatches] = useState<IssueDispatch[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [roundDialogDispatch, setRoundDialogDispatch] =
    useState<IssueDispatch | null>(null);
  const [cancelTask, setCancelTask] = useState<IssueDispatchTask | null>(null);
  const [decisionDispatch, setDecisionDispatch] =
    useState<IssueDispatch | null>(null);
  const [decisionStatus, setDecisionStatus] = useState<
    "in_review" | "completed"
  >("in_review");
  const [decisionReason, setDecisionReason] = useState("");
  const dispatchStateRef = useRef("");
  const apiRef = useRef(api);
  const onIssueChangedRef = useRef(onIssueChanged);
  const apiAvailable = Boolean(api);

  apiRef.current = api;

  useEffect(() => {
    onIssueChangedRef.current = onIssueChanged;
  }, [onIssueChanged]);

  const refresh = useCallback(async () => {
    const currentApi = apiRef.current;
    if (!currentApi) {
      setDispatches([]);
      return;
    }
    const next = await currentApi.list(issueId);
    const state = next
      .map((dispatch) =>
        [
          dispatch.id,
          dispatch.status,
          ...dispatch.rounds.flatMap((round) => [
            round.id,
            round.status,
            ...round.tasks.flatMap((task) => [
              task.id,
              task.status,
              task.updatedAt,
            ]),
          ]),
        ].join(":"),
      )
      .join("|");
    if (dispatchStateRef.current && dispatchStateRef.current !== state) {
      void onIssueChangedRef.current?.();
    }
    dispatchStateRef.current = state;
    setDispatches(next);
  }, [issueId]);
  useEffect(() => {
    void refresh();
  }, [apiAvailable, refresh]);
  const hasActiveDispatch = dispatches.some(
    (dispatch) => dispatch.status === "active",
  );
  useEffect(() => {
    if (!apiAvailable || !hasActiveDispatch) return;
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [apiAvailable, hasActiveDispatch, refresh]);

  const replace = (next: IssueDispatch) => {
    setDispatches((current) => [
      next,
      ...current.filter((item) => item.id !== next.id),
    ]);
    void onIssueChangedRef.current?.();
  };
  const activeGroup =
    dispatches.find(
      (dispatch) =>
        dispatch.target.kind === "collaboration_group" &&
        dispatch.status === "active",
    ) ?? null;
  const activeGroupRound = activeGroup?.rounds.at(-1) ?? null;
  const leaderActionRequired = Boolean(
    activeGroup &&
    activeGroup.leaderType !== "agent" &&
    (!activeGroupRound ||
      activeGroupRound.status === "planning" ||
      activeGroupRound.status === "evaluating"),
  );
  const retryable =
    dispatches.find(
      (dispatch) =>
        dispatch.status === "cancelled" ||
        dispatch.rounds.some((round) =>
          round.tasks.some((task) =>
            ["failed", "needs_rework", "cancelled"].includes(task.status),
          ),
        ),
    ) ?? null;
  const requestTaskCancellation = (task: IssueDispatchTask) => {
    if (!api) return;
    if (desktop) {
      setCancelTask(task);
      return;
    }
    void api.cancelTask(task.id).then(replace);
  };

  const tools = api ? (
    <div className="flex items-center gap-2">
      {retryable ? (
        <button
          type="button"
          data-testid="issue-dispatch-retry"
          onClick={() => void api.retry(retryable.id).then(replace)}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-text-secondary hover:bg-muted"
        >
          <RotateCcw className="h-3.5 w-3.5" /> {t("dispatch.retry", "重试")}
        </button>
      ) : null}
      <button
        type="button"
        data-testid="issue-dispatch-open"
        onClick={() => setDialogOpen(true)}
        className="inline-flex items-center gap-1 rounded-lg bg-text-primary px-3 py-1.5 text-xs font-medium text-background"
      >
        <Send className="h-3.5 w-3.5" /> {t("dispatch.open", "分配任务")}
      </button>
    </div>
  ) : null;

  const activity = (
    <>
      {dispatches.flatMap((dispatch) =>
        dispatch.rounds.map((round) => (
          <div key={`${dispatch.id}:${round.id}`}>
            {round.tasks.map((task) => (
              <div
                key={`assignment:${task.id}`}
                className="flex gap-3 border-t border-border py-3 text-sm first:border-t-0"
              >
                <div data-testid={`issue-dispatch-event-assigned-${task.id}`}>
                  <div
                    data-testid={`issue-dispatch-assignment-event-${task.id}`}
                  >
                    <div data-testid={`issue-dispatch-round-event-${task.id}`}>
                      <div className="flex items-start gap-3 text-text-secondary">
                        <span
                          className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-text-muted"
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <p>
                            {dispatch.target.kind === "collaboration_group"
                              ? t(
                                  "dispatch.assigned_by_leader",
                                  "{{leader}}（负责人）将「{{title}}」分配给 {{name}}",
                                  {
                                    leader:
                                      dispatch.leaderName ??
                                      dispatch.target.name,
                                    title: task.title,
                                    name: task.target.name,
                                  },
                                )
                              : t(
                                  "dispatch.assigned",
                                  "将「{{title}}」分配给 {{name}}",
                                  {
                                    title: task.title,
                                    name: task.target.name,
                                  },
                                )}
                          </p>
                          <time
                            className="text-xs text-text-muted"
                            dateTime={task.createdAt}
                          >
                            {formatIssueTimestamp(task.createdAt)}
                          </time>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            <IssueActivityCard>
              <RoundActivity
                round={round}
                translate={t}
                onCancel={requestTaskCancellation}
              />
            </IssueActivityCard>
          </div>
        )),
      )}
      {leaderActionRequired && activeGroup ? (
        <IssueActivityCard data-testid="issue-dispatch-leader-action-required">
          <p className="text-sm font-medium">
            {t("dispatch.leader_action_required", "本轮已结束，等待负责人评估")}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              data-testid={
                desktop
                  ? "issue-dispatch-round-open"
                  : "issue-dispatch-create-round"
              }
              onClick={() => setRoundDialogDispatch(activeGroup)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm"
            >
              {t("dispatch.create_round", "分配下一轮")}
            </button>
            <button
              type="button"
              data-testid="issue-dispatch-leader-decide"
              onClick={() => setDecisionDispatch(activeGroup)}
              className="rounded-lg bg-text-primary px-3 py-1.5 text-sm text-background"
            >
              {t("dispatch.decide", "更新 Issue 状态")}
            </button>
          </div>
        </IssueActivityCard>
      ) : null}
      {activeGroup ? (
        <span
          data-testid="issue-dispatch-manager-turn-count"
          className="sr-only"
        >
          {activeGroup.managerTurnCount ?? activeGroup.rounds.length + 1}
        </span>
      ) : null}
      {dialogOpen && api ? (
        <DispatchDialog
          api={api}
          issueId={issueId}
          desktop={desktop}
          translate={t}
          onClose={() => setDialogOpen(false)}
          onCreated={replace}
        />
      ) : null}
      {roundDialogDispatch && api ? (
        <RoundDialog
          api={api}
          dispatch={roundDialogDispatch}
          desktop={desktop}
          translate={t}
          onClose={() => setRoundDialogDispatch(null)}
          onChanged={replace}
        />
      ) : null}
      {cancelTask && api ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30"
          data-testid="issue-dispatch-cancel-dialog"
        >
          <section className="w-full max-w-sm rounded-2xl bg-background p-5 shadow-xl">
            <p className="font-medium">
              {t("dispatch.cancel_confirm", "确认终止这个任务？")}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCancelTask(null)}
                className="rounded-lg px-3 py-1.5 text-text-secondary hover:bg-muted"
              >
                {t("common.cancel", "取消")}
              </button>
              <button
                type="button"
                data-testid="issue-dispatch-cancel-confirm"
                onClick={() =>
                  void api.cancelTask(cancelTask.id).then((next) => {
                    replace(next);
                    setCancelTask(null);
                  })
                }
                className="rounded-lg bg-red-600 px-3 py-1.5 text-white hover:bg-red-700"
              >
                {t("dispatch.cancel_task", "终止执行")}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {decisionDispatch && api ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30">
          <section className="w-full max-w-md rounded-2xl bg-background p-5 shadow-xl">
            <select
              data-testid="issue-dispatch-decision-status"
              value={decisionStatus}
              onChange={(event) =>
                setDecisionStatus(
                  event.target.value as "in_review" | "completed",
                )
              }
              className="w-full rounded-lg border border-border px-3 py-2"
            >
              <option value="in_review">
                {t("dispatch.in_review", "待确认")}
              </option>
              <option value="completed">
                {t("dispatch.completed", "已完成")}
              </option>
            </select>
            <textarea
              data-testid="issue-dispatch-decision-reason"
              value={decisionReason}
              onChange={(event) => setDecisionReason(event.target.value)}
              className="mt-3 min-h-20 w-full rounded-lg border border-border px-3 py-2"
            />
            <button
              type="button"
              data-testid="issue-dispatch-decision-submit"
              disabled={!decisionReason.trim()}
              onClick={() =>
                void api
                  .decide(decisionDispatch.id, {
                    status: decisionStatus,
                    reason: decisionReason.trim(),
                  })
                  .then((next) => {
                    replace(next);
                    setDecisionDispatch(null);
                  })
              }
              className="mt-3 rounded-lg bg-text-primary px-4 py-2 text-background disabled:opacity-40"
            >
              {t("dispatch.decide", "确认")}
            </button>
          </section>
        </div>
      ) : null}
      {dispatches.find((dispatch) =>
        dispatch.rounds.some((round) =>
          round.tasks.some((task) => task.status === "submitted"),
        ),
      ) && api ? (
        <button
          type="button"
          data-testid="issue-dispatch-return-for-rework"
          onClick={() => {
            const dispatch = dispatches.find((item) =>
              item.rounds.some((round) =>
                round.tasks.some((task) => task.status === "submitted"),
              ),
            );
            if (dispatch) void api.returnForRework(dispatch.id).then(replace);
          }}
          className="mt-3 rounded-lg border border-border px-3 py-1.5 text-sm"
        >
          {t("dispatch.return_for_rework", "退回修改")}
        </button>
      ) : null}
    </>
  );

  return {
    tools,
    activity,
    activityCount:
      dispatches.reduce(
        (count, dispatch) =>
          count +
          dispatch.rounds.reduce(
            (roundCount, round) => roundCount + round.tasks.length,
            0,
          ),
        0,
      ) +
      (leaderActionRequired ? 1 : 0) +
      (dialogOpen ? 1 : 0),
  };
}
