// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState, useSyncExternalStore } from 'react'
import { createWorkspaceControllerSource } from './workspaceControllerSource'
import type {
  CollaborationWorkspaceController,
  CollaborationWorkspaceControllerOptions,
} from './workspaceControllerTypes'

export type * from './workspaceControllerTypes'
export {
  collaborationWorkspaceControllerReducer,
  initialCollaborationWorkspaceControllerState,
} from './workspaceControllerState'
export { createCollaborationWorkspaceControllerCommands } from './workspaceControllerCommands'

export function useCollaborationWorkspaceController(
  options: CollaborationWorkspaceControllerOptions
): CollaborationWorkspaceController {
  const [owner, setOwner] = useState(() => createWorkspaceControllerSource(options))
  let source = owner
  if (source.api !== options.api) {
    source = createWorkspaceControllerSource(options)
    setOwner(source)
  }
  const state = useSyncExternalStore(
    listener => source.subscribe(options, listener),
    source.getSnapshot,
    source.getSnapshot
  )
  const selectedIssue =
    state.selectedIssue?.id === options.location.issueId
      ? state.selectedIssue
      : (state.issues.find(issue => issue.id === options.location.issueId) ?? null)
  const loaded = state.selectedIssue?.id === options.location.issueId
  return {
    state: {
      ...state,
      selectedIssue,
      attachments: selectedIssue && loaded ? state.attachments : [],
      comments: selectedIssue && loaded ? state.comments : [],
      assignments: selectedIssue && loaded ? state.assignments : [],
      executions: selectedIssue && loaded ? state.executions : [],
    },
    commands: source.commands,
  }
}
