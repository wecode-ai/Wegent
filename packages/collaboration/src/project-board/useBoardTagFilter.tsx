// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import * as Popover from '@radix-ui/react-popover'
import { useRef, useState } from 'react'
import { ChevronDown, Search, Tag, X } from 'lucide-react'
import type { CollaborationTranslate } from '../i18n'
import { useCollaborationPortalTheme } from '../theme'
import { Tooltip } from '../issue-detail/Tooltip'

function BoardTagFilter({
  tags,
  selected,
  onChange,
  translate: t,
}: {
  tags: readonly string[]
  selected: string[]
  onChange(tags: string[]): void
  translate: CollaborationTranslate
}) {
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const theme = useCollaborationPortalTheme()
  const options = [...new Set([...tags, ...selected])].filter(tag =>
    tag.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  )
  const label = selected.length ? selected.join(', ') : t('todo.board_all_tags')
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Popover.Root
        onOpenChange={open => {
          if (open) setQuery('')
        }}
      >
        <Tooltip label={label} side="bottom">
          <Popover.Trigger asChild>
            <button
              ref={triggerRef}
              type="button"
              data-testid="cloud-board-tag-filter"
              aria-label={t('todo.board_filter_tag')}
              className={`project-board-compact-action inline-flex h-8 max-w-52 items-center gap-1.5 rounded-lg border px-3 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus max-md:h-11 ${selected.length ? 'border-text-primary/30 bg-muted text-text-primary' : 'border-border bg-background text-text-secondary'}`}
            >
              <Tag className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="project-board-action-label truncate">{label}</span>
              <ChevronDown
                className="project-board-action-chevron h-3 w-3 shrink-0"
                aria-hidden="true"
              />
            </button>
          </Popover.Trigger>
        </Tooltip>
        <Popover.Portal>
          <Popover.Content
            {...theme}
            align="start"
            sideOffset={4}
            collisionPadding={8}
            aria-label={t('todo.board_filter_tag')}
            data-testid="cloud-board-tag-filter-popover"
            data-embedded-browser-occlusion
            onOpenAutoFocus={event => {
              event.preventDefault()
              searchRef.current?.focus()
            }}
            onEscapeKeyDown={event => event.stopPropagation()}
            className={`${theme.className} z-system-popover w-64 max-w-[calc(100vw-16px)] rounded-xl border border-border bg-popover p-1 text-text-primary shadow-lg`}
          >
            <label className="flex min-h-9 items-center gap-2 border-b border-border px-2 max-md:min-h-11">
              <Search className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                data-testid="cloud-board-tag-filter-search"
                aria-label={t('todo.board_search_tags')}
                placeholder={t('todo.board_search_tags')}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </label>
            <div
              role="group"
              aria-label={t('todo.board_filter_tag')}
              className="max-h-56 overflow-y-auto overscroll-contain pt-1"
            >
              {options.map(tag => (
                <label
                  key={tag}
                  className="flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm hover:bg-muted focus-within:bg-muted max-md:min-h-11"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(tag)}
                    aria-label={tag}
                    data-testid={`cloud-board-tag-filter-option-${tag}`}
                    onChange={() =>
                      onChange(
                        selected.includes(tag)
                          ? selected.filter(value => value !== tag)
                          : [...selected, tag]
                      )
                    }
                  />
                  <span className="min-w-0 break-words">{tag}</span>
                </label>
              ))}
              {!options.length ? (
                <p className="px-2 py-3 text-sm text-text-muted">
                  {t('todo.board_no_matching_tags')}
                </p>
              ) : null}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {selected.length ? (
        <button
          type="button"
          data-testid="cloud-board-tag-filter-clear"
          aria-label={t('todo.board_clear_tag_filter')}
          title={t('todo.board_clear_tag_filter')}
          onClick={() => {
            onChange([])
            triggerRef.current?.focus()
          }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:h-11 max-md:w-11"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}

export function useBoardTagFilter({
  scope,
  tags,
  translate,
}: {
  scope: string
  tags: readonly string[]
  translate: CollaborationTranslate
}) {
  const [selection, setSelection] = useState<{ scope: string; tags: string[] }>({ scope, tags: [] })
  if (selection.scope !== scope) setSelection({ scope, tags: [] })
  const selected = selection.scope === scope ? selection.tags : []
  return {
    tags: selected,
    control: (
      <BoardTagFilter
        key={scope}
        tags={tags}
        selected={selected}
        translate={translate}
        onChange={values => setSelection({ scope, tags: values })}
      />
    ),
  }
}
