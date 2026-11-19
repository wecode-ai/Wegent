import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { normalizeSelectValue } from '../controls/selectValue'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode, Ref } from 'react'
import type {
  CollaborationProjectView,
  CollaborationProjectViewOption,
} from './projectViewNavigation'

interface ProjectViewSwitcherProps<View extends CollaborationProjectView> {
  ariaLabel?: string
  compact: boolean
  options: CollaborationProjectViewOption<View>[]
  value: View
  compactIcon?: ReactNode
  containerRef?: Ref<HTMLElement>
  onChange(view: View): void
}

export function FlatProjectViewSwitcher<View extends CollaborationProjectView>({
  ariaLabel,
  compact,
  compactIcon,
  containerRef,
  onChange,
  options,
  value,
}: ProjectViewSwitcherProps<View>) {
  if (compact) {
    return (
      <span
        ref={containerRef}
        className="electron-titlebar-interactive-region relative z-10 ml-2 inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-border bg-background px-2.5 text-xs text-text-secondary md:min-h-8"
      >
        <SelectRoot
          value={normalizeSelectValue(value)}
          onValueChange={selectedValue => {
            if (selectedValue !== null) return onChange(selectedValue as View)
          }}
        >
          <SelectTrigger
            data-testid="collaboration-project-view-select"
            data-available-views={options.map(option => option.id).join(' ')}
            density="compact"
            appearance="plain"
            aria-label={ariaLabel ?? '视图切换'}
            className="min-w-0 flex-1 cursor-pointer"
          />
          <SelectContent>
            {options.map(option => (
              <SelectItem key={option.id} value={String(option.id)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
        {compactIcon}
      </span>
    )
  }

  return (
    <nav
      ref={containerRef}
      aria-label={ariaLabel}
      className="electron-titlebar-interactive-region relative z-10 ml-8 flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {options.map(option => (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid={option.testId}
          key={option.id}
          aria-current={value === option.id ? 'page' : undefined}
          onClick={() => onChange(option.id)}
          className={
            value === option.id
              ? 'rounded-md bg-background px-3.5 py-1 text-sm font-medium text-text-primary shadow-sm'
              : 'rounded-md px-3.5 py-1 text-sm text-text-secondary hover:text-text-primary'
          }
        >
          {option.label}
        </ControlButton>
      ))}
    </nav>
  )
}
