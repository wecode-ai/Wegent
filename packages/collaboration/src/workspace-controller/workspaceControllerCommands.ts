// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { isIssueVersionConflict } from '../issue-detail/issueVersionConflict'
import { newestIssue, mergeIssueReadConfirmation } from './issueReadState'
import { resolveLoadedIssue } from './workspaceControllerState'
import {
  isExternalGitProject,
  canPreloadHomeSnapshot,
  loadExternalGitBoardSnapshot,
  defaultExternalGitBoardPageSize,
} from './workspaceControllerPaging'
import type {
  CollaborationWorkspaceControllerState,
  CollaborationWorkspaceControllerAction,
  CollaborationWorkspaceControllerMessages,
  CollaborationWorkspaceControllerCommands,
} from './workspaceControllerTypes'
import type {
  SharedWorkspaceApi,
  WorkspaceBoardSnapshot,
  WorkspaceMyWorkItem,
} from '../ports/SharedWorkspaceApi'
import type { CollaborationIssue, CollaborationProject } from '../types'
export interface CommandEnvironment {
  api: SharedWorkspaceApi
  isCurrent?(): boolean
  getNavigationRevision?(): number
  messages: CollaborationWorkspaceControllerMessages
  myWorkEnabled: boolean
  preloadHomeSnapshots: boolean
  dispatch(action: CollaborationWorkspaceControllerAction): void
  getProjects(): CollaborationProject[]
  getProjectSnapshot(projectId: string): WorkspaceBoardSnapshot | null
  getSelectedIssue(): CollaborationIssue | null
  getExternalBoardState(): Pick<
    CollaborationWorkspaceControllerState,
    | 'confirmedIssueReads'
    | 'project'
    | 'issues'
    | 'taskBindings'
    | 'externalBoardParentId'
    | 'externalPageCursors'
    | 'externalPageLoading'
  >
  getExternalBoardOptions(): {
    parentId: string | null
    pageSize: number
    eager: boolean
  }
  notify?(message: string, kind: 'success' | 'error'): void
}

