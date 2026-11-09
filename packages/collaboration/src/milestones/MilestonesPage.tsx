import "./milestones.css";
import { Flag } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
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
import { useMilestones, milestoneVisibilityScope } from "./useMilestones";
import {
  useMilestoneFilter,
  type MilestoneFilterValue,
} from "./useMilestoneFilter";
import { MilestonePicker } from "./MilestonePicker";

const buttonBaseClass =
  "min-h-11 rounded-md border px-3 text-sm disabled:opacity-50 md:min-h-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40";
const buttonClass = `${buttonBaseClass} border-border hover:bg-muted`;
const primaryButtonClass = `${buttonBaseClass} border-transparent bg-text-primary text-background hover:bg-text-primary/90`;

export function MilestonesPage({
  api,
  project,
  issues,
  locale,
  renderIssues,
  onChanged,
  onOpenArchive,
  filter,
  onFilterChange,
}: {
  api: SharedWorkspaceApi;
  project: CollaborationProject;
  issues: CollaborationIssue[];
  locale: "zh-CN" | "en";
  onChanged?(): Promise<unknown>;
  onOpenArchive?(): void;
  filter?: MilestoneFilterValue;
  onFilterChange?(milestoneId: string | null): void;
  renderIssues(
    issues: CollaborationIssue[],
    assignments: Record<string, CollaborationAssignment[]>,
    emptyLabel: string,
    milestoneId: string | null,
  ): ReactNode;
}) {
  const m = milestoneMessages[locale];
  const query = useMilestones(
    api.milestones,
    project.id,
    true,
    issues.map((issue) => `${issue.id}:${issue.version}`).join("|"),
    milestoneVisibilityScope(project),
  );
  const [state, setState] = useState<"open" | "closed">("open");
  const selection = useMilestoneFilter(project.id, "milestones", issues, {
    filter,
    onChange: onFilterChange,
  });
  const selected = selection.value;
  const readOnlyFilter = filter !== undefined && onFilterChange === undefined;
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
  const linkedIssues = selection.filteredIssues;
  const showingIssues =
    Boolean(active) ||
    (selected === null && (query.items.length > 0 || linkedIssues.length > 0));
  const listedMilestones = query.items.filter(
    (item) =>
      item.state === state && (selected === "all" || item.id === selected),
  );
  const { assignmentsByIssueId } = useIssueAssignmentsByIssueId({
    assignmentsApi: api.assignments,
    issues: linkedIssues,
    enabled: showingIssues,
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
      className="min-h-0 flex-1 overflow-auto px-5 py-6"
      data-testid="milestones-page"
      aria-busy={busy}
    >
      <div
        className="mx-auto w-full max-w-6xl"
        data-testid="milestones-content"
      >
        <header className="mb-6 space-y-4">
          {selected !== "all" ? (
            <button
              type="button"
              className="min-h-11 text-sm text-text-secondary hover:text-text-primary md:min-h-8"
              data-testid="milestones-back"
              disabled={readOnlyFilter}
              onClick={selection.clear}
            >
              ← {m.back}
            </button>
          ) : (
            <div>
              <h1 className="heading-medium">{m.title}</h1>
              <p className="mt-1 text-sm text-text-muted">{m.intro}</p>
            </div>
          )}
          {filter !== undefined ? (
            <MilestonePicker
              api={api.milestones}
              query={query}
              projectId={project.id}
              value={selected}
              onChange={selection.select}
              onClear={selection.clear}
              clearLabel={m.clearFilter}
              label={m.title}
              searchLabel={m.search}
              emptyLabel={m.noMatches}
              noneLabel={m.none}
              allLabel={m.all}
              errorLabel={m.error}
              retryLabel={m.retry}
              testId="milestones-filter"
              compact
              disabled={readOnlyFilter}
            />
          ) : null}
          {!showingIssues ? (
            <div
              className="flex flex-wrap items-center justify-between gap-3"
              data-testid="milestones-toolbar"
            >
              <div
                className="inline-flex items-center gap-1 rounded-lg bg-muted p-1"
                role="group"
                aria-label={m.title}
              >
                {(["open", "closed"] as const).map((value) => (
                  <button
                    type="button"
                    className="min-h-11 rounded-md px-3 text-sm text-text-secondary aria-pressed:bg-background aria-pressed:text-text-primary aria-pressed:shadow-sm md:min-h-8"
                    data-testid={`milestones-${value}`}
                    key={value}
                    aria-pressed={value === state}
                    onClick={() => {
                      setState(value);
                      if (selected !== "all") selection.clear();
                    }}
                  >
                    {m[value]}{" "}
                    <span className="ml-2 text-xs text-text-muted">
                      {
                        query.items.filter((item) => item.state === value)
                          .length
                      }
                    </span>
                  </button>
                ))}
              </div>
              {canManage ? (
                <button
                  type="button"
                  data-testid="milestone-create"
                  className={primaryButtonClass}
                  onClick={() => {
                    setEditing("new");
                    setFailed(false);
                  }}
                >
                  {m.new}
                </button>
              ) : null}
            </div>
          ) : null}
        </header>
        {query.error || failed ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
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
        !showingIssues &&
        !editing &&
        listedMilestones.length === 0 ? (
          <div
            className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center"
            data-testid="milestones-empty"
          >
            <Flag className="h-6 w-6 text-text-muted" aria-hidden="true" />
            <h2 className="heading-small">
              {selected !== "all" && query.items.length > 0
                ? m.noMatches
                : state === "closed"
                  ? m.emptyClosed
                  : m.empty}
            </h2>
            <p className="max-w-md text-sm text-text-muted">
              {state === "closed" ? m.emptyClosedHint : m.emptyHint}
            </p>
          </div>
        ) : null}
        {showingIssues ? (
          <>
            <h2 className="heading-medium mb-3 break-words">
              {active?.title ?? m.none}
            </h2>
            <p className="max-w-3xl whitespace-pre-wrap break-words text-sm text-text-secondary">
              {active?.description}
            </p>
            {active ? (
              <div className="my-4">
                <MilestoneProgress item={active} messages={m} />
              </div>
            ) : null}
            {(active?.archived_issues ?? 0) > 0 && onOpenArchive ? (
              <div className="my-3">
                <button
                  type="button"
                  className={buttonClass}
                  data-testid="milestone-view-archive"
                  onClick={onOpenArchive}
                >
                  {m.viewArchive}
                </button>
              </div>
            ) : null}
            <div key={selected}>
              {renderIssues(
                linkedIssues,
                assignmentsByIssueId,
                (active?.archived_issues ?? 0) > 0
                  ? m.noActiveIssues
                  : m.noIssues,
                active?.id ?? null,
              )}
            </div>
          </>
        ) : (
          listedMilestones.map((item) => {
            const overdue =
              item.state === "open" &&
              item.due_on &&
              item.due_on < new Date().toLocaleDateString("sv-SE");
            return (
              <article
                key={item.id}
                className="border-b border-border py-5"
                data-testid={`milestone-${item.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid={`milestone-open-${item.id}`}
                    disabled={readOnlyFilter}
                    onClick={() => selection.select(item.id)}
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
                <div>
                  <MilestoneProgress item={item} messages={m} />
                </div>
              </article>
            );
          })
        )}
      </div>
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
      className="milestone-form mb-4 max-w-2xl space-y-3 rounded-md border border-border p-3"
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
          className="milestone-form-field mt-1 min-h-11 w-full rounded-md bg-background px-2 md:min-h-8"
        />
      </label>
      <label className="block text-sm">
        {m.description}
        <textarea
          data-testid="milestone-description"
          name="description"
          defaultValue={milestone?.description ?? ""}
          className="milestone-form-field mt-1 min-h-20 w-full rounded-md bg-background p-2"
        />
      </label>
      <label className="block text-sm">
        {m.due}
        <input
          data-testid="milestone-due"
          name="due_on"
          type="date"
          defaultValue={milestone?.due_on ?? ""}
          className="milestone-form-field ml-2 min-h-11 rounded-md bg-background px-2 md:min-h-8"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          data-testid="milestone-save"
          disabled={busy}
          className={primaryButtonClass}
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

function MilestoneProgress({
  item,
  messages: m,
}: {
  item: Milestone;
  messages:
    | (typeof milestoneMessages)["en"]
    | (typeof milestoneMessages)["zh-CN"];
}) {
  const total = item.open_issues + item.closed_issues;
  const progress = total ? Math.round((item.closed_issues * 100) / total) : 0;
  return (
    <>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={item.title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span
          data-testid={`milestone-progress-fill-${item.id}`}
          className="block h-full rounded-full bg-text-primary"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-text-muted">
        {progress}% · {item.closed_issues} {m.completed} · {item.open_issues}{" "}
        {m.remaining}
        {(item.archived_issues ?? 0) > 0
          ? ` · ${item.archived_issues} ${m.archived}`
          : ""}
      </p>
    </>
  );
}
