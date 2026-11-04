import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAssignment,
  CollaborationIssue,
  CollaborationProject,
} from "../types";
import { canManageCollaborationIssueSecurity } from "../permissions";
import { useIssueAssignmentsByIssueId } from "../platform/useIssueAssignmentsByIssueId";
import type { Milestone, MilestoneInput } from "./types";
import { milestoneMessages } from "./messages";
import { useMilestones } from "./useMilestones";

const buttonClass =
  "min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8";

export function MilestonesPage({
  api,
  project,
  issues,
  locale,
  renderIssues,
  onChanged,
  onOpenArchive,
}: {
  api: SharedWorkspaceApi;
  project: CollaborationProject;
  issues: CollaborationIssue[];
  locale: "zh-CN" | "en";
  onChanged?(): Promise<unknown>;
  onOpenArchive?(): void;
  renderIssues(
    issues: CollaborationIssue[],
    assignments: Record<string, CollaborationAssignment[]>,
    emptyLabel: string,
    milestoneId: string,
  ): ReactNode;
}) {
  const m = milestoneMessages[locale];
  const query = useMilestones(
    api.milestones,
    project.id,
    true,
    issues.map((issue) => `${issue.id}:${issue.version}`).join("|"),
    JSON.stringify([
      project.current_user_id,
      project.access_role,
      project.project_store,
      project.default_issue_security,
    ]),
  );
  const [state, setState] = useState<"open" | "closed">("open");
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Milestone | "new" | null>(null);
  const [deleting, setDeleting] = useState<Milestone | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const canManage = canManageCollaborationIssueSecurity(project);
  useEffect(() => {
    if (!canManage) {
      setEditing(null);
      setDeleting(null);
    }
  }, [canManage]);
  const active = query.items.find((item) => item.id === selected);
  const linkedIssues = useMemo(
    () => issues.filter((issue) => issue.milestone_id === selected),
    [issues, selected],
  );
  const { assignmentsByIssueId } = useIssueAssignmentsByIssueId({
    assignmentsApi: api.assignments,
    issues: linkedIssues,
    enabled: selected !== null,
  });

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true);
    setFailed(false);
    try {
      await action();
      await onChanged?.();
      setEditing(null);
      setDeleting(null);
      query.reload();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="min-h-0 flex-1 overflow-auto p-4"
      data-testid="milestones-page"
      aria-busy={busy}
    >
      <div className="mb-4 flex max-w-3xl flex-wrap items-center gap-2">
        {(["open", "closed"] as const).map((value) => (
          <button
            type="button"
            className={`${buttonClass} aria-pressed:bg-text-primary aria-pressed:text-background aria-pressed:hover:bg-text-primary`}
            data-testid={`milestones-${value}`}
            key={value}
            aria-pressed={value === state}
            onClick={() => {
              setState(value);
              setSelected(null);
            }}
          >
            {m[value]}
          </button>
        ))}
        {canManage ? (
          <button
            type="button"
            data-testid="milestone-create"
            className={`${buttonClass} ml-auto bg-text-primary text-background`}
            onClick={() => {
              setEditing("new");
              setFailed(false);
            }}
          >
            {m.new}
          </button>
        ) : null}
      </div>
      {query.error || failed ? (
        <p role="alert" className="mb-3 text-sm text-red-600">
          {m.error}{" "}
          <button
            type="button"
            className={buttonClass}
            data-testid="milestones-retry"
            onClick={() => {
              setFailed(false);
              setEditing(null);
              setDeleting(null);
              query.reload();
            }}
          >
            {editing ? m.discardAndRefresh : m.retry}
          </button>
        </p>
      ) : null}
      {query.loading ? <p role="status">{m.loading}</p> : null}
      {editing && canManage ? (
        <MilestoneForm
          key={editing === "new" ? "new" : editing.id}
          milestone={editing === "new" ? null : editing}
          messages={m}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(input) =>
            void mutate(() =>
              editing === "new"
                ? api.milestones!.create(project.id, input)
                : api.milestones!.update(project.id, editing.id, {
                    ...input,
                    version: editing.version,
                  }),
            )
          }
        />
      ) : null}
      {deleting && canManage ? (
        <div
          className="my-3 flex max-w-3xl flex-wrap items-center gap-3 rounded-md border border-border p-3"
          role="alert"
        >
          <span className="min-w-0 max-w-full break-words">
            {deleting.title}: {m.confirm}
          </span>
          <button
            type="button"
            className={buttonClass}
            data-testid="milestone-delete-confirm"
            disabled={busy}
            onClick={() =>
              void mutate(() =>
                api.milestones!.remove(
                  project.id,
                  deleting.id,
                  deleting.version,
                ),
              )
            }
          >
            {m.remove}
          </button>
          <button
            type="button"
            className={buttonClass}
            data-testid="milestone-delete-cancel"
            disabled={busy}
            onClick={() => setDeleting(null)}
          >
            {m.cancel}
          </button>
        </div>
      ) : null}
      {!query.loading &&
      !query.error &&
      query.items.filter((item) => item.state === state).length === 0 ? (
        <p className="py-8 text-sm text-text-muted">{m.empty}</p>
      ) : null}
      {active ? (
        <>
          <button
            type="button"
            className={buttonClass}
            data-testid="milestones-back"
            onClick={() => setSelected(null)}
          >
            {m.back}
          </button>
          <h2 className="heading-md my-3 max-w-3xl break-words">
            {active.title}
          </h2>
          <p className="max-w-3xl whitespace-pre-wrap break-words text-sm text-text-secondary">
            {active.description}
          </p>
          {(active.archived_issues ?? 0) > 0 ? (
            <p className="my-3 text-sm text-text-muted">
              {active.archived_issues} {m.archived}{" "}
              {onOpenArchive ? (
                <button
                  type="button"
                  className={buttonClass}
                  data-testid="milestone-view-archive"
                  onClick={onOpenArchive}
                >
                  {m.viewArchive}
                </button>
              ) : null}
            </p>
          ) : null}
          <div key={active.id}>
            {renderIssues(
              linkedIssues,
              assignmentsByIssueId,
              (active.archived_issues ?? 0) > 0 ? m.noActiveIssues : m.noIssues,
              active.id,
            )}
          </div>
        </>
      ) : (
        query.items
          .filter((item) => item.state === state)
          .map((item) => {
            const total = item.open_issues + item.closed_issues;
            const progress = total
              ? Math.round((item.closed_issues * 100) / total)
              : 0;
            const overdue =
              item.state === "open" &&
              item.due_on &&
              item.due_on < new Date().toLocaleDateString("sv-SE");
            return (
              <article
                key={item.id}
                className="max-w-3xl border-b border-border py-4"
                data-testid={`milestone-${item.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid={`milestone-open-${item.id}`}
                    onClick={() => setSelected(item.id)}
                    className="min-h-11 min-w-0 max-w-full break-words text-left text-sm font-semibold hover:underline md:min-h-8"
                  >
                    {item.title}
                  </button>
                  {item.due_on ? (
                    <span className="text-xs text-text-muted">
                      {m.due}: {item.due_on} {overdue ? `· ${m.overdue}` : ""}
                    </span>
                  ) : null}
                  {canManage ? (
                    <div className="ml-auto flex gap-2">
                      <button
                        type="button"
                        className={buttonClass}
                        data-testid={`milestone-edit-${item.id}`}
                        disabled={busy}
                        onClick={() => setEditing(item)}
                      >
                        {m.edit}
                      </button>
                      <button
                        type="button"
                        className={buttonClass}
                        data-testid={`milestone-state-${item.id}`}
                        disabled={busy}
                        onClick={() =>
                          void mutate(() =>
                            api.milestones!.update(project.id, item.id, {
                              title: item.title,
                              description: item.description,
                              due_on: item.due_on,
                              version: item.version,
                              state: item.state === "open" ? "closed" : "open",
                            }),
                          )
                        }
                      >
                        {item.state === "open" ? m.close : m.reopen}
                      </button>
                      <button
                        type="button"
                        className={buttonClass}
                        data-testid={`milestone-delete-${item.id}`}
                        disabled={busy}
                        onClick={() => setDeleting(item)}
                      >
                        {m.remove}
                      </button>
                    </div>
                  ) : null}
                </div>
                <p className="my-2 whitespace-pre-wrap break-words text-sm text-text-secondary">
                  {item.description}
                </p>
                <progress
                  className="h-2 w-full accent-current"
                  aria-label={item.title}
                  max={100}
                  value={progress}
                />
                <p className="mt-1 text-xs text-text-muted">
                  {progress}% · {item.closed_issues} {m.completed} ·{" "}
                  {item.open_issues} {m.remaining}
                  {(item.archived_issues ?? 0) > 0
                    ? ` · ${item.archived_issues} ${m.archived}`
                    : ""}
                </p>
              </article>
            );
          })
      )}
    </section>
  );
}

function MilestoneForm({
  milestone,
  messages: m,
  busy,
  onCancel,
  onSave,
}: {
  milestone: Milestone | null;
  messages:
    | (typeof milestoneMessages)["en"]
    | (typeof milestoneMessages)["zh-CN"];
  busy: boolean;
  onCancel(): void;
  onSave(input: MilestoneInput): void;
}) {
  return (
    <form
      data-testid="milestone-form"
      className="mb-4 max-w-2xl space-y-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        onSave({
          title: String(form.get("title")).trim(),
          description: String(form.get("description")),
          due_on: String(form.get("due_on")) || null,
          state: milestone?.state ?? "open",
        });
      }}
    >
      <label className="block text-sm">
        {m.name}
        <input
          data-testid="milestone-title"
          name="title"
          required
          maxLength={255}
          defaultValue={milestone?.title ?? ""}
          className="mt-1 min-h-11 w-full rounded-md border border-border bg-background px-2 md:min-h-8"
        />
      </label>
      <label className="block text-sm">
        {m.description}
        <textarea
          data-testid="milestone-description"
          name="description"
          defaultValue={milestone?.description ?? ""}
          className="mt-1 min-h-20 w-full rounded-md border border-border bg-background p-2"
        />
      </label>
      <label className="block text-sm">
        {m.due}
        <input
          data-testid="milestone-due"
          name="due_on"
          type="date"
          defaultValue={milestone?.due_on ?? ""}
          className="ml-2 min-h-11 rounded-md border border-border bg-background px-2 md:min-h-8"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          data-testid="milestone-save"
          disabled={busy}
          className={`${buttonClass} bg-text-primary text-background`}
        >
          {m.save}
        </button>
        <button
          type="button"
          data-testid="milestone-cancel"
          disabled={busy}
          className={buttonClass}
          onClick={onCancel}
        >
          {m.cancel}
        </button>
      </div>
    </form>
  );
}
