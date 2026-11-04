import { useEffect, useState } from "react";
import type { MilestonesApi } from "./types";
import { useMilestones } from "./useMilestones";

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
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!api) return null;
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm">
      <label className="flex min-w-0 max-w-full items-center gap-2">
        <span
          className={
            compact
              ? "sr-only"
              : "shrink-0 whitespace-nowrap text-text-secondary"
          }
        >
          {label}
        </span>
        <select
          data-testid={testId}
          aria-label={label}
          title={`${label}: ${query.items.find((item) => item.id === value)?.title ?? (value === "all" ? allLabel : value === undefined ? placeholder : noneLabel) ?? label}`}
          value={value === undefined ? "__unselected__" : (value ?? "")}
          disabled={disabled || busy || query.loading || query.error}
          className={`min-h-11 min-w-0 truncate ${compact ? "max-w-32" : "max-w-56"} rounded-md border border-border bg-background px-2 text-text-primary md:min-h-8`}
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
