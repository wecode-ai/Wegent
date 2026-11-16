// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceProjectsApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'
import type { CollaborationTranslate } from '../i18n'
import { isIssueVersionConflict as isVersionConflict } from '../issue-detail/issueVersionConflict'
import type { BoardViewSaveSettings, ProjectBoardViews } from './projectBoardViews'

export async function saveProjectBoardViews({
  api,
  projectId,
  version,
  config,
  settings,
  accept,
  translate: t,
}: {
  api: Pick<SharedWorkspaceProjectsApi, 'get' | 'update'>
  projectId: string
  version: number
  config: ProjectBoardViews
  settings?: BoardViewSaveSettings
  accept(project: CollaborationProject): void
  translate: CollaborationTranslate
}) {
  let updated: CollaborationProject
  try {
    updated = await api.update(projectId, {
      version,
      boardViews: config,
      ...(settings?.cardDisplay ? { cardDisplay: settings.cardDisplay } : {}),
      ...(settings?.boardConfig ? { boardConfig: settings.boardConfig } : {}),
    })
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? error.status : null
    if (status !== 409 && !isVersionConflict(error)) throw error
    const latest = await api.get(projectId)
    accept(latest)
    throw new Error(
      t(
        latest.board_views && latest.board_views.schema_version !== 1
          ? 'todo.board_view_future'
          : 'todo.board_view_conflict'
      ),
      { cause: error }
    )
  }
  if (!updated.board_views) throw new Error(t('todo.board_view_server_unsupported'))
  accept(updated)
}
