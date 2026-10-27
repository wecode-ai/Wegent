// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react'
import {
  defaultBoardViewId,
  type BoardViewSaveSettings,
  type ProjectBoardViews,
  type SavedBoardView,
} from './projectBoardViews'
import type { CollaborationTranslate } from '../i18n'

export function useSavedBoardViews({
  projectKey,
  config,
  revision,
  translate: t,
  save,
}: {
  projectKey: string
  config?: ProjectBoardViews | null
  revision: number
  translate: CollaborationTranslate
  save(config: ProjectBoardViews, settings?: BoardViewSaveSettings): Promise<void>
}) {
  const [selection, setSelection] = useState<{ projectKey: string; id: string | null }>({
    projectKey,
    id: null,
  })
  const [editor, setEditor] = useState<{
    projectKey: string
    view: SavedBoardView
    revision: number
    returnFocus: HTMLElement | null
  } | null>(null)
  const supported = config == null || config.schema_version === 1
  const views = supported ? (config?.views ?? []) : []
  const defaultViewId = defaultBoardViewId(config)
  if (selection.projectKey !== projectKey) {
    setSelection({ projectKey, id: null })
    setEditor(null)
  }
  const selectedId =
    selection.projectKey === projectKey &&
    selection.id !== null &&
    (selection.id === 'default' || views.some(view => view.id === selection.id))
      ? selection.id
      : defaultViewId
  const view = views.find(candidate => candidate.id === selectedId) ?? null
  const editing = editor?.projectKey === projectKey ? editor : null
  const select = (id: string) => {
    setEditor(null)
    setSelection({ projectKey, id })
  }
  const edit = (
    next = view,
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  ) => {
    if (supported && next) setEditor({ projectKey, view: next, revision, returnFocus })
  }
  const closeEditor = () => setEditor(null)
  const saveView = async (
    next: SavedBoardView,
    expectedRevision = revision,
    settings?: BoardViewSaveSettings
  ) => {
    if (!supported) throw new Error(t('todo.board_view_future'))
    if (revision !== expectedRevision) throw new Error(t('todo.board_view_conflict'))
    const updated: ProjectBoardViews = {
      ...config,
      schema_version: 1,
      views:
        next.id === 'default'
          ? views
          : views.some(candidate => candidate.id === next.id)
            ? views.map(candidate => (candidate.id === next.id ? next : candidate))
            : [...views, next],
    }
    if (settings) {
      if (settings.isDefault) updated.default_view_id = next.id
      else if (defaultViewId === next.id) updated.default_view_id = 'default'
      await save(updated, settings)
    } else await save(updated)
    select(next.id)
  }
  const deleteView = async (id: string, expectedRevision = revision) => {
    if (!supported) throw new Error(t('todo.board_view_future'))
    if (revision !== expectedRevision) throw new Error(t('todo.board_view_conflict'))
    await save({
      ...config,
      schema_version: 1,
      views: views.filter(candidate => candidate.id !== id),
      ...(config?.default_view_id === id ? { default_view_id: 'default' } : {}),
    })
    select('default')
  }
  return {
    view,
    views,
    supported,
    selectedId,
    defaultViewId,
    revision,
    select,
    saveView,
    deleteView,
    editing,
    edit,
    closeEditor,
  }
}
