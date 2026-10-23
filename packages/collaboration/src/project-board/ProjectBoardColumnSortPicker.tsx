// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import * as Popover from '@radix-ui/react-popover'
import { ArrowDown, ArrowDownWideNarrow, ArrowUp, Check, ChevronDown, Plus, X } from 'lucide-react'
import { useId, useState, type ComponentType } from 'react'
import { Tooltip } from '../issue-detail/Tooltip'
import { useCollaborationPortalTheme } from '../theme'
import {
  projectBoardSortField,
  projectBoardSortModes,
  type ProjectBoardSort,
  type ProjectBoardSortLabels,
  type ProjectBoardSortRule,
} from './projectBoardSorting'

const focusStyle = 'outline-none focus-visible:ring-2 focus-visible:ring-focus/30'
const iconButtonStyle = `flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary disabled:opacity-30 md:h-7 md:w-7 ${focusStyle}`

function RulePicker({
  rule,
  available,
  labels,
  testId,
  onChange,
}: {
  rule: ProjectBoardSortRule
  available: ProjectBoardSort
  labels: ProjectBoardSortLabels
  testId: string
  onChange(value: ProjectBoardSortRule): void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid={testId}
          className={`flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-border px-2 text-left text-sm hover:bg-muted md:min-h-8 ${focusStyle}`}
        >
          <span className="truncate">{labels[rule]}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Content
        align="start"
        sideOffset={4}
        collisionPadding={12}
        aria-label={labels.label}
        data-testid={`${testId}-options`}
        className="z-system-popover w-56 rounded-xl border border-border bg-popover p-1 text-text-primary shadow-xl outline-none"
        onOpenAutoFocus={event => {
          event.preventDefault()
          if (event.target instanceof HTMLElement) {
            event.target.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
          }
        }}
      >
        {available.map(mode => (
          <button
            key={mode}
            type="button"
            data-testid={`${testId}-${mode}`}
            aria-pressed={mode === rule}
            className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted md:min-h-8 ${focusStyle}`}
            onClick={() => {
              onChange(mode)
              setOpen(false)
            }}
          >
            <span className="flex-1">{labels[mode]}</span>
            {mode === rule ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
          </button>
        ))}
      </Popover.Content>
    </Popover.Root>
  )
}

function RuleAction({
  label,
  testId,
  icon: Icon,
  disabled,
  onClick,
}: {
  label: string
  testId: string
  icon: ComponentType<{ className?: string }>
  disabled?: boolean
  onClick(): void
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        data-testid={testId}
        className={iconButtonStyle}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </button>
    </Tooltip>
  )
}

export function ProjectBoardColumnSortPicker({
  columnKey,
  columnLabel,
  labels,
  value,
  onChange,
  portalContainer,
}: {
  columnKey: string
  columnLabel: string
  labels: ProjectBoardSortLabels
  value: ProjectBoardSort
  onChange(value: ProjectBoardSort): void
  portalContainer?: HTMLElement | null
}) {
  const portalTheme = useCollaborationPortalTheme()
  const titleId = useId()
  const descriptionId = useId()
  const label = `${columnLabel} · ${labels.label}`
  const summary = value.length ? value.map(rule => labels[rule]).join(' → ') : labels.manual
  const testId = `cloud-board-sort-by-${columnKey}`
  const unusedModes = projectBoardSortModes.filter(
    mode => !value.some(rule => projectBoardSortField(rule) === projectBoardSortField(mode))
  )
  const moveRule = (index: number, offset: number) => {
    const next = [...value]
    ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
    onChange(next)
  }

  return (
    <Popover.Root>
      <Tooltip label={`${label}: ${summary}`} side="bottom" align="end">
        <Popover.Trigger asChild>
          <button
            type="button"
            data-testid={testId}
            aria-label={label}
            data-sort-rules={value.join(',') || 'manual'}
            className={`${iconButtonStyle} relative data-[state=open]:bg-muted data-[state=open]:text-text-primary`}
          >
            <ArrowDownWideNarrow className="h-4 w-4" aria-hidden="true" />
            {value.length > 1 ? (
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-text-primary px-1 text-xs text-background"
              >
                {value.length}
              </span>
            ) : null}
          </button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal container={portalContainer}>
        <Popover.Content
          {...portalTheme}
          align="end"
          sideOffset={6}
          collisionPadding={12}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          data-testid={`${testId}-popover`}
          data-embedded-browser-occlusion
          className={`${portalTheme.className} z-system-popover w-[400px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-popover p-3 text-text-primary shadow-xl outline-none`}
        >
          <div className="mb-3">
            <h3 id={titleId} className="text-sm font-medium">
              {label}
            </h3>
            <p id={descriptionId} className="mt-1 text-xs text-text-muted">
              {value.length ? labels.description : labels.manual}
            </p>
          </div>
          <ol className="space-y-2">
            {value.map((rule, index) => (
              <li
                key={index}
                data-testid={`${testId}-rule-${index}`}
                className="flex items-center gap-1"
              >
                <span
                  aria-hidden="true"
                  className="w-5 shrink-0 text-center text-xs tabular-nums text-text-muted"
                >
                  {index + 1}
                </span>
                <RulePicker
                  rule={rule}
                  available={projectBoardSortModes.filter(
                    mode =>
                      mode === rule ||
                      projectBoardSortField(mode) === projectBoardSortField(rule) ||
                      unusedModes.includes(mode)
                  )}
                  labels={labels}
                  testId={`${testId}-rule-${index}-mode`}
                  onChange={mode =>
                    onChange(
                      value.map((current, position) => (position === index ? mode : current))
                    )
                  }
                />
                <RuleAction
                  label={labels.moveUp}
                  testId={`${testId}-rule-${index}-up`}
                  icon={ArrowUp}
                  disabled={index === 0}
                  onClick={() => moveRule(index, -1)}
                />
                <RuleAction
                  label={labels.moveDown}
                  testId={`${testId}-rule-${index}-down`}
                  icon={ArrowDown}
                  disabled={index === value.length - 1}
                  onClick={() => moveRule(index, 1)}
                />
                <RuleAction
                  label={labels.remove}
                  testId={`${testId}-rule-${index}-remove`}
                  icon={X}
                  onClick={() => onChange(value.filter((_, position) => position !== index))}
                />
              </li>
            ))}
          </ol>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
            <button
              type="button"
              data-testid={`${testId}-add`}
              disabled={!unusedModes.length}
              className={`flex min-h-11 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted disabled:opacity-30 md:min-h-8 ${focusStyle}`}
              onClick={() => {
                if (unusedModes[0]) onChange([...value, unusedModes[0]])
              }}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {labels.add}
            </button>
            <button
              type="button"
              data-testid={`${testId}-manual`}
              aria-pressed={!value.length}
              className={`flex min-h-11 items-center gap-1 rounded-md px-2 text-sm text-text-secondary hover:bg-muted md:min-h-8 ${focusStyle}`}
              onClick={() => onChange([])}
            >
              {!value.length ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
              {labels.manual}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
