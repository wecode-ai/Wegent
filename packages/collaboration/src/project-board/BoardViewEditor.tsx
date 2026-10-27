// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ArrowDown, ArrowUp, ChevronDown, Plus, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ComponentProps } from 'react'
import { DialogForm } from '../controls/DialogForm'
import { ActionMenu } from '../controls/ActionMenu'
import type { CollaborationTranslate } from '../i18n'
import type { CollaborationProject, CollaborationStatus } from '../types'
import { BoardLayoutEditor } from '../project-manage/BoardLayoutEditor'
import { ProjectBoardColumnSortPicker } from './ProjectBoardColumnSortPicker'
import { createProjectBoardSortLabels } from './projectBoardSorting'
import type { BoardViewSaveSettings, SavedBoardView } from './projectBoardViews'
import { BoardViewTagPicker } from './BoardViewTagPicker'
import { isTagNameTooLong } from '../tagging'

const control =
  'min-h-11 rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus/30 md:min-h-8 [&>option]:bg-popover [&>option]:text-text-primary [&>option:disabled]:text-text-muted'
const action =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-2 text-sm hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 md:min-h-8 md:min-w-8'

export interface BoardViewEditorSettings {
  defaultViewId: string
  cardDisplay?: CollaborationProject['card_display']
  boardConfig?: CollaborationProject['board_config']
  canEditStatuses: boolean
}

function AlignedSelect({ className = '', ...props }: ComponentProps<'select'>) {
  return (
    <span className={`relative flex min-w-0 ${className}`}>
      <select {...props} className={`${control} w-full appearance-none pr-9`} />
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
        aria-hidden="true"
      />
    </span>
  )
}

