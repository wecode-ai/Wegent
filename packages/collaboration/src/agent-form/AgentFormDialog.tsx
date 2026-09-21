// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot, ChevronRight, LoaderCircle, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { DialogForm } from "../controls/DialogForm";

function classes(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export interface AgentFormSelectOption {
  label: string;
  value: string;
}

export interface AgentFormField {
  disabled?: boolean;
  label: string;
  onChange(value: string): void;
  placeholder?: string;
  testId: string;
  value: string;
}

export interface AgentFormSelectField extends AgentFormField {
  options: AgentFormSelectOption[];
}

export interface AgentFormLabels {
  advanced: string;
  advancedDescription: string;
  capabilitiesSection: string;
  cancel: string;
  close: string;
  owner: string;
}

export interface AgentFormAdvancedSummary {
  description: string;
  title: string;
}

export interface AgentFormTestIds {
  backdrop: string;
  close: string;
  dialog: string;
  error: string;
  save: string;
}

const fieldClassName =
  "w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary shadow-sm outline-none transition-[border-color,box-shadow] placeholder:text-text-muted focus:border-focus focus:ring-2 focus:ring-focus/15 disabled:opacity-50";

export function AgentFormDialog({
  advanced,
  advancedSummary,
  busy,
  capabilities,
  description,
  displayName,
  error,
  footerHint,
  labels,
  loading,
  loadingLabel,
  mcp,
  model,
  name,
  onClose,
  onSave,
  owner,
  ownerLabel,
  prompt,
  promptEditor,
  capabilityMode,
  runtime,
  saveDisabled,
  saveLabel,
  savingLabel,
  testIds,
  title,
}: {
  advanced?: ReactNode;
  advancedSummary?: AgentFormAdvancedSummary;
  busy: boolean;
  capabilities?: ReactNode;
  description: string;
  displayName?: AgentFormField;
  error?: string | null;
  footerHint: string;
  labels: AgentFormLabels;
  loading?: boolean;
  loadingLabel?: string;
  mcp?: AgentFormField;
  model: AgentFormSelectField;
  name?: AgentFormField;
  namespace?: string;
  onClose(): void;
  onSave(): void;
  owner?: AgentFormSelectField;
  ownerLabel: string;
  prompt: AgentFormField;
  promptEditor?: ReactNode;
  capabilityMode?: ReactNode;
  runtime?: AgentFormSelectField;
  saveDisabled: boolean;
  saveLabel: string;
  savingLabel: string;
  testIds: AgentFormTestIds;
  title: string;
}) {
  const titleId = `${testIds.dialog}-title`;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const identityField = displayName ?? name;
  const hasAdvancedSettings = Boolean(capabilityMode || capabilities || mcp);

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/30 p-5"
      data-testid={testIds.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <DialogForm
        aria-labelledby={titleId}
        aria-modal="true"
        className="flex max-h-[86dvh] w-full max-w-[700px] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-text-primary shadow-xl"
        data-agent-form="shared"
        data-testid={testIds.dialog}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !saveDisabled) onSave();
        }}
        role="dialog"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-5">
          <div className="min-w-0 space-y-0.5">
            <h2
              className="text-heading-sm font-medium text-text-primary"
              id={titleId}
            >
              {title}
            </h2>
            <p className="max-w-xl text-sm leading-5 text-text-muted">
              {description}
            </p>
          </div>
          <button
            aria-label={labels.close}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
            data-testid={testIds.close}
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 space-y-5 overflow-y-auto px-6 pb-5 pt-3">
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-text-muted">
              <LoaderCircle
                aria-hidden="true"
                className="h-4 w-4 animate-spin"
              />
              {loadingLabel}
            </p>
          ) : null}

          <section className="grid gap-4 md:grid-cols-[64px_minmax(0,1fr)]">
            <div className="hidden h-16 w-16 items-center justify-center rounded-2xl bg-surface text-text-secondary md:flex">
              <Bot aria-hidden="true" className="h-7 w-7" />
            </div>
            <div className="min-w-0 space-y-3">
              {identityField ? (
                <TextInput busy={busy} field={identityField} />
              ) : null}
              {owner ? (
                <SelectInput busy={busy} field={owner} />
              ) : (
                <div className="flex min-h-5 items-center gap-2 text-xs text-text-muted">
                  <span>{labels.owner}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate text-text-secondary">
                    {ownerLabel}
                  </span>
                </div>
              )}
            </div>
          </section>

          <section className="space-y-3">
            <SectionHeading>{labels.capabilitiesSection}</SectionHeading>
            <div
              className={classes(
                "grid gap-3",
                runtime ? "md:grid-cols-2" : "grid-cols-1",
              )}
            >
              {runtime ? <SelectInput busy={busy} field={runtime} /> : null}
              <SelectInput busy={busy} field={model} />
            </div>
            {promptEditor ?? <TextareaInput busy={busy} field={prompt} />}
          </section>

          {advanced}

          {hasAdvancedSettings ? (
            <section className="overflow-hidden rounded-xl border border-border">
              <button
                aria-expanded={advancedOpen}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-50"
                data-testid={`${testIds.dialog}-advanced-toggle`}
                disabled={busy}
                onClick={() => setAdvancedOpen((open) => !open)}
                type="button"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={classes(
                    "h-4 w-4 shrink-0 text-text-muted transition-transform",
                    advancedOpen ? "rotate-90" : undefined,
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-text-primary">
                    {advancedSummary?.title ?? labels.advanced}
                  </span>
                  <span className="mt-0.5 block text-xs text-text-muted">
                    {advancedSummary?.description ?? labels.advancedDescription}
                  </span>
                </span>
                {advancedSummary ? (
                  <span className="shrink-0 text-xs text-text-muted">
                    {labels.advanced}
                  </span>
                ) : null}
              </button>
              {advancedOpen ? (
                <div className="space-y-4 border-t border-border px-4 py-4">
                  {capabilityMode}
                  {capabilities}
                  {mcp ? <TextareaInput busy={busy} code field={mcp} /> : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {error ? (
            <p
              className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500"
              data-testid={testIds.error}
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex min-h-16 items-center justify-between gap-3 border-t border-border bg-popover px-6 py-3">
          <p className="max-w-sm text-xs leading-4 text-text-muted">
            {footerHint}
          </p>
          <div className="flex items-center gap-2">
            <button
              className="h-9 rounded-lg px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-40"
              disabled={busy}
              onClick={onClose}
              type="button"
            >
              {labels.cancel}
            </button>
            <button
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-text-primary px-3 text-sm font-medium text-background hover:opacity-80 disabled:opacity-40"
              data-testid={testIds.save}
              disabled={busy || saveDisabled}
              type="submit"
            >
              {busy ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin"
                />
              ) : null}
              {busy ? savingLabel : saveLabel}
            </button>
          </div>
        </footer>
      </DialogForm>
    </div>
  );
}

function TextInput({ busy, field }: { busy: boolean; field: AgentFormField }) {
  return (
    <label className="space-y-1.5 text-sm text-text-secondary">
      <span>{field.label}</span>
      <input
        className={classes("h-10", fieldClassName)}
        data-testid={field.testId}
        disabled={busy || field.disabled}
        onChange={(event) => field.onChange(event.target.value)}
        placeholder={field.placeholder}
        value={field.value}
      />
    </label>
  );
}

function SelectInput({
  busy,
  field,
}: {
  busy: boolean;
  field: AgentFormSelectField;
}) {
  return (
    <label className="block space-y-1.5 text-sm text-text-secondary">
      <span>{field.label}</span>
      <select
        className={classes("h-10", fieldClassName)}
        data-testid={field.testId}
        disabled={busy || field.disabled}
        onChange={(event) => field.onChange(event.target.value)}
        value={field.value}
      >
        {field.placeholder ? (
          <option disabled value="">
            {field.placeholder}
          </option>
        ) : null}
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextareaInput({
  busy,
  code = false,
  field,
}: {
  busy: boolean;
  code?: boolean;
  field: AgentFormField;
}) {
  return (
    <label className="block space-y-1.5 text-sm text-text-secondary">
      <span>{field.label}</span>
      <textarea
        className={classes(
          code ? "min-h-24 font-mono text-code" : "min-h-20",
          "resize-y py-2.5",
          fieldClassName,
        )}
        data-testid={field.testId}
        disabled={busy || field.disabled}
        onChange={(event) => field.onChange(event.target.value)}
        placeholder={field.placeholder}
        value={field.value}
      />
    </label>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h3 className="shrink-0 text-sm font-medium text-text-primary">
        {children}
      </h3>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
