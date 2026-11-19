// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  synchronizeCollaborationProjectView,
  type CollaborationProjectViewNavigationReceipt,
} from './project-shell/projectViewResolution'
import { projectStatuses } from './board'
import { prepareIssueArchiveSubtree } from './issue-archive/prepareIssueArchive'
import type { createCollaborationTranslator, collaborationMessages } from './i18n'
import type { SharedWorkspaceApi } from './ports/SharedWorkspaceApi'
import { scheduleViewConfigFromOptions, type ScheduleViewOptions } from './project-schedule/model'
import type { CollaborationHostAdapter, CollaborationIssue, CollaborationProject } from './types'
import type { CollaborationWorkspaceControllerCommands } from './workspace-controller'

export interface CollaborationAppInput {
  api: SharedWorkspaceApi
  projectViewNavigation?: CollaborationProjectViewNavigationReceipt
  project: CollaborationProject | null
  projects: CollaborationProject[]
  issues: CollaborationIssue[]
  host: CollaborationHostAdapter
  commands: CollaborationWorkspaceControllerCommands
  refreshProjectRequestKey: number
  messages: (typeof collaborationMessages)[keyof typeof collaborationMessages]
  translate: ReturnType<typeof createCollaborationTranslator>
  onPrepareIssueArchive?: (issue: CollaborationIssue) => Promise<void>
  acceptProjectOptions(): void
}

interface AppSnapshot {
  archiveIssueTargets: CollaborationIssue[] | null
  archiveIssueBusy: boolean
  archiveIssueError: string | null
  archiveDrawerOpen: boolean
  archivedIssues: CollaborationIssue[]
  archiveNextCursor: string | null
  archiveDrawerLoading: boolean
  archiveDrawerError: string | null
  restoringIssueId: string | null
  savingScheduleView: boolean
}

