// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Columns3, Plus, Settings2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { CollaborationTranslate } from '../i18n'
import type { CollaborationStatus } from '../types'
import { useCollaborationPortalTheme } from '../theme'
import { BoardViewEditor, type BoardViewEditorSettings } from './BoardViewEditor'
import { createSavedBoardView } from './projectBoardViews'
import type { useSavedBoardViews } from './useSavedBoardViews'

export function BoardViewNavigation({
  controller,
  canManage,
  statuses,
  tags,
  settings,
  translate: t,
}: {
  controller: ReturnType<typeof useSavedBoardViews>
  canManage: boolean
  statuses: readonly CollaborationStatus[]
  tags: readonly string[]
  settings?: Omit<BoardViewEditorSettings, 'defaultViewId'>
  translate: CollaborationTranslate
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const theme = useCollaborationPortalTheme()
  const editing = controller.editing
  const view = controller.view
  const builtIn = { id: 'default', name: t('todo.board_view_builtin'), columns: [] }
  const itemStyle =
    'flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-text-primary outline-none hover:bg-muted focus:bg-muted disabled:opacity-50 md:min-h-8'
  return (
    <>
      <nav aria-label={t('board')} data-testid="board-view-navigation" className="shrink-0">
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger asChild>
            <button
              ref={triggerRef}
              type="button"
              data-testid="board-view-picker"
              aria-haspopup="menu"
              className="flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus/30 md:min-h-8"
            >
              <Columns3 className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              <span className="max-w-64 truncate">{view?.name ?? builtIn.name}</span>
              <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              {...theme}
              role="menu"
              aria-label={t('todo.board_view_switch')}
              align="start"
              sideOffset={4}
              collisionPadding={8}
              data-testid="board-view-menu"
              data-embedded-browser-occlusion
              className={`${theme.className} z-system-popover max-h-[var(--radix-popover-content-available-height)] w-64 max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-border bg-popover p-1 text-text-primary shadow-lg outline-none`}
              onKeyDown={event => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
                )
                const index = items.indexOf(document.activeElement as HTMLButtonElement)
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                items[next]?.focus()
              }}
            >
              <p className="px-2 py-1.5 text-xs text-text-muted">{t('todo.board_view_switch')}</p>
              {[builtIn, ...controller.views].map(candidate => (
                <button
                  key={candidate.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={candidate.id === controller.selectedId}
                  data-testid={`board-view-${candidate.id}`}
                  className={itemStyle}
                  onClick={() => {
                    controller.select(candidate.id)
                    setOpen(false)
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                  {candidate.id === controller.defaultViewId && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-text-muted">
                      {t('todo.board_view_default_badge')}
                    </span>
                  )}
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {candidate.id === controller.selectedId && (
                      <Check className="h-4 w-4" aria-hidden="true" />
                    )}
                  </span>
                </button>
              ))}
              {controller.supported && canManage && (
                <div className="mt-1 border-t border-border pt-1">
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="board-view-new"
                    disabled={controller.views.length >= 30}
                    className={itemStyle}
                    onClick={() => {
                      setOpen(false)
                      controller.edit(createSavedBoardView(statuses), triggerRef.current)
                    }}
                  >
                    <Plus className="h-4 w-4 text-text-muted" aria-hidden="true" />
                    {t('todo.board_view_add')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="board-view-edit"
                    className={itemStyle}
                    onClick={() => {
                      setOpen(false)
                      controller.edit(view ?? builtIn, triggerRef.current)
                    }}
                  >
                    <Settings2 className="h-4 w-4 text-text-muted" aria-hidden="true" />
                    {t('todo.board_view_settings')}
                  </button>
                </div>
              )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </nav>
      {editing && canManage && controller.supported && (
        <BoardViewEditor
          key={editing.view.id}
          initial={editing.view}
          statuses={statuses}
          tags={tags}
          translate={t}
          returnFocus={editing.returnFocus}
          settings={settings ? { ...settings, defaultViewId: controller.defaultViewId } : undefined}
          onClose={controller.closeEditor}
          onSave={(view, preferences) => controller.saveView(view, editing.revision, preferences)}
          onDelete={
            controller.views.some(view => view.id === editing.view.id)
              ? () => controller.deleteView(editing.view.id, editing.revision)
              : undefined
          }
        />
      )}
    </>
  )
}

export function BoardViewNotice({
  controller,
  statuses,
  translate: t,
}: {
  controller: ReturnType<typeof useSavedBoardViews>
  statuses: readonly CollaborationStatus[]
  translate: CollaborationTranslate
}) {
  const message = !controller.supported
    ? t('todo.board_view_future')
    : controller.view?.columns.some(
          column => column.type === 'status' && !statuses.some(status => status.id === column.value)
        )
      ? t('todo.board_view_missing_status')
      : null
  return message ? (
    <p role="status" className="mx-6 mb-3 text-sm text-text-secondary">
      {message}
    </p>
  ) : null
}
