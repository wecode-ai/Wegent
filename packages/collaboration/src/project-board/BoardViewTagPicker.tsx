// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ChevronDown, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { SearchableSelect } from '../controls/SearchableSelect'
import type { CollaborationTranslate } from '../i18n'
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
  const [query, setQuery] = useState('')
  const errorId = useId()
  const name = query.trim()
  const tooLong = isTagNameTooLong(name)
  const filtered = tags.filter(tag => tag.toLocaleLowerCase().includes(name.toLocaleLowerCase()))
  const canCreate = Boolean(name && !tags.includes(name))
  return (
    <SearchableSelect
      value={value}
      options={[
        ...filtered.map(tag => ({
          value: tag,
          label: tag,
          disabled: usedTags.includes(tag) || isTagNameTooLong(tag),
          badge: usedTags.includes(tag) ? (
            <span className="text-xs text-text-secondary">{t('todo.board_view_tag_used')}</span>
          ) : undefined,
          testId: testId + '-option-' + tag,
        })),
        ...(canCreate
          ? [
              {
                value: name,
                label: t('todo.board_view_tag_create', undefined, {
                  tag: name,
                }),
                icon: <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />,
                disabled: tooLong,
                testId: testId + '-create',
              },
            ]
          : []),
      ]}
      onChange={tag => {
        if (!disabled && !usedTags.includes(tag) && !isTagNameTooLong(tag)) onChange(tag)
      }}
      testId={testId}
      menuTestId={testId + '-popover'}
      accessibleLabel={t('todo.board_view_tag')}
      disabled={disabled}
      portalContainer={portalContainer}
      query={query}
      onSearchChange={setQuery}
      filter={false}
      autoHighlight="always"
      searchPlaceholder={t('todo.board_view_tag_search')}
      searchInvalid={tooLong}
      searchDescriptionId={tooLong ? errorId : undefined}
      searchStatus={
        tooLong ? (
          <p id={errorId} role="alert" className="px-2 py-1 text-xs text-destructive">
            {t('todo.tag_name_too_long')}
          </p>
        ) : undefined
      }
      emptyLabel={t('todo.board_view_tag_empty')}
      className="min-w-28 flex-1"
      triggerContent={
        <>
          <span className="truncate">{value || t('todo.board_view_tag')}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        </>
      }
    />
  )
}