export function createCollaborationWorkspaceControllerCommands(
  environment: CommandEnvironment
): CollaborationWorkspaceControllerCommands {
  const {
    api,
    messages,
    myWorkEnabled,
    preloadHomeSnapshots = true,
    getProjects,
    getProjectSnapshot,
    getSelectedIssue,
    getExternalBoardState,
    getExternalBoardOptions,
  } = environment
  const ownerIsCurrent = () => environment.isCurrent?.() ?? true
  const dispatch = (action: CollaborationWorkspaceControllerAction) => {
    if (ownerIsCurrent()) environment.dispatch(action)
  }
  const notify: CommandEnvironment['notify'] = (message, kind) => {
    if (ownerIsCurrent()) environment.notify?.(message, kind)
  }
  let catalogProjects = getProjects()
  let projectLoadRevision = 0
  let selectedIssueLoadRevision = 0
  const selectedIssueAttachmentsRevisions = new Map<string, number>()
  const selectedIssueCommentsRevisions = new Map<string, number>()
  const selectedIssueAssignmentsRevisions = new Map<string, number>()
  const projectMutationGenerations = new Map<string, number>()
  const externalColumnLoads = new Set<string>()
  const standardSnapshotLoads = new Map<string, Promise<WorkspaceBoardSnapshot>>()
  const homeSnapshotLoads = new Map<string, Promise<WorkspaceBoardSnapshot | null>>()
  const homeSnapshotResults = new Map<string, WorkspaceBoardSnapshot | null>()
  let homeMyWorkLoad: Promise<WorkspaceMyWorkItem[]> | null = null
  const loadStandardSnapshot = (projectId: string) => {
    const active = standardSnapshotLoads.get(projectId)
    if (active) return active
    const pending = api.issues.getBoardSnapshot(projectId).finally(() => {
      if (standardSnapshotLoads.get(projectId) === pending) standardSnapshotLoads.delete(projectId)
    })
    standardSnapshotLoads.set(projectId, pending)
    return pending
  }
  const loadHomeSnapshot = (projectId: string) => {
    const active = homeSnapshotLoads.get(projectId)
    if (active) return active
    const mutationGeneration = projectMutationGeneration(projectId)
    const pending = loadStandardSnapshot(projectId)
      .catch(() => null)
      .then(snapshot => {
        if (!ownerIsCurrent() || mutationGeneration !== projectMutationGeneration(projectId))
          return null
        homeSnapshotResults.set(projectId, snapshot)
        return snapshot
      })
      .finally(() => {
        if (homeSnapshotLoads.get(projectId) === pending) homeSnapshotLoads.delete(projectId)
      })
    homeSnapshotLoads.set(projectId, pending)
    return pending
  }
  const reportError = (
    message: string,
    source: NonNullable<CollaborationWorkspaceControllerState['errorSource']> = 'save'
  ) => {
    dispatch({ type: 'error', value: message, source })
    notify?.(message, 'error')
  }
  const projectMutationGeneration = (projectId: string) =>
    projectMutationGenerations.get(projectId) ?? 0
  const collectionRevision = (revisions: ReadonlyMap<string, number>, issueId: string) =>
    revisions.get(issueId) ?? 0
  const incrementCollectionRevision = (revisions: Map<string, number>, issueId: string) => {
    revisions.set(issueId, collectionRevision(revisions, issueId) + 1)
  }
  const markProjectMutated = (projectId: string) => {
    projectMutationGenerations.set(projectId, projectMutationGeneration(projectId) + 1)
    standardSnapshotLoads.delete(projectId)
    homeSnapshotLoads.delete(projectId)
    homeSnapshotResults.delete(projectId)
  }
  const reportPositionConflict = async (
    issueId: string,
    error: unknown,
    navigationRevision: number | undefined
  ) => {
    const isCurrent = () =>
      ownerIsCurrent() && navigationRevision === environment.getNavigationRevision?.()
    if (!isCurrent()) return true
    if (!isIssueVersionConflict(error)) return false
    try {
      const latest = await api.issues.get(issueId)
      if (!isCurrent()) return true
      await loadProject(latest.cloud_project_id, false, { isCurrent })
      if (!isCurrent()) return true
      reportError(messages.conflict, 'conflict')
    } catch {
      if (isCurrent()) reportError(messages.loadFailed, 'load')
    }
    return true
  }
  const pendingReadRequests = new Map<string, Promise<CollaborationIssue | null>>()
  const confirmIssueRead = (updated: CollaborationIssue): CollaborationIssue => {
    if (!ownerIsCurrent()) return updated
    const state = getExternalBoardState()
    const current = state.issues.find(candidate => candidate.id === updated.id)
    const selected = getSelectedIssue()
    const latest = selected?.id === updated.id ? newestIssue(current, selected) : current
    const resolved = mergeIssueReadConfirmation(
      latest,
      updated,
      state.confirmedIssueReads[updated.id]
    )
    dispatch({ type: 'issue-read', issue: updated })
    return resolved
  }
  const markIssueRead = (issue: CollaborationIssue): Promise<CollaborationIssue | null> => {
    if (!ownerIsCurrent()) return Promise.resolve(null)
    if (!issue.is_unread) return Promise.resolve(issue)
    const pending = pendingReadRequests.get(issue.id)
    if (pending) return pending
    const request = api.issues
      .markRead(issue.id, undefined, issue.content_revision)
      .then(issue => (ownerIsCurrent() ? confirmIssueRead(issue) : null))
      .catch(() => {
        reportError(messages.saveFailed)
        return null
      })
      .finally(() => {
        pendingReadRequests.delete(issue.id)
      })
    pendingReadRequests.set(issue.id, request)
    return request
  }
  const loadProject = async (
    projectId: string,
    showLoading = true,
    options?: {
      isCurrent?(): boolean
      invalidate?: boolean
      loadSnapshot?: boolean
    }
  ) => {
    if (!ownerIsCurrent()) return
    if (options?.invalidate) markProjectMutated(projectId)
    const revision = ++projectLoadRevision
    const isCurrent = () =>
      ownerIsCurrent() && revision === projectLoadRevision && (options?.isCurrent?.() ?? true)
    const mutationGeneration = projectMutationGeneration(projectId)
    const cachedProject = catalogProjects.find(item => item.id === projectId)
    const hasCurrentSnapshot =
      getExternalBoardState().project?.id === projectId && getProjectSnapshot(projectId) !== null
    // Retain loaded editors during refresh and cached settings during navigation.
    if (showLoading && !hasCurrentSnapshot && (options?.loadSnapshot !== false || !cachedProject))
      dispatch({ type: 'loading', value: true })
    try {
      const project = cachedProject ?? (await api.projects.get(projectId))
      if (!isCurrent() || mutationGeneration !== projectMutationGeneration(projectId)) return
      if (!catalogProjects.some(item => item.id === project.id)) {
        catalogProjects = [...catalogProjects, project]
      }
      if (options?.loadSnapshot === false) {
        dispatch({ type: 'project-metadata-loaded', project })
        return
      }
      const externalBoardOptions = { ...getExternalBoardOptions(), isCurrent }
      const externalBoard = isExternalGitProject(project)
        ? await loadExternalGitBoardSnapshot(
            api,
            projectId,
            externalBoardOptions,
            getProjectSnapshot(projectId)
          )
        : null
      if (!isCurrent()) return
      const homeSnapshotLoad = homeSnapshotLoads.get(projectId)
      const homeSnapshot = homeSnapshotLoad
        ? await homeSnapshotLoad
        : (homeSnapshotResults.get(projectId) ?? null)
      if (!isCurrent()) return
      homeSnapshotLoads.delete(projectId)
      homeSnapshotResults.delete(projectId)
      const snapshot =
        externalBoard?.snapshot ?? homeSnapshot ?? (await loadStandardSnapshot(projectId))
      if (!isCurrent() || mutationGeneration !== projectMutationGeneration(projectId)) return
      const selected = getSelectedIssue()
      if (
        externalBoard &&
        selected?.cloud_project_id === project.id &&
        !snapshot.items.some(item => item.id === selected.id)
      ) {
        try {
          const currentIssue = await api.issues.get(selected.id)
          if (!isCurrent() || mutationGeneration !== projectMutationGeneration(projectId)) return
          if (getSelectedIssue()?.id === selected.id)
            dispatch({ type: 'replace-issue', issue: currentIssue })
        } catch {
          if (!isCurrent() || mutationGeneration !== projectMutationGeneration(projectId)) return
          if (getSelectedIssue()?.id === selected.id) dispatch({ type: 'clear-selected-issue' })
        }
      }
      if (!isCurrent() || mutationGeneration !== projectMutationGeneration(projectId)) return
      dispatch({
        type: 'project-loaded',
        project,
        snapshot,
        externalBoard: externalBoard
          ? {
              parentId: externalBoardOptions.parentId,
              pageCursors: externalBoard.pageCursors,
            }
          : undefined,
      })
    } catch {
      if (!isCurrent() || mutationGeneration !== projectMutationGeneration(projectId)) return
      reportError(messages.loadFailed, 'load')
    } finally {
      if (showLoading && isCurrent()) {
        dispatch({ type: 'loading', value: false })
      }
    }
  }
  return {
    async loadProjectCatalog(options) {
      if (!ownerIsCurrent()) return
      const isCurrent = () => ownerIsCurrent() && (options?.isCurrent?.() ?? true)
      dispatch({ type: 'loading', value: true })
      try {
        const projects = await api.projects.list()
        if (!isCurrent()) return
        catalogProjects = projects
        dispatch({ type: 'project-catalog-loaded', projects: catalogProjects })
      } catch {
        if (!isCurrent()) return
        reportError(messages.loadFailed, 'load')
      } finally {
        if (isCurrent()) dispatch({ type: 'loading', value: false })
      }
    },
    async loadProjects() {
      if (!ownerIsCurrent()) return
      const navigationRevision = environment.getNavigationRevision?.()
      const isCurrent = () =>
        ownerIsCurrent() && navigationRevision === environment.getNavigationRevision?.()
      dispatch({ type: 'loading', value: true })
      dispatch({ type: 'error', value: null })
      try {
        homeMyWorkLoad = myWorkEnabled && api.myWork ? api.myWork.list() : Promise.resolve([])
        const myWorkResult = homeMyWorkLoad.then(
          items => ({ status: 'fulfilled' as const, items }),
          (error: unknown) => ({ status: 'rejected' as const, error })
        )
        const projects = await api.projects.list()
        if (!isCurrent()) return
        catalogProjects = projects
        dispatch({ type: 'project-catalog-loaded', projects })
        const myWorkOutcome = await myWorkResult
        if (!isCurrent()) return
        if (myWorkOutcome.status === 'rejected') throw myWorkOutcome.error
        const myWork = myWorkOutcome.items
        const snapshots = preloadHomeSnapshots
          ? await Promise.all(
              projects.map(async project => ({
                projectId: project.id,
                mutationGeneration: projectMutationGeneration(project.id),
                snapshot: !canPreloadHomeSnapshot(project)
                  ? null
                  : isExternalGitProject(project)
                    ? await loadExternalGitBoardSnapshot(
                        api,
                        project.id,
                        {
                          parentId: null,
                          pageSize: defaultExternalGitBoardPageSize,
                          eager: true,
                          isCurrent,
                        },
                        getProjectSnapshot(project.id)
                      )
                        .then(result => result.snapshot)
                        .catch(() => null)
                    : await loadHomeSnapshot(project.id),
              }))
            )
          : []
        if (!isCurrent()) return
        const currentSnapshots = snapshots.filter(
          ({ projectId, mutationGeneration }) =>
            mutationGeneration === projectMutationGeneration(projectId)
        )
        const preserveSnapshotProjectIds = snapshots
          .filter(
            ({ projectId, mutationGeneration }) =>
              mutationGeneration !== projectMutationGeneration(projectId)
          )
          .map(({ projectId }) => projectId)
        dispatch({
          type: 'home-loaded',
          projects,
          preserveSnapshotProjectIds,
          projectItems: Object.fromEntries(
            currentSnapshots.flatMap(({ projectId, snapshot }) =>
              snapshot ? [[projectId, snapshot.items]] : []
            )
          ),
          projectMembers: Object.fromEntries(
            currentSnapshots.flatMap(({ projectId, snapshot }) =>
              snapshot ? [[projectId, snapshot.members]] : []
            )
          ),
          projectAgents: Object.fromEntries(
            currentSnapshots.flatMap(({ projectId, snapshot }) =>
              snapshot ? [[projectId, snapshot.agents]] : []
            )
          ),
          projectTaskBindings: Object.fromEntries(
            currentSnapshots.flatMap(({ projectId, snapshot }) =>
              snapshot ? [[projectId, snapshot.taskBindings]] : []
            )
          ),
          myWork,
        })
      } catch {
        if (!isCurrent()) return
        reportError(messages.loadFailed, 'load')
      } finally {
        if (isCurrent()) dispatch({ type: 'loading', value: false })
      }
    },
    async loadMyWork() {
      if (!ownerIsCurrent()) return
      const navigationRevision = environment.getNavigationRevision?.()
      const isCurrent = () =>
        ownerIsCurrent() && navigationRevision === environment.getNavigationRevision?.()
      if (!myWorkEnabled || !api.myWork) {
        homeMyWorkLoad = null
        dispatch({ type: 'my-work-loaded', items: [] })
        return
      }
      dispatch({ type: 'loading', value: true })
      dispatch({ type: 'error', value: null })
      try {
        const pending = homeMyWorkLoad
        homeMyWorkLoad = null
        const items = await (pending ?? api.myWork.list())
        if (!isCurrent()) return
        dispatch({ type: 'my-work-loaded', items })
      } catch {
        if (!isCurrent()) return
        reportError(messages.loadFailed, 'load')
      } finally {
        if (isCurrent()) dispatch({ type: 'loading', value: false })
      }
    },
    loadProject,
    async loadProjectSnapshot(projectId, options) {
      if (!ownerIsCurrent()) return null
      if (options?.invalidate) markProjectMutated(projectId)
      const mutationGeneration = projectMutationGeneration(projectId)
      try {
        const project = catalogProjects.find(candidate => candidate.id === projectId)
        const snapshot =
          project && isExternalGitProject(project)
            ? (
                await loadExternalGitBoardSnapshot(
                  api,
                  projectId,
                  {
                    parentId: null,
                    pageSize: defaultExternalGitBoardPageSize,
                    eager: true,
                    isCurrent: ownerIsCurrent,
                  },
                  getProjectSnapshot(projectId)
                )
              ).snapshot
            : await loadStandardSnapshot(projectId)
        if (!ownerIsCurrent() || mutationGeneration !== projectMutationGeneration(projectId))
          return null
        dispatch({ type: 'project-snapshot-loaded', projectId, snapshot })
        return snapshot
      } catch {
        if (!ownerIsCurrent() || mutationGeneration !== projectMutationGeneration(projectId))
          return null
        reportError(messages.loadFailed, 'load')
        if (options?.throwOnError) throw new Error(messages.loadFailed)
        return null
      }
    },
    async loadMoreExternalColumn(status) {
      if (!ownerIsCurrent()) return
      const externalState = getExternalBoardState()
      const project = externalState.project
      const cursor = externalState.externalPageCursors[status]
      if (
        !project ||
        !isExternalGitProject(project) ||
        !cursor ||
        externalState.externalPageLoading[status]
      ) {
        return
      }
      const parentId = externalState.externalBoardParentId
      const requestKey = `${project.id}\0${parentId ?? ''}\0${status}\0${cursor}`
      if (externalColumnLoads.has(requestKey)) return
      externalColumnLoads.add(requestKey)
      const isCurrent = () =>
        ownerIsCurrent() &&
        getExternalBoardState().project?.id === project.id &&
        getExternalBoardState().externalBoardParentId === parentId
      dispatch({ type: 'external-column-loading', status, value: true })
      try {
        const page = await api.issues.listPage(project.id, {
          status,
          parentId,
          cursor,
          limit: getExternalBoardOptions().pageSize,
        })
        const currentState = getExternalBoardState()
        if (
          !ownerIsCurrent() ||
          currentState.project?.id !== project.id ||
          currentState.externalBoardParentId !== parentId ||
          currentState.externalPageCursors[status] !== cursor
        ) {
          return
        }
        dispatch({
          type: 'external-column-appended',
          projectId: project.id,
          status,
          items: page.items,
          taskBindings: page.taskBindings,
          nextCursor: page.nextCursor,
        })
      } catch {
        if (isCurrent()) reportError(messages.loadFailed, 'load')
      } finally {
        externalColumnLoads.delete(requestKey)
        if (isCurrent()) dispatch({ type: 'external-column-loading', status, value: false })
      }
    },
    async getIssue(issueId) {
      if (!ownerIsCurrent()) return null
      try {
        const issue = await api.issues.get(issueId)
        dispatch({ type: 'replace-issue', issue })
        return issue
      } catch {
        reportError(messages.loadFailed, 'load')
        return null
      }
    },
    markIssueRead,
    confirmIssueRead,
    async loadSelectedIssue(issueId) {
      if (!ownerIsCurrent()) return null
      const revision = ++selectedIssueLoadRevision
      const attachmentsRevision = collectionRevision(selectedIssueAttachmentsRevisions, issueId)
      const commentsRevision = collectionRevision(selectedIssueCommentsRevisions, issueId)
      const assignmentsRevision = collectionRevision(selectedIssueAssignmentsRevisions, issueId)
      const cachedIssue = getExternalBoardState().issues.find(issue => issue.id === issueId)
      if (cachedIssue) {
        if (getSelectedIssue()?.id !== issueId) {
          dispatch({ type: 'issue-selected', issue: cachedIssue })
        }
      } else {
        dispatch({ type: 'clear-selected-issue' })
      }
      try {
        const [issue, attachments, comments] = await Promise.all([
          api.issues.get(issueId),
          api.attachments.list(issueId),
          api.comments.list(issueId),
        ])
        if (!ownerIsCurrent() || revision !== selectedIssueLoadRevision) return null
        const [loadedAssignments, executions] = await Promise.all([
          api.assignments ? api.assignments.list(issueId) : Promise.resolve([]),
          api.executions && !issue.invited_only
            ? api.executions
                .list(issue.cloud_project_id, { includeTerminal: true })
                .then(items => items.filter(execution => execution.loop_item_id === issueId))
            : Promise.resolve([]),
        ])
        if (!ownerIsCurrent() || revision !== selectedIssueLoadRevision) return null
        const resolvedIssue = resolveLoadedIssue(
          {
            issues: getExternalBoardState().issues,
            selectedIssue: getSelectedIssue(),
          },
          issue
        )
        dispatch({
          type: 'issue-loaded',
          issue: resolvedIssue,
          attachments,
          comments,
          assignments: loadedAssignments,
          executions,
          preserveAttachments:
            attachmentsRevision !== collectionRevision(selectedIssueAttachmentsRevisions, issueId),
          preserveComments:
            commentsRevision !== collectionRevision(selectedIssueCommentsRevisions, issueId),
          preserveAssignments:
            assignmentsRevision !== collectionRevision(selectedIssueAssignmentsRevisions, issueId),
        })
        return resolvedIssue
      } catch {
        if (!ownerIsCurrent() || revision !== selectedIssueLoadRevision) return null
        reportError(messages.loadFailed, 'load')
        return null
      }
    },
    clearProject: () => {
      if (!ownerIsCurrent()) return
      projectLoadRevision += 1
      selectedIssueLoadRevision += 1
      dispatch({ type: 'clear-project' })
    },
    clearSelectedIssue: () => {
      if (!ownerIsCurrent()) return
      selectedIssueLoadRevision += 1
      dispatch({ type: 'clear-selected-issue' })
    },
    async createProject(input) {
      if (!ownerIsCurrent()) return null
      try {
        const project = await api.projects.create(input)
        catalogProjects = [project, ...catalogProjects]
        dispatch({ type: 'replace-project', project })
        return project
      } catch {
        reportError(messages.saveFailed)
        return null
      }
    },
    async updateProject(projectId, input) {
      if (!ownerIsCurrent()) return null
      try {
        const project = await api.projects.update(projectId, input)
        markProjectMutated(projectId)
        catalogProjects = catalogProjects.map(item => (item.id === project.id ? project : item))
        dispatch({ type: 'replace-project', project })
        return project
      } catch {
        reportError(messages.saveFailed)
        return null
      }
    },
    async archiveProject(projectId, version) {
      if (!ownerIsCurrent()) return false
      try {
        await api.projects.archive(projectId, version)
        markProjectMutated(projectId)
        catalogProjects = catalogProjects.filter(project => project.id !== projectId)
        dispatch({ type: 'remove-project', projectId })
        return true
      } catch {
        reportError(messages.saveFailed)
        return false
      }
    },
    async createIssue(projectId, input, options) {
      if (!ownerIsCurrent()) return null
      try {
        const issue = await api.issues.create(projectId, input)
        markProjectMutated(projectId)
        dispatch({ type: 'append-issue', issue })
        return issue
      } catch (error) {
        reportError(messages.saveFailed)
        if (options?.throwOnError) throw error
        return null
      }
    },
    async updateIssue(issueId, input, options) {
      if (!ownerIsCurrent()) return null
      const navigationRevision = environment.getNavigationRevision?.()
      try {
        const issue = await api.issues.update(issueId, input)
        markProjectMutated(issue.cloud_project_id)
        dispatch({
          type: 'replace-issue',
          issue,
          position: input.position,
        })
        return issue
      } catch (error) {
        const conflictReported =
          input.position && (await reportPositionConflict(issueId, error, navigationRevision))
        if (!conflictReported && !options?.throwOnError) reportError(messages.saveFailed)
        if (options?.throwOnError) throw error
        return null
      }
    },
    async assignIssue(projectId, issueId, input) {
      if (!ownerIsCurrent()) return null
      const navigationRevision = environment.getNavigationRevision?.()
      try {
        const issue = await api.issues.assign(projectId, issueId, input)
        markProjectMutated(projectId)
        dispatch({
          type: 'replace-issue',
          issue,
          position: input.position,
        })
        return issue
      } catch (error) {
        if (!input.position || !(await reportPositionConflict(issueId, error, navigationRevision)))
          reportError(messages.saveFailed)
        return null
      }
    },
    async archiveIssue(issueId, options) {
      if (!ownerIsCurrent()) return false
      try {
        const archivedIssue = getExternalBoardState().issues.find(
          candidate => candidate.id === issueId
        )
        await api.issues.archive(issueId)
        if (archivedIssue) markProjectMutated(archivedIssue.cloud_project_id)
        dispatch({ type: 'remove-issue', issueId })
        return true
      } catch (error) {
        reportError(messages.saveFailed)
        if (options?.throwOnError) throw error
        return false
      }
    },
    async refreshSelectedIssue() {
      if (!ownerIsCurrent()) return
      const issue = getSelectedIssue()
      if (!issue) return
      try {
        dispatch({
          type: 'replace-issue',
          issue: await api.issues.get(issue.id),
        })
        reportError(messages.conflict, 'conflict')
      } catch {
        reportError(messages.loadFailed, 'load')
      }
    },
    async refreshProjectAgents(projectId) {
      if (!ownerIsCurrent()) return
      try {
        dispatch({
          type: 'replace-project-agents',
          projectId,
          agents: await api.agents.list(projectId),
        })
      } catch {
        reportError(messages.loadFailed, 'load')
      }
    },
    replaceProject: project => {
      if (!ownerIsCurrent()) return
      if (
        catalogProjects.some(
          current => current.id === project.id && current.version > project.version
        )
      )
        return
      markProjectMutated(project.id)
      catalogProjects = catalogProjects.map(item => (item.id === project.id ? project : item))
      dispatch({ type: 'replace-project', project })
    },
    appendIssue: issue => {
      if (!ownerIsCurrent()) return
      markProjectMutated(issue.cloud_project_id)
      dispatch({ type: 'append-issue', issue })
    },
    replaceIssue: issue => {
      if (!ownerIsCurrent()) return
      console.debug('[collaboration-workspace] received issue replacement', {
        issueId: issue.id,
        version: issue.version,
        selectedIssueId: getSelectedIssue()?.id ?? null,
      })
      markProjectMutated(issue.cloud_project_id)
      dispatch({ type: 'replace-issue', issue })
    },
    replaceAttachments: (issueId, attachments) => {
      if (!ownerIsCurrent()) return
      if (getSelectedIssue()?.id !== issueId) return
      incrementCollectionRevision(selectedIssueAttachmentsRevisions, issueId)
      dispatch({ type: 'replace-attachments', attachments })
    },
    replaceComments: (issueId, comments) => {
      if (!ownerIsCurrent()) return
      if (getSelectedIssue()?.id !== issueId) return
      incrementCollectionRevision(selectedIssueCommentsRevisions, issueId)
      dispatch({ type: 'replace-comments', comments })
    },
    replaceAssignments: (issueId, assignments) => {
      if (!ownerIsCurrent()) return
      if (getSelectedIssue()?.id !== issueId) return
      incrementCollectionRevision(selectedIssueAssignmentsRevisions, issueId)
      dispatch({ type: 'replace-assignments', assignments })
    },
    reportError,
  }
}
