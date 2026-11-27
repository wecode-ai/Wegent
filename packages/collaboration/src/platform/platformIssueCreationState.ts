// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { truncateRuntimeTaskTitle } from '@wegent/chat-core/runtime-task-title'

import { composerMarkdownText } from '../composer/composerMarkdownParser'

import type { SharedWorkspaceApi, WorkspaceRuntimeTaskAddress } from '../ports/SharedWorkspaceApi'

import type { CollaborationIssue, CollaborationProject } from '../types'

import type { IssueHomeOwner } from './issueHomeOwners'

import type { CollaborationPlatformHostAdapter } from './types'

import type { PlatformMessages } from './platformMessages'

type CreatedIssue = NonNullable<
  Parameters<NonNullable<CollaborationPlatformHostAdapter['renderPersonalHome']>>[0]['createdIssue']
>
interface Retry {
  projectId: string
  issueId: string
  deviceId: string
  standInId?: string
  files: File[]
  error: string
}
export interface PlatformIssueCreationInput {
  host: CollaborationPlatformHostAdapter
  project: CollaborationProject | null
  messages: PlatformMessages
}
export function createPlatformIssueCreationState(api: SharedWorkspaceApi) {
  let input: PlatformIssueCreationInput | undefined
  let snapshot: {
    rootIssueLoading: boolean
    createdHomeIssue?: CreatedIssue
    standInRetry: Retry | null
    standInRetrying: boolean
  } = { rootIssueLoading: false, standInRetry: null, standInRetrying: false }
  const observers = new Set<() => void>()
  let generation = 0
  let operation = 0
  const active = (version: number) => version === generation && observers.size > 0
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    observers.forEach(listener => listener())
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(next: PlatformIssueCreationInput, listener: () => void) {
      input = next
      observers.add(listener)
      return () => {
        observers.delete(listener)
        queueMicrotask(() => {
          if (!observers.size) {
            generation += 1
            publish({ rootIssueLoading: false, standInRetrying: false })
          }
        })
      }
    },
    recordCreatedTask(
      project: CollaborationProject,
      issue: CollaborationIssue,
      task: WorkspaceRuntimeTaskAddress,
      confirmed = true
    ) {
      if (!observers.size) return
      publish({
        createdHomeIssue: {
          key: crypto.randomUUID(),
          project,
          issue: {
            ...issue,
            project_key: project.project_key,
            project_name: project.name,
            has_active_task: confirmed,
          },
          task,
        },
      })
    },
    acknowledgeCreatedIssue(key: string) {
      if (snapshot.createdHomeIssue?.key === key) publish({ createdHomeIssue: undefined })
    },
    async startRootIssueCreation(
      content: string,
      owner: IssueHomeOwner | null,
      files: File[],
      standInDeviceId?: string,
      standInId?: string
    ) {
      const project = input?.project
      if (!input || !project || snapshot.rootIssueLoading || !content.trim()) return false
      const { host, messages } = input
      if (standInDeviceId && (!host.currentUser || !api.standIn?.run)) return false
      const version = generation
      const projectScope = JSON.stringify([
        project.id,
        project.project_store,
        project.current_user_id,
        project.access_role,
      ])
      const current = () =>
        active(version) &&
        input?.project &&
        JSON.stringify([
          input.project.id,
          input.project.project_store,
          input.project.current_user_id,
          input.project.access_role,
        ]) === projectScope
      const request = ++operation
      publish({ rootIssueLoading: true })
      try {
        const created = await api.issues.create(project.id, {
          title: truncateRuntimeTaskTitle(
            composerMarkdownText(content, { firstLine: true }) || content.trim()
          )!,
          description: content,
          ...(standInDeviceId
            ? {}
            : owner?.kind === 'user'
              ? { assigneeUserId: Number(owner.id), notifyAssignee: true }
              : owner?.kind === 'agent'
                ? { assigneeAgentId: owner.id }
                : owner?.kind === 'group'
                  ? { assigneeGroupId: owner.id }
                  : {}),
        })
        if (!current()) return false
        const pendingFiles: File[] = []
        let attachmentError = ''
        for (const file of files) {
          if (!current()) return false
          try {
            await api.attachments.upload(created.id, file)
          } catch (error) {
            pendingFiles.push(file)
            attachmentError = error instanceof Error ? error.message : String(error)
            if (current())
              input?.host.notify?.(
                error instanceof Error ? error.message : messages.loadFailed,
                'error'
              )
          }
        }
        if (!current()) return false
        if (standInDeviceId && api.standIn?.run) {
          try {
            if (pendingFiles.length) throw new Error(attachmentError)
            await api.standIn.run(project.id, created.id, standInDeviceId, standInId)
          } catch (error) {
            if (current())
              publish({
                standInRetry: {
                  projectId: project.id,
                  issueId: created.id,
                  deviceId: standInDeviceId,
                  standInId,
                  files: pendingFiles,
                  error: error instanceof Error ? error.message : String(error),
                },
              })
          }
        }
        if (!current() || !input) return false
        const currentHost = input.host
        if (currentHost.renderPersonalHome)
          publish({
            createdHomeIssue: {
              key: crypto.randomUUID(),
              project,
              issue: {
                ...created,
                project_key: project.project_key,
                project_name: project.name,
                has_active_task: false,
              },
            },
          })
        else if (input.project?.id === project.id)
          currentHost.navigate({
            ...currentHost.location,
            workspaceId: project.workspace_id ?? null,
            workspaceView: 'projects',
            projectId: project.id,
            projectView: 'board',
            projectSettingsSection: null,
            issueId: created.id,
          })
        return true
      } catch (error) {
        if (current())
          input?.host.notify?.(
            error instanceof Error ? error.message : messages.loadFailed,
            'error'
          )
        return false
      } finally {
        if (active(version) && operation === request) publish({ rootIssueLoading: false })
      }
    },
    async retryStandIn() {
      const retry = snapshot.standInRetry
      if (!retry || !api.standIn?.run || snapshot.standInRetrying) return
      const version = generation
      publish({ standInRetrying: true })
      const remainingFiles = [...retry.files]
      try {
        while (remainingFiles.length) {
          if (!active(version)) return
          await api.attachments.upload(retry.issueId, remainingFiles[0])
          remainingFiles.shift()
        }
        if (!active(version)) return
        await api.standIn.run(retry.projectId, retry.issueId, retry.deviceId, retry.standInId)
        if (active(version) && snapshot.standInRetry === retry) publish({ standInRetry: null })
      } catch (error) {
        if (active(version) && snapshot.standInRetry === retry)
          publish({
            standInRetry: {
              ...retry,
              files: remainingFiles,
              error: error instanceof Error ? error.message : String(error),
            },
          })
      } finally {
        if (active(version)) publish({ standInRetrying: false })
      }
    },
  }
}
