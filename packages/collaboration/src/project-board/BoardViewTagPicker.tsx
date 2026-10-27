// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Plus, Search } from 'lucide-react'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { isImeComposingEvent } from '@wegent/chat-core/ime'
import type { CollaborationTranslate } from '../i18n'
import { useCollaborationPortalTheme } from '../theme'
import { isTagNameTooLong } from '../tagging'

export function BoardViewTagPicker({
  value,
  tags,
  usedTags,
  disabled,
  testId,
  portalContainer,
  translate: t,
  onChange,
}: {
  value: string
  tags: readonly string[]
  usedTags: readonly string[]
  disabled: boolean
  testId: string
  portalContainer: HTMLElement | null
  translate: CollaborationTranslate
  onChange(value: string): void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const portalTheme = useCollaborationPortalTheme()
  const name = query.trim()
  const tooLong = isTagNameTooLong(name)
  const filtered = tags.filter(tag => tag.toLocaleLowerCase().includes(name.toLocaleLowerCase()))
  const canCreate = Boolean(name && !tags.includes(name))
  const choose = (tag: string) => {
    if (disabled || usedTags.includes(tag) || isTagNameTooLong(tag)) return
    onChange(tag)
    setOpen(false)
  }
  const navigate = (event: KeyboardEvent) => {
    if (isImeComposingEvent(event)) return
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []
    )
    if (event.target === searchRef.current && event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      buttons[0]?.click()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        index < 0
          ? event.key === 'ArrowDown'
            ? 0
            : buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
  }
  const optionStyle =
    'flex min-h-11 w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-sm outline-none hover:bg-muted focus:bg-muted disabled:opacity-50 md:min-h-8'
  return (
    <Popover.Root
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (next) setQuery('')
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t('todo.board_view_tag')}
          disabled={disabled}
          data-testid={testId}
          className="flex min-h-11 min-w-28 flex-1 items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-left text-sm text-text-primary outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-50 md:min-h-8"
        >
          <span className="truncate">{value || t('todo.board_view_tag')}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal container={portalContainer}>
        <Popover.Content
          {...portalTheme}
          align="start"
          sideOffset={4}
          collisionPadding={8}
          aria-label={t('todo.board_view_tag')}
          data-testid={`${testId}-popover`}
          data-embedded-browser-occlusion
          className={`${portalTheme.className} z-system-popover flex max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] min-w-56 max-w-[calc(100vw-16px)] flex-col rounded-xl border border-border bg-popover p-1 text-text-primary shadow-lg outline-none`}
          onOpenAutoFocus={event => {
            event.preventDefault()
            searchRef.current?.focus()
          }}
          onEscapeKeyDown={event => event.stopPropagation()}
          onKeyDown={navigate}
        >
          <label className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-2 md:min-h-9">
            <Search className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              autoComplete="off"
              value={query}
              disabled={disabled}
              aria-label={t('todo.board_view_tag_search')}
              aria-controls={listId}
              aria-invalid={tooLong}
              aria-describedby={tooLong ? `${listId}-error` : undefined}
              placeholder={t('todo.board_view_tag_search')}
              data-testid={`${testId}-search`}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted"
              onChange={event => setQuery(event.target.value)}
            />
          </label>
          {tooLong && (
            <p id={`${listId}-error`} role="alert" className="px-2 py-1 text-xs text-error">
              {t('todo.tag_name_too_long')}
            </p>
          )}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={t('todo.board_view_tag')}
            className="max-h-56 min-h-0 overflow-y-auto overscroll-contain pt-1"
          >
            {filtered.map(tag => (
              <button
                key={tag}
                type="button"
                role="option"
                aria-selected={tag === value}
                disabled={disabled || usedTags.includes(tag) || isTagNameTooLong(tag)}
                tabIndex={tag === value ? 0 : -1}
                data-testid={`${testId}-option-${tag}`}
                className={optionStyle}
                onClick={() => choose(tag)}
              >
                <span className="min-w-0 flex-1 truncate">{tag}</span>
                {usedTags.includes(tag) ? (
                  <span className="text-xs text-text-muted">{t('todo.board_view_tag_used')}</span>
                ) : null}
                {tag === value ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
              </button>
            ))}
            {canCreate ? (
              <button
                type="button"
                role="option"
                aria-selected={false}
                disabled={disabled || tooLong}
                tabIndex={-1}
                data-testid={`${testId}-create`}
                className={optionStyle}
                onClick={() => choose(name)}
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {t('todo.board_view_tag_create', undefined, { tag: name })}
                </span>
              </button>
            ) : null}
            {!filtered.length && !canCreate ? (
              <p className="px-2 py-3 text-sm text-text-muted">{t('todo.board_view_tag_empty')}</p>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
