import { Flag, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import type { MilestonesApi } from "./types";
import { useMilestones } from "./useMilestones";
import "./milestones.css";

export function MilestonePicker({
  api,
  query: providedQuery,
  placeholder,
  onMissingValue,
  projectId,
  value,
  onChange,
  disabled,
  compact = false,
  appearance = "field",
  label,
  noneLabel,
  errorLabel,
  retryLabel,
  allLabel,
  testId = "issue-milestone",
}: {
  api?: MilestonesApi;
  query?: ReturnType<typeof useMilestones>;
  placeholder?: string;
  onMissingValue?(): void;
  projectId: string;
  value: string | null | undefined;
  onChange(value: string | null): Promise<void> | void;
  disabled?: boolean;
  compact?: boolean;
  appearance?: "field" | "property";
  label: string;
  noneLabel: string;
  errorLabel: string;
  retryLabel: string;
  allLabel?: string;
  testId?: string;
}) {
  const ownedQuery = useMilestones(api, projectId, providedQuery === undefined);
  const query = providedQuery ?? ownedQuery;
  useEffect(() => {
    if (
      !query.loading &&
      !query.error &&
      value &&
      value !== "all" &&
      !query.items.some((item) => item.id === value)
    )
      onMissingValue?.();
  }, [onMissingValue, query.error, query.items, query.loading, value]);
  const filter = Boolean(allLabel);
  const selectedTitle =
    query.items.find((item) => item.id === value)?.title ??
    (value === "all"
      ? allLabel
      : value === undefined
        ? placeholder
        : value
          ? label
          : noneLabel) ??
    label;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!api) return null;
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm">
      <label
        className={
          appearance === "property"
            ? "task-detail-state-assignee"
            : filter
              ? "milestone-picker-filter relative inline-flex min-h-11 min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs text-text-secondary hover:bg-muted md:min-h-8"
              : "flex min-w-0 max-w-full items-center gap-2"
        }
      >
        <span
          className={
            compact || appearance === "property"
              ? "sr-only"
              : "shrink-0 whitespace-nowrap text-text-secondary"
          }
        >
          {label}
        </span>
        {appearance === "property" ? (
          <>
            <Flag aria-hidden="true" size={16} />
            <span className="max-w-40 truncate">
              {query.items.find((item) => item.id === value)?.title ??
                noneLabel}
            </span>
            <ChevronDown aria-hidden="true" size={12} />
          </>
        ) : null}
        {filter ? (
          <>
            <span className="max-w-40 truncate">{selectedTitle}</span>
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          </>
        ) : null}
        <select
          data-testid={testId}
          aria-label={label}
          title={`${label}: ${query.items.find((item) => item.id === value)?.title ?? (value === "all" ? allLabel : value === undefined ? placeholder : noneLabel) ?? label}`}
          value={value === undefined ? "__unselected__" : (value ?? "")}
          disabled={disabled || busy || query.loading || query.error}
          className={
            appearance === "property" || filter
              ? "absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
              : `min-h-11 min-w-0 truncate ${compact ? "max-w-40" : "max-w-56"} rounded-lg border border-border bg-background px-3 text-xs text-text-secondary md:min-h-8`
          }
          onChange={(event) => {
            const next = event.target.value || null;
            setBusy(true);
            setFailed(false);
            void Promise.resolve(onChange(next))
              .catch(() => setFailed(true))
              .finally(() => setBusy(false));
          }}
        >
          {placeholder ? (
            <option value="__unselected__" disabled>
              {placeholder}
            </option>
          ) : null}
          {allLabel ? <option value="all">{allLabel}</option> : null}
          <option value="">{noneLabel}</option>
          {value &&
          value !== "all" &&
          !query.items.some((item) => item.id === value) ? (
            <option value={value}>{label}</option>
          ) : null}
          {query.items
            .filter(
              (item) => allLabel || item.state === "open" || item.id === value,
            )
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
        </select>
      </label>
      {query.error || failed ? (
        <span role="alert" className="text-red-600">
          {errorLabel}
          {query.error ? (
            <button
              type="button"
              data-testid={`${testId}-retry`}
              onClick={query.reload}
              className="ml-2 underline"
            >
              {retryLabel}
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
