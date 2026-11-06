import { useEffect, useRef, useState } from "react";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type { CollaborationIssue } from "../types";
import { MilestonePicker } from "./MilestonePicker";
import { milestoneMessages } from "./messages";
import { useMilestones } from "./useMilestones";
import { bulkIssueStatus } from "../platform/bulkIssueStatus";

export function MilestoneBulkAction({
  api,
  projectId,
  issues,
  locale,
  onUpdated,
}: {
  api: SharedWorkspaceApi;
  projectId: string;
  issues: CollaborationIssue[];
  locale: "en" | "zh-CN";
  onUpdated(issue: CollaborationIssue): void;
}) {
  const m = milestoneMessages[locale];
  const query = useMilestones(api.milestones, projectId);
  const [value, setValue] = useState<string | null>();
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [freshIssues, setFreshIssues] = useState<
    Record<string, CollaborationIssue>
  >({});
  const generation = useRef(0);
  const authScope = api.milestones?.getCacheScope?.();
  const selection = issues.map((issue) => issue.id).join("|");
  useEffect(() => {
    generation.current++;
    setValue(undefined);
    setFailures([]);
    setFreshIssues({});
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [api, projectId, authScope]);
  useEffect(() => {
    if (busy || !failures.length) return;
    const selected = new Set(issues.map((issue) => issue.id));
    const remaining = failures.filter((id) => selected.has(id));
    if (remaining.length !== failures.length) setFailures(remaining);
  }, [selection, issues, failures, busy]);

  async function apply() {
    if (value === undefined || query.loading || query.error || busy) return;
    const current = ++generation.current;
    const isCurrent = () => current === generation.current;
    setBusy(true);
    const targets = failures.length
      ? issues.filter((issue) => failures.includes(issue.id))
      : issues;
    const completed: CollaborationIssue[] = [];
    const failed = await bulkIssueStatus(
      targets,
      async (selected) => {
        // Retry reads current authority and version rather than replaying a stale patch.
        const issue = failures.includes(selected.id)
          ? await api.issues.get(selected.id)
          : selected;
        if (!isCurrent()) return null;
        if ((issue.milestone_id ?? null) === value) {
          completed.push(issue);
          return issue;
        }
        const updated = await api.issues.update(issue.id, {
          version: issue.version,
          milestoneId: value,
        });
        completed.push(updated);
        return updated;
      },
      () => m.bulkFailed,
    );
    if (!isCurrent()) return;
    const failedIds = failed.map((failure) => failure.issueId);
    const refreshed = await Promise.allSettled(
      failedIds.map(async (id) => {
        const issue = await api.issues.get(id);
        return issue;
      }),
    );
    if (!isCurrent()) return;
    // Publish together: moving an Issue out of this filtered table must not
    // unmount the action before its remaining results have been reconciled.
    completed.forEach(onUpdated);
    refreshed.forEach((result) => {
      if (result.status === "fulfilled") onUpdated(result.value);
    });
    setFreshIssues(
      Object.fromEntries(
        refreshed.flatMap((result) =>
          result.status === "fulfilled"
            ? [[result.value.id, result.value]]
            : [],
        ),
      ),
    );
    setFailures(failedIds);
    setBusy(false);
  }

  return (
    <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
      <MilestonePicker
        api={api.milestones}
        query={query}
        projectId={projectId}
        value={value}
        onChange={(next) => {
          setValue(next);
          setFailures([]);
          setFreshIssues({});
        }}
        label={m.bulk}
        searchLabel={m.search}
        emptyLabel={m.noMatches}
        placeholder={m.choose}
        noneLabel={m.unlink}
        errorLabel={m.error}
        retryLabel={m.retry}
        disabled={busy}
        testId="milestone-bulk-select"
      />
      <button
        type="button"
        data-testid="milestone-bulk-apply"
        disabled={busy || value === undefined || query.loading || query.error}
        className="min-h-11 shrink-0 whitespace-nowrap rounded-md border border-border px-3 text-sm md:min-h-8"
        onClick={() => void apply()}
      >
        {failures.length ? m.retryFailed : m.apply}
      </button>
      {failures.length ? (
        <span role="alert">
          {m.bulkFailed}{" "}
          {failures
            .map(
              (id) =>
                freshIssues[id]?.title ||
                issues.find((issue) => issue.id === id)?.title ||
                id,
            )
            .join(", ")}
        </span>
      ) : null}
    </div>
  );
}
