// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Check, ChevronDown, Search, type LucideIcon } from 'lucide-react'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { isImeComposingEvent } from '@wegent/chat-core/ime'
import { useOutsideClick } from '../composer/useOutsideClick'
import type { CollaborationTranslate } from '../i18n'
import type { TargetKind } from './automaticProcessing'

export function AutomaticProcessingTargetPicker({
  kind,
  kindLabel,
  icon: Icon,
  options,
  selectedId,
  onSelect,
  translate,
}: {
  kind: TargetKind
  kindLabel: string
  icon: LucideIcon
  options: { id: string; name: string }[]
  selectedId: string
  onSelect(id: string): void
  translate: CollaborationTranslate
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const visible = options.filter(option =>
    option.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  )
  const activeId =
    visible.find(option => option.id === focusedId)?.id ??
    visible.find(option => option.id === selectedId)?.id ??
    visible[0]?.id
  const selectedName =
    options.find(option => option.id === selectedId)?.name ?? translate('common.select', '请选择')
  const searchLabel = translate('todo.search_processing_target', '搜索处理对象')

  function close(restoreFocus = true) {
    setOpen(false)
    setQuery('')
    setFocusedId(null)
    if (restoreFocus) trigger.current?.focus()
  }
  useOutsideClick(root, open, () => close(false))

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!open || isImeComposingEvent(event)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const nodes = Array.from(
      root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []
    )
    if (!nodes.length) return
    event.preventDefault()
    const index = nodes.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? nodes.length - 1
          : index < 0
            ? event.key === 'ArrowUp'
              ? nodes.length - 1
              : 0
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length
    nodes[next]?.focus()
  }

  return (
    <div ref={root} className="relative" onKeyDown={handleKey}>
      <button
        ref={trigger}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        className={`automatic-processing-selected flex min-h-[68px] w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-shadow ${open ? 'automatic-processing-picker-open' : ''}`}
        data-testid="automatic-processing-target"
        onClick={() => (open ? close() : setOpen(true))}
        type="button"
      >
        <span className="automatic-processing-selected-avatar flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <Icon aria-hidden="true" className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-sm font-medium text-text-primary">
            {selectedName}
          </strong>
          <span className="mt-0.5 block text-xs text-text-secondary">{kindLabel}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? (
        <div
          className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
          data-testid="automatic-processing-target-picker"
        >
          <div className="border-b border-border p-2">
            <label className="!flex h-8 items-center gap-2 rounded-lg border border-border bg-background px-3 keyboard:focus-within:border-focus">
              <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
              <input
                autoFocus
                aria-label={searchLabel}
                className="!h-auto !min-h-0 min-w-0 flex-1 !border-0 !bg-transparent !p-0 text-sm text-text-primary outline-none placeholder:text-text-muted"
                data-testid="automatic-processing-target-search"
                onChange={event => setQuery(event.target.value)}
                placeholder={searchLabel}
                value={query}
              />
            </label>
          </div>
          <div
            id={listId}
            aria-label={translate('todo.processing_target', '处理对象')}
            className="max-h-52 overflow-y-auto p-2"
            role="listbox"
          >
            {visible.map(option => (
              <button
                aria-selected={selectedId === option.id}
                tabIndex={activeId === option.id ? 0 : -1}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-focus"
                data-testid={`automatic-processing-target-option-${kind}-${option.id}`}
                key={option.id}
                onFocus={() => setFocusedId(option.id)}
                onClick={() => {
                  onSelect(option.id)
                  close()
                }}
                role="option"
                type="button"
              >
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                  {option.name}
                </span>
                {selectedId === option.id ? (
                  <Check
                    aria-hidden="true"
                    className="automatic-processing-selected-icon h-4 w-4 shrink-0"
                  />
                ) : null}
              </button>
            ))}
            {!visible.length ? (
              <p className="px-3 py-6 text-center text-sm text-text-secondary">
                {translate('todo.no_matching_processing_target', '没有匹配的处理对象')}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
