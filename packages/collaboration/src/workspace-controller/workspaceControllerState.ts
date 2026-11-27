// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { collectIssueSubtreeIds, removeIssueSubtree } from '../board'

import { traceIssueStateChange } from './issueStateDiagnostics'
import { mergeIssueReadState, newestIssue } from './issueReadState'
import { mergePersistedBoardMove } from '../project-board/useStandardCloudBoardController'

import type { CollaborationIssue } from '../types'

import type {
  CollaborationWorkspaceControllerState,
  CollaborationWorkspaceControllerAction,
} from './workspaceControllerTypes'
export const initialCollaborationWorkspaceControllerState: CollaborationWorkspaceControllerState = {
  confirmedIssueReads: {},
  projects: [],
  myWork: [],
  projectItems: {},
  projectMembers: {},
  projectAgents: {},
  projectTaskBindings: {},
  project: null,
  issues: [],
  members: [],
  agents: [],
  taskBindings: [],
  externalBoardParentId: null,
  externalPageCursors: {},
  externalPageLoading: {},
  boardLoadRevision: 0,
  selectedIssue: null,
  attachments: [],
  comments: [],
  assignments: [],
  executions: [],
  loading: true,
  error: null,
  errorSource: null,
}

function preserveProjectSnapshotValues<T>(
  incoming: Record<string, T>,
  current: Record<string, T>,
  projectIds: readonly string[]
): Record<string, T> {
  const values = { ...incoming }
  for (const projectId of projectIds) {
    if (Object.hasOwn(current, projectId)) values[projectId] = current[projectId]
  }
  return values
}

export function collaborationWorkspaceControllerReducer(
  state: CollaborationWorkspaceControllerState,
  action: CollaborationWorkspaceControllerAction
): CollaborationWorkspaceControllerState {
  const next = mergeIssueReadState(
    state,
    reduceWorkspaceState(state, action),
    action.type === 'issue-read' ? action.issue : undefined
  )
  traceIssueStateChange(action.type, state.selectedIssue, next.selectedIssue)
  return next
}

export function resolveLoadedIssue(
  state: Pick<CollaborationWorkspaceControllerState, 'issues' | 'selectedIssue'>,
  incoming: CollaborationIssue
): CollaborationIssue {
  const listed = state.issues.find(issue => issue.id === incoming.id)
  return newestIssue(state.selectedIssue, newestIssue(listed, incoming))
}

