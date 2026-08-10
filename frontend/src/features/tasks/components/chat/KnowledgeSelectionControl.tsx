// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'

import { SelectionIndicator } from '@/components/ui/selection-indicator'

export type KnowledgeSelectionState = 'unchecked' | 'checked' | 'mixed'

interface KnowledgeSelectionControlProps {
  state: KnowledgeSelectionState
  onToggle: () => void
  label: string
  testId: string
  disabled?: boolean
  title?: string
}

export function KnowledgeSelectionControl({
  state,
  onToggle,
  label,
  testId,
  disabled = false,
  title,
}: KnowledgeSelectionControlProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'mixed' ? 'mixed' : state === 'checked'}
      aria-label={label}
      disabled={disabled}
      title={title}
      className="group flex h-11 w-11 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-base disabled:cursor-not-allowed disabled:opacity-60 md:h-9 md:w-9"
      onClick={event => {
        event.stopPropagation()
        onToggle()
      }}
      data-testid={testId}
    >
      <SelectionIndicator
        checked={state === 'checked'}
        indeterminate={state === 'mixed'}
        mixedIcon="bar"
      />
    </button>
  )
}