/** Owns project navigation receipts, archive transactions and shared schedule-view writes. */
export function createCollaborationAppState(initial: CollaborationAppInput) {
  let input = initial
  let snapshot: AppSnapshot = {
    archiveIssueTargets: null,
    archiveIssueBusy: false,
    archiveIssueError: null,
    archiveDrawerOpen: false,
    archivedIssues: [],
    archiveNextCursor: null,
    archiveDrawerLoading: false,
    archiveDrawerError: null,
    restoringIssueId: null,
    savingScheduleView: false,
  }
  const observers = new Set<() => void>()
  let observed = false
  let generation = 0
  let loadGeneration = 0
  const restoredAfterRequest = new Map<string, number>()
  let dialogGeneration = 0
  let drawerGeneration = 0
  let acknowledgedViewNavigation: string | undefined
  let notifiedHost: CollaborationHostAdapter | undefined
  let notifiedProjects: CollaborationProject[] | undefined
  let refreshedKey: number | undefined
  let refreshCommands: CollaborationWorkspaceControllerCommands | undefined
  const active = (version: number) => generation === version && (!observed || observers.size > 0)
  const publish = (patch: Partial<AppSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    observers.forEach(listener => listener())
  }

  const loadArchivedIssues = async (cursor: string | null = null) => {
    const { api, project, translate } = input
    if (!project || (cursor && snapshot.archiveDrawerLoading)) return
    const version = generation
    const request = ++loadGeneration
    publish({ archiveDrawerLoading: true, archiveDrawerError: null })
    try {
      const page = await api.issues.listArchived(project.id, { cursor, limit: 50 })
      if (!active(version) || request !== loadGeneration) return
      const items = page.items.filter(issue => (restoredAfterRequest.get(issue.id) ?? -1) < request)
      publish({
        archivedIssues: cursor ? [...snapshot.archivedIssues, ...items] : items,
        archiveNextCursor: page.nextCursor,
      })
    } catch (error) {
      if (!active(version) || request !== loadGeneration) return
      publish({
        archiveDrawerError:
          error instanceof Error
            ? error.message
            : translate('todo.archive_box_load_failed', '加载归档任务失败'),
      })
    } finally {
      if (active(version) && request === loadGeneration) publish({ archiveDrawerLoading: false })
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(next: CollaborationAppInput, listener: () => void) {
      input = next
      observed = true
      observers.add(listener)
      const navigation = next.projectViewNavigation
      const navigationKey = navigation
        ? JSON.stringify([
            navigation.requestedView,
            navigation.grouped,
            navigation.resolved.view,
            navigation.resolved.viewChanged,
          ])
        : undefined
      if (navigationKey !== acknowledgedViewNavigation) {
        acknowledgedViewNavigation = navigationKey
        if (navigation) {
          if (navigation.grouped) {
            if (navigation.resolved.viewChanged) navigation.onUnavailableView?.(navigation.resolved)
          } else {
            synchronizeCollaborationProjectView(navigation.resolved, view =>
              next.host.navigate({
                projectId: next.project?.id ?? null,
                issueId: null,
                view,
                projectSettingsSection: null,
              })
            )
          }
        }
      }
      if (notifiedHost !== next.host || notifiedProjects !== next.projects) {
        notifiedHost = next.host
        notifiedProjects = next.projects
        next.host.onProjectsChange?.(next.projects)
      }
      const refreshChanged =
        refreshedKey !== next.refreshProjectRequestKey || refreshCommands !== next.commands
      refreshedKey = next.refreshProjectRequestKey
      refreshCommands = next.commands
      if (next.project && next.refreshProjectRequestKey > 0 && refreshChanged) {
        void next.commands.loadProjectSnapshot(next.project.id, { invalidate: true })
      }
      return () => {
        observers.delete(listener)
        queueMicrotask(() => {
          if (observers.size) return
          acknowledgedViewNavigation = undefined
          generation += 1
          loadGeneration += 1
          publish({
            archiveDrawerLoading: false,
            archiveIssueBusy: false,
            restoringIssueId: null,
            savingScheduleView: false,
          })
        })
      }
    },
    requestIssueArchive(targets: CollaborationIssue[]) {
      dialogGeneration += 1
      publish({ archiveIssueTargets: targets, archiveIssueError: null })
    },
    closeIssueArchive() {
      dialogGeneration += 1
      publish({ archiveIssueTargets: null, archiveIssueError: null })
    },
    async confirmIssueArchive() {
      const targets = snapshot.archiveIssueTargets
      if (!targets?.length || snapshot.archiveIssueBusy) return
      const { issues, commands, onPrepareIssueArchive, translate } = input
      const version = generation
      const dialog = dialogGeneration
      publish({ archiveIssueBusy: true, archiveIssueError: null })
      const results = await Promise.allSettled(
        targets.map(async issue => {
          await prepareIssueArchiveSubtree(
            issues,
            issue,
            onPrepareIssueArchive
              ? async target => {
                  if (!active(version)) throw new Error('Archive scope is no longer active')
                  await onPrepareIssueArchive(target)
                }
              : undefined
          )
          if (!active(version)) return null
          const archived = await commands.archiveIssue(issue.id, { throwOnError: true })
          if (!archived) throw new Error('Issue could not be archived')
          return issue
        })
      )
      if (!active(version)) return
      const failed = results.flatMap((result, index) =>
        result.status === 'rejected' ? [targets[index]] : []
      )
      const archivedIds = new Set(
        results.flatMap(result =>
          result.status === 'fulfilled' && result.value ? [result.value.id] : []
        )
      )
      const { host, project } = input
      if (host.location.issueId && archivedIds.has(host.location.issueId)) {
        host.navigate({ projectId: project?.id ?? null, issueId: null, view: host.location.view })
      }
      publish({
        archiveIssueBusy: false,
        ...(dialog === dialogGeneration
          ? {
              archiveIssueTargets: failed.length ? failed : null,
              archiveIssueError: failed.length
                ? translate(
                    'todo.archive_issue_failed_count',
                    '{{count}} 个任务归档失败，请重试。',
                    { count: failed.length }
                  )
                : null,
            }
          : {}),
      })
    },
    loadArchivedIssues,
    openArchiveDrawer() {
      drawerGeneration += 1
      publish({ archiveDrawerOpen: true, archivedIssues: [], archiveNextCursor: null })
      void loadArchivedIssues()
    },
    closeArchiveDrawer() {
      drawerGeneration += 1
      loadGeneration += 1
      publish({ archiveDrawerOpen: false, archiveDrawerLoading: false })
    },
    async restoreArchivedIssue(issue: CollaborationIssue) {
      const { api, project, commands, translate } = input
      if (!project || snapshot.restoringIssueId) return
      const version = generation
      const drawer = drawerGeneration
      publish({ restoringIssueId: issue.id, archiveDrawerError: null })
      try {
        await api.issues.restore(issue.id)
        if (!active(version)) return
        restoredAfterRequest.set(issue.id, loadGeneration)
        if (drawer === drawerGeneration) {
          publish({
            archivedIssues: snapshot.archivedIssues.filter(candidate => candidate.id !== issue.id),
          })
        }
        await commands.loadProjectSnapshot(project.id, { invalidate: true })
      } catch (error) {
        if (active(version) && drawer === drawerGeneration) {
          publish({
            archiveDrawerError:
              error instanceof Error
                ? error.message
                : translate('todo.restore_issue_failed', '恢复任务失败'),
          })
        }
      } finally {
        if (active(version)) publish({ restoringIssueId: null })
      }
    },
    async saveScheduleView(options: ScheduleViewOptions) {
      const { project, commands, messages, translate, acceptProjectOptions } = input
      if (
        !project ||
        snapshot.savingScheduleView ||
        !(
          project.project_store === 'local' ||
          project.access_role === 'Owner' ||
          project.access_role === 'Maintainer'
        )
      )
        return
      const version = generation
      const statuses = projectStatuses(project, messages, translate)
      const boardConfig = project.board_config ?? {
        group_by: 'status' as const,
        processing_start_status_id: statuses[1]?.id ?? statuses[0]?.id ?? null,
        statuses,
      }
      publish({ savingScheduleView: true })
      try {
        const updated = await commands.updateProject(project.id, {
          version: project.version,
          boardConfig: { ...boardConfig, schedule_view: scheduleViewConfigFromOptions(options) },
        })
        if (updated && active(version)) acceptProjectOptions()
      } finally {
        if (active(version)) publish({ savingScheduleView: false })
      }
    },
  }
}