export function BoardViewEditor({
  initial,
  statuses,
  tags,
  settings,
  returnFocus,
  translate: t,
  onSave,
  onDelete,
  onClose,
}: {
  initial: SavedBoardView
  statuses: readonly CollaborationStatus[]
  tags: readonly string[]
  settings?: BoardViewEditorSettings
  returnFocus?: HTMLElement | null
  translate: CollaborationTranslate
  onSave(view: SavedBoardView, settings?: BoardViewSaveSettings): Promise<void>
  onDelete?: () => Promise<void>
  onClose(): void
}) {
  const [draft, setDraft] = useState(() => ({
    ...initial,
    filter: { tags: [], match: 'all' as const, ...initial.filter },
  }))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const builtIn = initial.id === 'default'
  const [isDefault, setIsDefault] = useState(settings?.defaultViewId === initial.id)
  const [draftStatuses, setDraftStatuses] = useState(() => [...statuses])
  const [display, setDisplay] = useState(() => ({
    showAssignee: settings?.cardDisplay?.show_assignee ?? true,
    showPriority: settings?.cardDisplay?.show_priority ?? true,
    showTags: settings?.cardDisplay?.show_tags ?? true,
    showDate: settings?.cardDisplay?.show_date ?? true,
  }))
  const lock = useRef(false)
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null)
  const titleId = useId()
  const tagOptions = [
    ...new Set([
      ...tags,
      ...draft.columns
        .filter(column => column.type === 'tag' && column.value)
        .map(column => column.value),
      ...draft.filter.tags,
    ]),
  ]
  useEffect(() => {
    if (!dialog) return
    const previous = returnFocus ?? document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [dialog, returnFocus])
  const submit = async (remove = false) => {
    if (lock.current) return
    if (
      !remove &&
      (draft.columns.some(column => column.type === 'tag' && isTagNameTooLong(column.value)) ||
        draft.filter.tags.some(isTagNameTooLong))
    ) {
      setError(t('todo.tag_name_too_long'))
      return
    }
    const bindings = draft.columns.map(column => JSON.stringify([column.type, column.value]))
    if (
      !remove &&
      !builtIn &&
      (!draft.name.trim() ||
        !draft.columns.length ||
        draft.columns.some(column => !column.value.trim()) ||
        new Set(bindings).size !== bindings.length)
    ) {
      setError(t('todo.board_view_invalid'))
      return
    }
    lock.current = true
    setPending(true)
    setError(null)
    try {
      if (remove) await onDelete?.()
      else if (settings)
        await onSave(
          { ...draft, name: draft.name.trim() },
          {
            isDefault,
            cardDisplay: {
              show_assignee: display.showAssignee,
              show_priority: display.showPriority,
              show_tags: display.showTags,
              show_date: display.showDate,
            },
            ...(builtIn && settings.canEditStatuses
              ? {
                  boardConfig: {
                    ...settings.boardConfig,
                    group_by: settings.boardConfig?.group_by ?? 'status',
                    processing_start_status_id:
                      settings.boardConfig?.processing_start_status_id ?? null,
                    statuses: draftStatuses,
                  },
                }
              : {}),
          }
        )
      else await onSave({ ...draft, name: draft.name.trim() })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('saveFailed'))
    } finally {
      lock.current = false
      setPending(false)
    }
  }
  const move = (index: number, offset: number) => {
    const columns = [...draft.columns]
    const [column] = columns.splice(index, 1)
    columns.splice(index + offset, 0, column)
    setDraft({ ...draft, columns })
  }
  return (
    <dialog
      ref={setDialog}
      aria-labelledby={titleId}
      aria-busy={pending}
      data-testid="board-view-editor"
      className="m-auto max-h-[86vh] w-[min(800px,92vw)] overflow-hidden rounded-[20px] border border-border bg-background p-0 text-text-primary shadow-lg backdrop:bg-black/15"
      onCancel={event => {
        event.preventDefault()
        if (!lock.current) onClose()
      }}
    >
      <DialogForm
        className="flex max-h-[86vh] flex-col"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <header className="relative flex shrink-0 items-center justify-between gap-4 border-b border-border py-4 pl-6 pr-16">
          <div>
            <h2 id={titleId} className="text-heading-sm font-medium">
              {t('todo.board_view_settings')}
            </h2>
            <p className="mt-1 text-xs text-text-muted">{t('todo.board_view_settings_hint')}</p>
          </div>
          <button
            type="button"
            disabled={pending}
            data-testid="board-view-close"
            aria-label={t('todo.board_view_close')}
            className={`${action} absolute right-4 top-4`}
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto px-6 py-5">
          <fieldset disabled={pending} className="flex min-w-0 flex-col gap-6">
            {!builtIn && (
              <label className="flex flex-col gap-2 text-sm font-medium">
                {t('todo.board_view_name')}
                <input
                  autoFocus
                  required
                  maxLength={100}
                  value={draft.name}
                  className={control}
                  data-testid="board-view-name"
                  onChange={event => setDraft({ ...draft, name: event.target.value })}
                />
              </label>
            )}
            {settings && (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3">
                <input
                  type="checkbox"
                  checked={isDefault}
                  disabled={pending || (builtIn && settings.defaultViewId === 'default')}
                  data-testid="board-view-set-default"
                  className="mt-0.5 h-4 w-4 accent-text-primary"
                  onChange={event => setIsDefault(event.target.checked)}
                />
                <span>
                  <span className="block text-sm font-medium">
                    {t('todo.board_view_set_default')}
                  </span>
                  <span className="mt-1 block text-xs text-text-muted">
                    {t('todo.board_view_default_hint')}
                  </span>
                </span>
              </label>
            )}
            {!builtIn && (
              <>
                <div className="flex flex-col gap-2">
                  <div className="mb-1">
                    <h3 className="text-sm font-medium">{t('todo.board_view_lanes_title')}</h3>
                    <p className="mt-1 text-xs text-text-muted">{t('todo.board_view_columns')}</p>
                  </div>
                  {draft.columns.map((column, index) => (
                    <div
                      key={column.id}
                      className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-2 rounded-xl border border-border p-2 sm:grid-cols-[100px_minmax(0,1fr)_auto]"
                      data-testid={`board-view-lane-${index}`}
                    >
                      <AlignedSelect
                        aria-label={t('todo.board_view_columns')}
                        data-testid={`board-view-lane-type-${index}`}
                        value={column.type}
                        onChange={event =>
                          setDraft({
                            ...draft,
                            columns: draft.columns.map(candidate =>
                              candidate.id === column.id
                                ? {
                                    ...candidate,
                                    type: event.target.value as 'status' | 'tag',
                                    value: '',
                                  }
                                : candidate
                            ),
                          })
                        }
                      >
                        <option value="status">{t('todo.board_view_status')}</option>
                        <option value="tag">{t('todo.board_view_tag')}</option>
                      </AlignedSelect>
                      {column.type === 'status' ? (
                        <AlignedSelect
                          aria-label={t('todo.board_view_status')}
                          data-testid={`board-view-lane-value-${index}`}
                          value={column.value}
                          required
                          className="min-w-0"
                          onChange={event =>
                            setDraft({
                              ...draft,
                              columns: draft.columns.map(candidate =>
                                candidate.id === column.id
                                  ? { ...candidate, value: event.target.value }
                                  : candidate
                              ),
                            })
                          }
                        >
                          <option value="" disabled>
                            {t('todo.board_view_status')}
                          </option>
                          {column.value && !statuses.some(status => status.id === column.value) && (
                            <option value={column.value}>{column.value}</option>
                          )}
                          {statuses.map(status => (
                            <option key={status.id} value={status.id}>
                              {status.name}
                            </option>
                          ))}
                        </AlignedSelect>
                      ) : (
                        <BoardViewTagPicker
                          value={column.value}
                          tags={tagOptions}
                          usedTags={draft.columns
                            .filter(
                              candidate => candidate.id !== column.id && candidate.type === 'tag'
                            )
                            .map(candidate => candidate.value)}
                          disabled={pending}
                          testId={`board-view-lane-value-${index}`}
                          portalContainer={dialog}
                          translate={t}
                          onChange={value =>
                            setDraft({
                              ...draft,
                              columns: draft.columns.map(candidate =>
                                candidate.id === column.id ? { ...candidate, value } : candidate
                              ),
                            })
                          }
                        />
                      )}
                      <div className="col-span-2 flex items-center justify-end gap-1 border-t border-border pt-1 sm:col-span-1 sm:border-0 sm:pt-0">
                        <ProjectBoardColumnSortPicker
                          columnKey={column.id}
                          columnLabel={column.value}
                          portalContainer={dialog}
                          value={draft.sorts?.[column.id] ?? ['priority-desc']}
                          labels={createProjectBoardSortLabels(t)}
                          onChange={sort =>
                            setDraft({
                              ...draft,
                              sorts: { ...draft.sorts, [column.id]: sort },
                            })
                          }
                        />
                        <button
                          type="button"
                          className={action}
                          disabled={index === 0}
                          aria-label={t('todo.board_view_up')}
                          data-testid={`board-view-lane-up-${index}`}
                          onClick={() => move(index, -1)}
                        >
                          <ArrowUp className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          className={action}
                          disabled={index === draft.columns.length - 1}
                          aria-label={t('todo.board_view_down')}
                          data-testid={`board-view-lane-down-${index}`}
                          onClick={() => move(index, 1)}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          className={action}
                          aria-label={t('todo.board_view_remove_column')}
                          data-testid={`board-view-lane-remove-${index}`}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              columns: draft.columns.filter(
                                candidate => candidate.id !== column.id
                              ),
                            })
                          }
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    className={`${action} self-start gap-1`}
                    disabled={draft.columns.length >= 50}
                    data-testid="board-view-add-lane"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        columns: [
                          ...draft.columns,
                          { id: crypto.randomUUID(), type: 'tag', value: '' },
                        ],
                      })
                    }
                  >
                    <Plus className="h-4 w-4" />
                    {t('todo.board_view_add_column')}
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-sm">{t('todo.board_view_filter')}</span>
                  <AlignedSelect
                    aria-label={t('todo.board_view_filter')}
                    data-testid="board-view-filter-match"
                    value={draft.filter.match}
                    onChange={event =>
                      setDraft({
                        ...draft,
                        filter: {
                          ...draft.filter,
                          match: event.target.value as 'all' | 'any',
                        },
                      })
                    }
                  >
                    <option value="all">{t('todo.board_view_all')}</option>
                    <option value="any">{t('todo.board_view_any')}</option>
                  </AlignedSelect>
                  <div className="flex flex-wrap gap-2">
                    {tagOptions.map(tag => (
                      <label
                        key={tag}
                        className="flex min-h-11 items-center gap-2 rounded-lg bg-muted px-3 text-sm md:min-h-8"
                      >
                        <input
                          type="checkbox"
                          data-testid={`board-view-filter-tag-${tag}`}
                          checked={draft.filter.tags.includes(tag)}
                          onChange={event =>
                            setDraft({
                              ...draft,
                              filter: {
                                ...draft.filter,
                                tags: event.target.checked
                                  ? [...draft.filter.tags, tag]
                                  : draft.filter.tags.filter(value => value !== tag),
                              },
                            })
                          }
                        />
                        {tag}
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}
            {settings && (
              <BoardLayoutEditor
                embedded
                portalContainer={dialog}
                statuses={draftStatuses}
                display={display}
                canEditStatuses={builtIn && settings.canEditStatuses}
                statusBusy={pending}
                displayBusy={pending}
                previewColumns={
                  builtIn
                    ? undefined
                    : draft.columns.map(column => ({
                        id: column.id,
                        name:
                          column.type === 'tag'
                            ? column.value || t('todo.board_view_tag')
                            : (statuses.find(status => status.id === column.value)?.name ??
                              column.value),
                        color:
                          column.type === 'status'
                            ? (statuses.find(status => status.id === column.value)?.color ?? 'gray')
                            : 'gray',
                      }))
                }
                onStatusesChange={setDraftStatuses}
                onDisplayChange={(key, checked) =>
                  setDisplay(current => ({ ...current, [key]: checked }))
                }
                translate={t}
                renderActionMenu={({ items, ...props }) => (
                  <ActionMenu {...props} portalContainer={dialog} items={items} />
                )}
              />
            )}
          </fieldset>
        </div>
        <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border bg-background px-6 py-4">
          {error && (
            <p role="alert" className="basis-full text-sm text-destructive">
              {error}
            </p>
          )}
          {confirmDelete && (
            <p className="basis-full text-sm">{t('todo.board_view_delete_confirm')}</p>
          )}
          {onDelete && (
            <button
              type="button"
              disabled={pending}
              className={`${action} mr-auto text-destructive`}
              data-testid="board-view-delete"
              onClick={() => (confirmDelete ? void submit(true) : setConfirmDelete(true))}
            >
              {t('todo.board_view_delete')}
            </button>
          )}
          <button
            type="button"
            disabled={pending}
            className={action}
            data-testid="board-view-cancel"
            onClick={onClose}
          >
            {t('todo.board_view_cancel')}
          </button>
          <button
            type="submit"
            disabled={pending}
            data-testid="board-view-save"
            className={`${action} bg-text-primary text-background hover:bg-text-primary/80`}
          >
            {t('todo.board_view_save')}
          </button>
        </footer>
      </DialogForm>
    </dialog>
  )
}
