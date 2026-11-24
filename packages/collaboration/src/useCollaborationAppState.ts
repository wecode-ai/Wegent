// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState, useSyncExternalStore } from 'react'
import { createCollaborationAppState, type CollaborationAppInput } from './collaborationAppState'
import type { BoardIssueCreateDefaults } from './project-board/projectBoardViews'
import type { ProjectSettingsSectionId } from './types'

export function useCollaborationAppState(
  input: CollaborationAppInput,
  createProjectRequestKey: number
) {
  const { host } = input
  const identity = input.project?.current_user_id
  const [draftOwner, setDraftOwner] = useState({ api: input.api, identity })
  const [projectDialog, setProjectDialog] = useState({
    requestKey: createProjectRequestKey,
    open: createProjectRequestKey > 0,
  })
  if (projectDialog.requestKey !== createProjectRequestKey) {
    setProjectDialog({
      requestKey: createProjectRequestKey,
      open: createProjectRequestKey > 0 || projectDialog.open,
    })
  }
  const createProjectOpen = projectDialog.open
  const setCreateProjectOpen = (open: boolean) =>
    setProjectDialog({ requestKey: createProjectRequestKey, open })
  const [issueBoard, setIssueBoard] = useState<{
    issueId: string
    projectId: string
    board: import('./issue-detail/issueCommentActions').IssueCommentBoardContext
  } | null>(null)
  const [createIssueOpen, setCreateIssueOpen] = useState(false)
  const [createIssueDefaults, setCreateIssueDefaults] = useState<BoardIssueCreateDefaults>()
  if (
    draftOwner.api !== input.api ||
    (draftOwner.identity !== undefined &&
      identity !== undefined &&
      draftOwner.identity !== identity)
  ) {
    setDraftOwner({ api: input.api, identity })
    setIssueBoard(null)
    setCreateIssueOpen(false)
    setCreateIssueDefaults(undefined)
    setProjectDialog({ requestKey: createProjectRequestKey, open: createProjectRequestKey > 0 })
  }
  if (draftOwner.identity === undefined && identity !== undefined && draftOwner.api === input.api) {
    setDraftOwner({ api: input.api, identity })
  }
  const sectionScope = JSON.stringify([
    host.location.projectId,
    host.location.view,
    host.location.projectSettingsSection,
  ])
  const [sectionSelection, setSectionSelection] = useState<{
    scope: string
    section: ProjectSettingsSectionId
  } | null>(null)
  if (sectionSelection && sectionSelection.scope !== sectionScope) setSectionSelection(null)
  const settingsSectionId =
    sectionSelection?.scope === sectionScope
      ? sectionSelection.section
      : host.location.view === 'manage'
        ? (host.location.projectSettingsSection ?? 'project')
        : 'project'
  const setSettingsSectionId = (section: ProjectSettingsSectionId) =>
    setSectionSelection({ scope: sectionScope, section })
  const { api, project } = input
  const scope = JSON.stringify([
    project?.project_store,
    project?.id,
    project?.workspace_id,
    project?.current_user_id,
    project?.access_role,
  ])
  const [appOwner, setAppOwner] = useState(() => ({
    api,
    scope,
    source: createCollaborationAppState(input),
  }))
  let appState = appOwner.source
  if (appOwner.api !== api || appOwner.scope !== scope) {
    appState = createCollaborationAppState(input)
    setAppOwner({ api, scope, source: appState })
  }
  const subscribe = useCallback(
    (listener: () => void) => appState.subscribe(input, listener),
    [appState, input]
  )
  const {
    archiveIssueTargets,
    archiveIssueBusy,
    archiveIssueError,
    archiveDrawerOpen,
    archivedIssues,
    archiveNextCursor,
    archiveDrawerLoading,
    archiveDrawerError,
    restoringIssueId,
    savingScheduleView,
  } = useSyncExternalStore(subscribe, appState.getSnapshot, appState.getSnapshot)
  const {
    saveScheduleView,
    confirmIssueArchive,
    closeIssueArchive,
    loadArchivedIssues,
    openArchiveDrawer,
    closeArchiveDrawer,
    restoreArchivedIssue,
  } = appState
  return {
    createProjectOpen,
    setCreateProjectOpen,
    issueBoard,
    setIssueBoard,
    createIssueOpen,
    setCreateIssueOpen,
    createIssueDefaults,
    setCreateIssueDefaults,
    settingsSectionId,
    setSettingsSectionId,
    appState,
    archiveIssueTargets,
    archiveIssueBusy,
    archiveIssueError,
    archiveDrawerOpen,
    archivedIssues,
    archiveNextCursor,
    archiveDrawerLoading,
    archiveDrawerError,
    restoringIssueId,
    savingScheduleView,
    saveScheduleView,
    confirmIssueArchive,
    closeIssueArchive,
    loadArchivedIssues,
    openArchiveDrawer,
    closeArchiveDrawer,
    restoreArchivedIssue,
  }
}
