// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type ChangeEventHandler } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, Search } from "lucide-react";

import type { CollaborationPriority, CollaborationStatus } from "../types";
import { useCollaborationPortalTheme } from "../theme";

export interface IssueDetailSelectProps<TValue extends string> {
  value: TValue;
  options: Array<{ value: TValue; label: string }>;
  testId: string;
  accessibleLabel: string;
  className?: string;
  disabled?: boolean;
  includeUnset?: boolean;
  unsetLabel?: string;
  onChange(value: TValue): void;
}

export function IssueDetailSelect<TValue extends string>({
  value,
  options,
  testId,
  accessibleLabel,
  className,
  disabled,
  includeUnset,
  unsetLabel = "未设置",
  onChange,
}: IssueDetailSelectProps<TValue>) {
  const handleChange: ChangeEventHandler<HTMLSelectElement> = (event) => {
    onChange(event.target.value as TValue);
  };
  return (
    <select
      data-testid={testId}
      aria-label={accessibleLabel}
      value={value}
      onChange={handleChange}
      disabled={disabled}
      className={className}
    >
      {includeUnset ? <option value="">{unsetLabel}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function IssueDetailStatusSelect({
  statuses,
  ...props
}: Omit<IssueDetailSelectProps<string>, "options"> & {
  statuses: Array<Pick<CollaborationStatus, "id" | "name">>;
}) {
  return (
    <IssueDetailSelect
      {...props}
      options={statuses.map((status) => ({
        value: status.id,
        label: status.name,
      }))}
    />
  );
}

export function IssueDetailPrioritySelect({
  labels,
  ...props
}: Omit<IssueDetailSelectProps<CollaborationPriority>, "options"> & {
  labels: Record<CollaborationPriority, string>;
}) {
  return (
    <IssueDetailSelect
      {...props}
      options={(["none", "low", "medium", "high", "urgent"] as const).map(
        (value) => ({
          value,
          label: labels[value],
        }),
      )}
    />
  );
}

export interface IssueDetailSearchableSelectOption<
  TValue extends string = string,
> {
  value: TValue;
  label: string;
  group?: string;
  searchText?: string;
}

export interface IssueDetailSearchableSelectProps<TValue extends string> {
  value: TValue;
  options: IssueDetailSearchableSelectOption<TValue>[];
  testId: string;
  accessibleLabel: string;
  className?: string;
  disabled?: boolean;
  searchPlaceholder: string;
  emptyLabel: string;
  onChange(value: TValue): void;
}

export function IssueDetailSearchableSelect<TValue extends string>({
  value,
  options,
  testId,
  accessibleLabel,
  className,
  disabled,
  searchPlaceholder,
  emptyLabel,
  onChange,
}: IssueDetailSearchableSelectProps<TValue>) {
  const portalTheme = useCollaborationPortalTheme();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = normalizedQuery
    ? options.filter((option) =>
        `${option.label} ${option.searchText ?? ""} ${option.group ?? ""}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : options;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid={testId}
          data-value={value}
          aria-label={accessibleLabel}
          aria-haspopup="listbox"
          disabled={disabled}
          className={className}
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...portalTheme}
          role="listbox"
          aria-label={accessibleLabel}
          data-testid={`${testId}-menu`}
          sideOffset={4}
          collisionPadding={8}
          style={portalTheme.style}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchInputRef.current?.focus({ preventScroll: true });
          }}
          className={`${portalTheme.className} z-system-popover flex max-h-[min(320px,var(--radix-popover-content-available-height))] w-72 flex-col overflow-hidden rounded-xl border border-border bg-background p-1.5 text-text-primary shadow-lg`}
        >
          <label className="flex h-8 shrink-0 items-center gap-2 rounded-lg bg-muted px-2.5 text-text-muted">
            <Search className="h-3.5 w-3.5 shrink-0" />
            <input
              ref={searchInputRef}
              data-testid={`${testId}-search`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>
          <div className="mt-1 min-h-0 overflow-y-auto overscroll-contain">
            {visibleOptions.map((option, index) => {
              const previousGroup = visibleOptions[index - 1]?.group;
              const showGroup = Boolean(
                option.group && option.group !== previousGroup,
              );
              return (
                <div key={option.value}>
                  {showGroup ? (
                    <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-text-muted">
                      {option.group}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    data-testid={`${testId}-option-${option.value || "empty"}`}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted ${
                      option.value === value ? "bg-muted font-medium" : ""
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {option.label}
                    </span>
                    {option.value === value ? (
                      <Check className="h-3.5 w-3.5 shrink-0" />
                    ) : null}
                  </button>
                </div>
              );
            })}
            {visibleOptions.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-text-muted">
                {emptyLabel}
              </p>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
