import { useRef } from 'react'
import { DialogSurface } from '../controls/DialogSurface'
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { normalizeSelectValue } from '../controls/selectValue'
import { TextField as ControlInput } from '../controls/TextField'
import { Textarea as ControlTextarea } from '../controls/Textarea'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { ChevronRight, LoaderCircle, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
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
interface ConfigurationValue {
  label: string
  value: string
}
export interface AgentFormRuntimeSettings {
  onOpen?(): void
  label: string
  environment?: ConfigurationValue
  model: ConfigurationValue
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
  'w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary shadow-sm outline-none transition-[border-color,box-shadow] placeholder:text-text-muted keyboard:focus:border-focus keyboard:focus:ring-2 keyboard:focus:ring-focus/15 disabled:opacity-50'

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
  runtimeSettings,
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
  runtimeSettings?: AgentFormRuntimeSettings
  saveDisabled: boolean
  saveLabel: string
  savingLabel: string
  testIds: AgentFormTestIds
  title: string
}) {
  const dialogRef = useRef<HTMLFormElement>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  const titleId = `${testIds.dialog}-title`
  const identityField = displayName ?? name
  const hasCapabilities = Boolean(capabilityMode || capabilities || mcp)
  const modelField = modelControl ?? (model ? <SelectInput busy={busy} field={model} /> : null)
  const runtimeControls = (
    <>
      {executionControl}
      {runtime ? <SelectInput busy={busy} field={runtime} /> : null}
      {modelField}
    </>
  )

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/30 p-3 md:p-5"
      data-testid={testIds.backdrop}
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <DialogSurface
        onClose={() => {
          if (!busy) onClose()
        }}
        render={
          <DialogForm
            ref={dialogRef}
            tabIndex={-1}
            aria-labelledby={titleId}
            className="flex max-h-[90dvh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-border bg-popover text-text-primary shadow-xl"
            data-agent-form="shared"
            data-testid={testIds.dialog}
            onSubmit={event => {
              event.preventDefault()
              if (!busy && !saveDisabled) onSave()
            }}
          />
        }
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-5">
          <div className="min-w-0 space-y-1">
            <h2 className="text-heading-sm font-medium text-text-primary" id={titleId}>
              {title}
            </h2>
            <p className="max-w-prose text-sm leading-5 text-text-secondary">{description}</p>
          </div>
          <ControlButton
            variant="unstyled"
            aria-label={labels.close}
            title={labels.close}
            showTooltip={false}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-40 md:h-8 md:w-8"
            data-testid={testIds.close}
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </ControlButton>
        </header>
        {loading ? (
          <p
            className="flex items-center gap-2 px-6 pb-5 text-sm text-text-secondary"
            role="status"
          >
            <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
            {loadingLabel}
          </p>
        ) : null}
        <div className="min-h-0 space-y-5 overflow-y-auto px-6 pb-5" hidden={loading}>
          <section className="min-w-0 space-y-2" data-testid={`${testIds.dialog}-panel-basic`}>
            {identityField ? <TextInput busy={busy} field={identityField} /> : null}
            {owner ? (
              <SelectInput busy={busy} field={owner} />
            ) : (
              <dl className="flex min-w-0 flex-wrap gap-x-2 text-xs text-text-secondary">
                <dt>{labels.owner}</dt>
                <dd className="min-w-0 break-words">{ownerLabel}</dd>
              </dl>
            )}
          </section>

          <section className="min-w-0">
            {promptEditor ?? <TextareaInput busy={busy} field={prompt} />}
          </section>
          {advanced}

          {hasCapabilities ? (
            <ConfigurationDisclosure
              title={labels.advanced}
              open={advancedOpen}
              busy={busy}
              testId={`${testIds.dialog}-advanced-toggle`}
              panelId={`${testIds.dialog}-panel-capabilities`}
              summary={
                advancedSummary ? (
                  <>
                    <span className="block text-sm text-text-primary">{advancedSummary.title}</span>
                    <span className="mt-1 block text-xs leading-5 text-text-secondary">
                      {advancedSummary.description}
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-text-secondary">{labels.advancedDescription}</span>
                )
              }
              onToggle={() => {
                if (!advancedOpen) onAdvancedOpen?.()
                setAdvancedOpen(value => !value)
              }}
            >
              {capabilityMode}
              {capabilities}
              {mcp ? <TextareaInput busy={busy} code field={mcp} /> : null}
            </ConfigurationDisclosure>
          ) : null}

          {runtimeSettings ? (
            <section>
              <ConfigurationDisclosure
                title={runtimeSettings.label}
                open={runtimeOpen}
                busy={busy}
                keepMounted
                testId={`${testIds.dialog}-tab-runtime`}
                panelId={`${testIds.dialog}-panel-runtime`}
                summary={
                  <span
                    className="block space-y-1"
                    data-testid={`${testIds.dialog}-runtime-summary`}
                  >
                    {[runtimeSettings.environment, runtimeSettings.model]
                      .filter(Boolean)
                      .map((field, index) => (
                        <span
                          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-sm"
                          key={index}
                        >
                          <span className="text-text-secondary">{field!.label}</span>
                          <span className="min-w-0 break-words text-text-primary">
                            {field!.value}
                          </span>
                        </span>
                      ))}
                  </span>
                }
                onToggle={() => {
                  if (!runtimeOpen) runtimeSettings.onOpen?.()
                  setRuntimeOpen(value => !value)
                }}
              >
                {runtimeControls}
              </ConfigurationDisclosure>
              {runtimeSettings.error ? (
                <p className="mt-2 text-sm text-destructive" role="alert">
                  {runtimeSettings.error}
                </p>
              ) : null}
            </section>
          ) : (
            runtimeControls
          )}

          {error ? (
            <p
              className="rounded-md border border-destructive/30 p-3 text-sm text-destructive"
              data-testid={testIds.error}
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-border bg-popover px-6 py-3">
          {footerHint ? (
            <p className="mr-auto max-w-prose text-xs leading-5 text-text-secondary">
              {footerHint}
            </p>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <ControlButton
              variant="unstyled"
              className="h-11 rounded-md px-3 text-sm text-text-primary hover:bg-muted disabled:opacity-40 md:h-9"
              data-testid={`${testIds.dialog}-cancel`}
              disabled={busy}
              onClick={onClose}
              type="button"
            >
              {labels.cancel}
            </ControlButton>
            <ControlButton
              variant="primary"
              size="sm"
              className="inline-flex h-11 items-center gap-2 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:opacity-80 disabled:opacity-40 md:h-9"
              data-testid={testIds.save}
              disabled={busy || saveDisabled}
              type="submit"
            >
              {busy ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
              {busy ? savingLabel : saveLabel}
            </ControlButton>
          </div>
        </footer>
      </DialogSurface>
    </div>
  )
}

function ConfigurationDisclosure({
  title,
  open,
  busy,
  summary,
  onToggle,
  testId,
  panelId,
  children,
  keepMounted = false,
}: {
  title: string
  open: boolean
  busy: boolean
  summary: ReactNode
  onToggle(): void
  testId: string
  panelId: string
  children: ReactNode
  keepMounted?: boolean
}) {
  return (
    <section className="border-t border-border">
      <ControlButton
        variant="unstyled"
        aria-expanded={open}
        aria-controls={panelId}
        aria-labelledby={`${panelId}-heading`}
        className="flex min-h-11 w-full items-start gap-3 rounded-md py-4 text-left hover:bg-muted/40 disabled:opacity-50"
        data-testid={testId}
        disabled={busy}
        onClick={onToggle}
        type="button"
      >
        <ChevronRight
          aria-hidden="true"
          className={classes(
            'mt-0.5 h-4 w-4 shrink-0 text-text-secondary',
            open ? 'rotate-90' : undefined
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-text-primary" id={`${panelId}-heading`}>
            {title}
          </span>
          {!open ? <span className="mt-2 block">{summary}</span> : null}
        </span>
      </ControlButton>
      <div className="space-y-4 pb-4" id={panelId} hidden={!open}>
        {open || keepMounted ? children : null}
      </div>
    </section>
  )
}

function TextInput({ busy, field }: { busy: boolean; field: AgentFormField }) {
  return (
    <label className="block space-y-1.5 text-sm text-text-secondary">
      <span>{field.label}</span>
      <ControlInput
        className="w-full transition-[border-color,box-shadow] placeholder:text-text-muted disabled:opacity-50"
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
      <SelectRoot
        disabled={busy || field.disabled}
        onValueChange={selectedValue => {
          if (selectedValue !== null) return field.onChange(selectedValue)
        }}
        value={normalizeSelectValue(field.value)}
      >
        <SelectTrigger
          aria-label={field.label}
          className="w-full transition-[border-color,box-shadow] placeholder:text-text-muted disabled:opacity-50"
          data-testid={field.testId}
        />
        <SelectContent>
          {field.placeholder ? (
            <SelectItem disabled value="">
              {field.placeholder}
            </SelectItem>
          ) : null}
          {field.options.map(option => (
            <SelectItem key={option.value} value={String(option.value)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectRoot>
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
      <ControlTextarea
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