function reduceWorkspaceState(
  state: CollaborationWorkspaceControllerState,
  action: CollaborationWorkspaceControllerAction
): CollaborationWorkspaceControllerState {
  switch (action.type) {
    case 'loading':
      return { ...state, loading: action.value }
    case 'error':
      return {
        ...state,
        error: action.value,
        errorSource: action.value ? (action.source ?? null) : null,
      }
    case 'home-loaded':
      return {
        ...state,
        projects: action.projects,
        projectItems: preserveProjectSnapshotValues(
          action.projectItems,
          state.projectItems,
          action.preserveSnapshotProjectIds
        ),
        projectMembers: preserveProjectSnapshotValues(
          action.projectMembers,
          state.projectMembers,
          action.preserveSnapshotProjectIds
        ),
        projectAgents: preserveProjectSnapshotValues(
          action.projectAgents,
          state.projectAgents,
          action.preserveSnapshotProjectIds
        ),
        projectTaskBindings: preserveProjectSnapshotValues(
          action.projectTaskBindings,
          state.projectTaskBindings,
          action.preserveSnapshotProjectIds
        ),
        myWork: action.myWork,
        error: null,
        errorSource: null,
      }
    case 'project-catalog-loaded':
      return {
        ...state,
        projects: action.projects,
        error: null,
        errorSource: null,
      }
    case 'project-snapshot-loaded': {
      const existing = new Map(
        (state.projectItems[action.projectId] ?? []).map(item => [item.id, item])
      )
      const items = action.snapshot.items.map(item => newestIssue(existing.get(item.id), item))
      return {
        ...state,
        selectedIssue:
          state.selectedIssue && state.project?.id === action.projectId
            ? (items.find(item => item.id === state.selectedIssue?.id) ?? null)
            : state.selectedIssue,
        issues: state.project?.id === action.projectId ? items : state.issues,
        members: state.project?.id === action.projectId ? action.snapshot.members : state.members,
        agents: state.project?.id === action.projectId ? action.snapshot.agents : state.agents,
        taskBindings:
          state.project?.id === action.projectId
            ? action.snapshot.taskBindings
            : state.taskBindings,
        projectItems: {
          ...state.projectItems,
          [action.projectId]: items,
        },
        projectMembers: {
          ...state.projectMembers,
          [action.projectId]: action.snapshot.members,
        },
        projectAgents: {
          ...state.projectAgents,
          [action.projectId]: action.snapshot.agents,
        },
        projectTaskBindings: {
          ...state.projectTaskBindings,
          [action.projectId]: action.snapshot.taskBindings,
        },
        error: null,
        errorSource: null,
      }
    }
    case 'my-work-loaded':
      return {
        ...state,
        myWork: action.items,
        error: null,
        errorSource: null,
      }
    case 'project-metadata-loaded':
      return {
        ...state,
        project: action.project,
        projects: state.projects.some(item => item.id === action.project.id)
          ? state.projects.map(item => (item.id === action.project.id ? action.project : item))
          : [action.project, ...state.projects],
        issues: state.projectItems[action.project.id] ?? [],
        members: state.projectMembers[action.project.id] ?? [],
        agents: state.projectAgents[action.project.id] ?? [],
        taskBindings: state.projectTaskBindings[action.project.id] ?? [],
        selectedIssue:
          state.selectedIssue?.cloud_project_id === action.project.id ? state.selectedIssue : null,
        error: null,
        errorSource: null,
      }
    case 'project-loaded':
      return {
        ...state,
        projects: state.projects.some(item => item.id === action.project.id)
          ? state.projects.map(item => (item.id === action.project.id ? action.project : item))
          : [action.project, ...state.projects],
        projectItems: {
          ...state.projectItems,
          [action.project.id]: action.snapshot.items,
        },
        projectMembers: {
          ...state.projectMembers,
          [action.project.id]: action.snapshot.members,
        },
        projectAgents: {
          ...state.projectAgents,
          [action.project.id]: action.snapshot.agents,
        },
        projectTaskBindings: {
          ...state.projectTaskBindings,
          [action.project.id]: action.snapshot.taskBindings,
        },
        project: action.project,
        issues: action.snapshot.items,
        selectedIssue: state.selectedIssue
          ? (action.snapshot.items.find(item => item.id === state.selectedIssue?.id) ??
            (action.externalBoard && state.selectedIssue.cloud_project_id === action.project.id
              ? state.selectedIssue
              : null))
          : null,
        members: action.snapshot.members,
        agents: action.snapshot.agents,
        taskBindings: action.snapshot.taskBindings,
        externalBoardParentId: action.externalBoard?.parentId ?? null,
        externalPageCursors: action.externalBoard?.pageCursors ?? {},
        externalPageLoading: {},
        boardLoadRevision: state.boardLoadRevision + 1,
        error: null,
        errorSource: null,
      }
    case 'replace-project-agents':
      return {
        ...state,
        agents: state.project?.id === action.projectId ? action.agents : state.agents,
        projectAgents: {
          ...state.projectAgents,
          [action.projectId]: action.agents,
        },
      }
    case 'external-column-loading':
      return {
        ...state,
        externalPageLoading: {
          ...state.externalPageLoading,
          [action.status]: action.value,
        },
      }
    case 'external-column-appended': {
      if (state.project?.id !== action.projectId) return state
      const issues = [
        ...new Map([...state.issues, ...action.items].map(item => [item.id, item])).values(),
      ]
      const taskBindings = [
        ...new Map(
          [...state.taskBindings, ...action.taskBindings].map(binding => [binding.id, binding])
        ).values(),
      ]
      return {
        ...state,
        issues,
        taskBindings,
        projectItems: {
          ...state.projectItems,
          [action.projectId]: issues,
        },
        projectTaskBindings: {
          ...state.projectTaskBindings,
          [action.projectId]: taskBindings,
        },
        externalPageCursors: {
          ...state.externalPageCursors,
          [action.status]: action.nextCursor,
        },
      }
    }
    case 'issue-loaded':
      return {
        ...state,
        selectedIssue: resolveLoadedIssue(state, action.issue),
        attachments:
          action.preserveAttachments && state.selectedIssue?.id === action.issue.id
            ? state.attachments
            : action.attachments,
        comments:
          action.preserveComments && state.selectedIssue?.id === action.issue.id
            ? state.comments
            : action.comments,
        assignments:
          action.preserveAssignments && state.selectedIssue?.id === action.issue.id
            ? state.assignments
            : action.assignments,
        executions: action.executions,
      }
    case 'issue-selected':
      return {
        ...state,
        selectedIssue: action.issue,
        attachments: [],
        comments: [],
        assignments: [],
        executions: [],
      }
    case 'clear-project':
      return {
        ...state,
        project: null,
        issues: [],
        members: [],
        agents: [],
        taskBindings: [],
        externalBoardParentId: null,
        externalPageCursors: {},
        externalPageLoading: {},
        selectedIssue: null,
        attachments: [],
        comments: [],
        assignments: [],
        executions: [],
      }
    case 'clear-selected-issue':
      return {
        ...state,
        selectedIssue: null,
        attachments: [],
        comments: [],
        assignments: [],
        executions: [],
      }
    case 'replace-project': {
      const current =
        state.projects.find(project => project.id === action.project.id) ?? state.project
      if (current?.id === action.project.id && current.version > action.project.version)
        return state
      return {
        ...state,
        project: state.project?.id === action.project.id ? action.project : state.project,
        projects: state.projects.some(item => item.id === action.project.id)
          ? state.projects.map(item => (item.id === action.project.id ? action.project : item))
          : [action.project, ...state.projects],
      }
    }
    case 'remove-project': {
      const current = state.project?.id === action.projectId
      return {
        ...state,
        projects: state.projects.filter(item => item.id !== action.projectId),
        project: current ? null : state.project,
        issues: current ? [] : state.issues,
      }
    }
    case 'replace-issues':
      return {
        ...state,
        issues: action.issues,
        projectItems: state.project
          ? { ...state.projectItems, [state.project.id]: action.issues }
          : state.projectItems,
      }
    case 'append-issue':
      return {
        ...state,
        issues:
          !state.project || state.project.id === action.issue.cloud_project_id
            ? [...state.issues, action.issue]
            : state.issues,
        projectItems: {
          ...state.projectItems,
          [action.issue.cloud_project_id]: [
            ...(state.projectItems[action.issue.cloud_project_id] ?? []),
            action.issue,
          ],
        },
      }
    case 'replace-issue':
    case 'issue-read': {
      const position = action.type === 'replace-issue' ? action.position : undefined
      const replace = (items: CollaborationIssue[]) =>
        position
          ? mergePersistedBoardMove(items, action.issue, position)
          : items.map(item =>
              item.id === action.issue.id ? newestIssue(item, action.issue) : item
            )
      return {
        ...state,
        selectedIssue:
          state.selectedIssue?.id === action.issue.id
            ? newestIssue(state.selectedIssue, action.issue)
            : state.selectedIssue,
        issues: replace(state.issues),
        projectItems: {
          ...state.projectItems,
          [action.issue.cloud_project_id]: replace(
            state.projectItems[action.issue.cloud_project_id] ?? []
          ),
        },
      }
    }
    case 'remove-issue': {
      // The server soft deletes the whole subtree, so drop descendants too.
      const removedIds = collectIssueSubtreeIds(state.issues, action.issueId)
      return {
        ...state,
        selectedIssue:
          state.selectedIssue && removedIds.has(state.selectedIssue.id)
            ? null
            : state.selectedIssue,
        issues: removeIssueSubtree(state.issues, action.issueId),
        myWork: state.myWork.filter(item => !removedIds.has(item.id)),
        projectItems: Object.fromEntries(
          Object.entries(state.projectItems).map(([projectId, items]) => [
            projectId,
            removeIssueSubtree(items, action.issueId),
          ])
        ),
      }
    }
    case 'replace-attachments':
      return { ...state, attachments: action.attachments }
    case 'replace-comments':
      return { ...state, comments: action.comments }
    case 'replace-assignments':
      return { ...state, assignments: action.assignments }
  }
}
