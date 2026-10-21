// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ChevronRight, LoaderCircle, SlidersHorizontal, X } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'

import { DialogForm } from '../controls/DialogForm'

function classes(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export interface AgentFormSelectOption {
  label: string
  value: string
}

export interface AgentFormField {
  disabled?: boolean
  label: string
  onChange(value: string): void
  placeholder?: string
  testId: string
  value: string
}

export interface AgentFormSelectField extends AgentFormField {
  options: AgentFormSelectOption[]
}

export interface AgentFormLabels {
  advanced: string
  advancedDescription: string
  cancel: string
  close: string
  owner: string
}

export interface AgentFormAdvancedSummary {
  description: string
  title: string
}

interface AgentFormRuntimeTab {
  onOpen?(): void
  basicLabel: string
  label: string
  summary: string
  error?: string | null
}

export interface AgentFormTestIds {
  backdrop: string
  close: string
  dialog: string
  error: string
  save: string
}

const fieldClassName =
  'w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary shadow-sm outline-none transition-[border-color,box-shadow] placeholder:text-text-muted focus:border-focus focus:ring-2 focus:ring-focus/15 disabled:opacity-50'

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
  modelControl,
  executionControl,
  name,
  onClose,
  onAdvancedOpen,
  onSave,
  owner,
  ownerLabel,
  prompt,
  promptEditor,
  capabilityMode,
  runtime,
  runtimeTab,
  saveDisabled,
  saveLabel,
  savingLabel,
  testIds,
  title,
}: {
  advanced?: ReactNode
  advancedSummary?: AgentFormAdvancedSummary
  busy: boolean
  capabilities?: ReactNode
  description: string
  displayName?: AgentFormField
  error?: string | null
  footerHint?: string
  labels: AgentFormLabels
  loading?: boolean
  loadingLabel?: string
  mcp?: AgentFormField
  model?: AgentFormSelectField
  modelControl?: ReactNode
  executionControl?: ReactNode
  name?: AgentFormField
  namespace?: string
  onClose(): void
  onAdvancedOpen?(): void
  onSave(): void
  owner?: AgentFormSelectField
  ownerLabel: string
  prompt: AgentFormField
  promptEditor?: ReactNode
  capabilityMode?: ReactNode
  runtime?: AgentFormSelectField
  runtimeTab?: AgentFormRuntimeTab
  saveDisabled: boolean
  saveLabel: string
  savingLabel: string
  testIds: AgentFormTestIds
  title: string
}) {
  const titleId = `${testIds.dialog}-title`
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'basic' | 'runtime'>('basic')
  const identityField = displayName ?? name
  const hasAdvancedSettings = Boolean(capabilityMode || capabilities || mcp)
  const modelField = modelControl ?? (model ? <SelectInput busy={busy} field={model} /> : null)

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/30 p-3 md:p-5"
      data-testid={testIds.backdrop}
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <DialogForm
        aria-labelledby={titleId}
        aria-modal="true"
        className="flex max-h-[90dvh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-border bg-popover text-text-primary shadow-xl"
        data-agent-form="shared"
        data-testid={testIds.dialog}
        onSubmit={event => {
          event.preventDefault()
          if (!busy && !saveDisabled) onSave()
        }}
        role="dialog"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-5">
          <div className="min-w-0 space-y-0.5">
            <h2 className="text-heading-sm font-medium text-text-primary" id={titleId}>
              {title}
            </h2>
            <p className="max-w-xl text-sm leading-5 text-text-muted">{description}</p>
          </div>
          <button
            aria-label={labels.close}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary disabled:pointer-events-none disabled:opacity-40 md:h-8 md:w-8"
            data-testid={testIds.close}
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </header>

        {runtimeTab ? (
          <AgentFormTabs
            activeTab={activeTab}
            busy={busy}
            labels={runtimeTab}
            onChange={tab => {
              setActiveTab(tab)
              if (tab === 'runtime') runtimeTab.onOpen?.()
            }}
            prefix={testIds.dialog}
          />
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 px-6 pb-5 pt-2 text-sm text-text-muted">
            <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
            {loadingLabel}
          </p>
        ) : null}
        <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-5 pt-2" hidden={loading}>
          <section
            aria-labelledby={runtimeTab ? `${testIds.dialog}-tab-basic` : undefined}
            className="min-w-0 space-y-4"
            hidden={Boolean(runtimeTab && activeTab !== 'basic')}
            id={`${testIds.dialog}-panel-basic`}
            role={runtimeTab ? 'tabpanel' : undefined}
          >
            <section className="min-w-0 space-y-2">
              {identityField ? <TextInput busy={busy} field={identityField} /> : null}
              {owner ? (
                <SelectInput busy={busy} field={owner} />
              ) : (
                <div className="flex min-h-5 items-center gap-2 text-xs text-text-muted">
                  <span>{labels.owner}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate text-text-secondary">{ownerLabel}</span>
                </div>
              )}
            </section>

            <section className="space-y-4">
              {!runtimeTab ? executionControl : null}
              {!runtimeTab && runtime ? (
                <div className="grid gap-3 md:grid-cols-2">
                  <SelectInput busy={busy} field={runtime} />
                  {modelField}
                </div>
              ) : !runtimeTab ? (
                modelField
              ) : null}
              {promptEditor ?? <TextareaInput busy={busy} field={prompt} />}
            </section>

            {advanced}

            {hasAdvancedSettings ? (
              <section className="border-t border-border pt-2">
                <button
                  aria-expanded={advancedOpen}
                  className="flex min-h-11 w-full items-center gap-2 rounded-md py-1 text-left hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-50 md:min-h-9"
                  data-testid={`${testIds.dialog}-advanced-toggle`}
                  disabled={busy}
                  onClick={() => {
                    if (!advancedOpen) onAdvancedOpen?.()
                    setAdvancedOpen(open => !open)
                  }}
                  type="button"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={classes(
                      'h-4 w-4 shrink-0 text-text-muted transition-transform',
                      advancedOpen ? 'rotate-90' : undefined
                    )}
                  />
                  <span className="flex-1 text-sm text-text-secondary">{labels.advanced}</span>
                  {advancedSummary ? (
                    <span className="truncate text-xs text-text-muted">
                      {advancedSummary.title}
                    </span>
                  ) : null}
                </button>
                {advancedOpen ? (
                  <div className="space-y-4 border-t border-border px-4 py-4">
                    {!capabilityMode ? (
                      <p className="text-xs text-text-muted">
                        {advancedSummary?.description ?? labels.advancedDescription}
                      </p>
                    ) : null}
                    {capabilityMode}
                    {capabilities}
                    {mcp ? <TextareaInput busy={busy} code field={mcp} /> : null}
                  </div>
                ) : null}
              </section>
            ) : null}
          </section>

          {runtimeTab ? (
            <section
              aria-labelledby={`${testIds.dialog}-tab-runtime`}
              className="space-y-4"
              hidden={activeTab !== 'runtime'}
              id={`${testIds.dialog}-panel-runtime`}
              role="tabpanel"
            >
              {executionControl}
              {runtime ? <SelectInput busy={busy} field={runtime} /> : null}
              {modelField}
            </section>
          ) : null}

          {runtimeTab?.error && activeTab === 'basic' ? (
            <p className="text-sm text-destructive" role="alert">
              {runtimeTab.error}
            </p>
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

        <footer
          className={classes(
            'flex flex-wrap items-center gap-3 border-t border-border bg-popover px-6 py-3',
            footerHint || runtimeTab ? 'justify-between' : 'justify-end'
          )}
        >
          {runtimeTab ? (
            <button
              aria-controls={`${testIds.dialog}-panel-runtime`}
              aria-label={`${runtimeTab.label}: ${runtimeTab.summary}`}
              className="flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-lg text-left text-xs text-text-muted hover:text-text-primary disabled:opacity-40 md:min-h-9"
              data-testid={`${testIds.dialog}-runtime-summary`}
              disabled={busy}
              onClick={() => {
                setActiveTab('runtime')
                runtimeTab.onOpen?.()
                document.getElementById(`${testIds.dialog}-tab-runtime`)?.focus()
              }}
              type="button"
            >
              <span className="min-w-0 break-words">{runtimeTab.summary}</span>
              <SlidersHorizontal aria-hidden="true" className="h-4 w-4 shrink-0" />
            </button>
          ) : footerHint ? (
            <p className="max-w-sm text-xs leading-4 text-text-muted">{footerHint}</p>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              className="h-11 rounded-lg px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-40 md:h-9"
              disabled={busy}
              onClick={onClose}
              type="button"
            >
              {labels.cancel}
            </button>
            <button
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-text-primary px-3 text-sm font-medium text-background hover:opacity-80 disabled:opacity-40 md:h-9"
              data-testid={testIds.save}
              disabled={busy || saveDisabled}
              type="submit"
            >
              {busy ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
              {busy ? savingLabel : saveLabel}
            </button>
          </div>
        </footer>
      </DialogForm>
    </div>
  )
}

function AgentFormTabs({
  activeTab,
  busy,
  labels,
  onChange,
  prefix,
}: {
  activeTab: 'basic' | 'runtime'
  busy: boolean
  labels: AgentFormRuntimeTab
  onChange(tab: 'basic' | 'runtime'): void
  prefix: string
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const tabs = ['basic', 'runtime'] as const
  return (
    <div
      aria-label={`${labels.basicLabel} / ${labels.label}`}
      className="mx-6 flex gap-5 border-b border-border"
      role="tablist"
    >
      {tabs.map((tab, index) => (
        <button
          aria-controls={`${prefix}-panel-${tab}`}
          aria-selected={activeTab === tab}
          className={classes(
            'min-h-11 border-b-2 px-1 text-sm disabled:opacity-40 md:min-h-9',
            activeTab === tab
              ? 'border-text-primary text-text-primary'
              : 'border-transparent text-text-muted hover:text-text-primary'
          )}
          data-testid={`${prefix}-tab-${tab}`}
          disabled={busy}
          id={`${prefix}-tab-${tab}`}
          key={tab}
          onClick={() => onChange(tab)}
          onKeyDown={event => {
            const target =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? 1
                  : event.key === 'ArrowLeft' || event.key === 'ArrowRight'
                    ? 1 - index
                    : null
            if (target == null) return
            event.preventDefault()
            onChange(tabs[target]!)
            buttons.current[target]?.focus()
          }}
          ref={element => {
            buttons.current[index] = element
          }}
          role="tab"
          tabIndex={activeTab === tab ? 0 : -1}
          type="button"
        >
          {tab === 'basic' ? labels.basicLabel : labels.label}
        </button>
      ))}
    </div>
  )
}

function TextInput({ busy, field }: { busy: boolean; field: AgentFormField }) {
  return (
    <label className="block space-y-1.5 text-sm text-text-secondary">
      <span>{field.label}</span>
      <input
        className={classes('h-11 md:h-9', fieldClassName)}
        data-testid={field.testId}
        disabled={busy || field.disabled}
        onChange={event => field.onChange(event.target.value)}
        placeholder={field.placeholder}
        value={field.value}
      />
    </label>
  )
}

function SelectInput({ busy, field }: { busy: boolean; field: AgentFormSelectField }) {
  return (
    <label className="block space-y-1.5 text-sm text-text-secondary">
      <span>{field.label}</span>
      <select
        className={classes('h-11 md:h-9', fieldClassName)}
        data-testid={field.testId}
        disabled={busy || field.disabled}
        onChange={event => field.onChange(event.target.value)}
        value={field.value}
      >
        {field.placeholder ? (
          <option disabled value="">
            {field.placeholder}
          </option>
        ) : null}
        {field.options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function TextareaInput({
  busy,
  code = false,
  field,
}: {
  busy: boolean
  code?: boolean
  field: AgentFormField
}) {
  return (
    <label className="block space-y-1.5 text-sm text-text-secondary">
      <span>{field.label}</span>
      <textarea
        className={classes(
          code ? 'min-h-24 font-mono text-code' : 'min-h-20',
          'resize-y py-2.5',
          fieldClassName
        )}
        data-testid={field.testId}
        disabled={busy || field.disabled}
        onChange={event => field.onChange(event.target.value)}
        placeholder={field.placeholder}
        value={field.value}
      />
    </label>
  )
}
