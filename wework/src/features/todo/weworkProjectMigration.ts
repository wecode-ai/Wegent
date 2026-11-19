import type { CollaborationProject } from '@wegent/collaboration'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createHttpClient } from '@/api/http'
import { migrateLocalProject } from './localProjectMigration'

export interface ProjectMigrationInput {
  scope: string
  backend: string
  token: string | null
  userId: number
  cloudUserId: number | undefined
  localApi: SharedWorkspaceApi | null | undefined
  cloudApi: SharedWorkspaceApi | undefined
  services: WorkbenchServices
  onMigrated(project: CollaborationProject): void
  t(key: string): string
}
export function createWeworkProjectMigration() {
  let snapshot = {
    project: undefined as CollaborationProject | undefined,
    pending: false,
    error: '',
    stage: 'reading',
    revision: 0,
  }
  const observers = new Map<() => void, ProjectMigrationInput>()
  let input: ProjectMigrationInput | undefined
  let completedNavigation: { scope: string; project: CollaborationProject } | undefined
  function revealCompletedMigration() {
    if (!completedNavigation || !observers.size || !input) return
    const completed = completedNavigation
    completedNavigation = undefined
    if (completed.scope === input.scope) input.onMigrated(completed.project)
  }
  const publish = (next: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...next }
    observers.forEach((_, listener) => listener())
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, next: ProjectMigrationInput) {
      observers.set(listener, next)
      input = next
      revealCompletedMigration()
      return () => {
        observers.delete(listener)
        input = [...observers.values()].at(-1) ?? input
      }
    },
    select(project: CollaborationProject) {
      publish({ project, error: '' })
    },
    close() {
      if (!snapshot.pending) publish({ project: undefined })
    },
    async confirm() {
      const current = input
      const sourceProject = snapshot.project
      if (!current || !observers.size || snapshot.pending || !sourceProject) return
      const scope = current.scope
      const isCurrent = () => input?.scope === scope
      publish({ pending: true, error: '', stage: 'reading' })
      try {
        const chat = current.services.projectSpaceDetailServices?.local?.projectChatClient
        const identity = await current.services.getLocalRuntimeSidebarIdentity?.()
        if (!isCurrent()) return
        const migrationApi = current.services.projectSpaceApis?.local
        if (
          !current.localApi ||
          !current.cloudApi ||
          !chat ||
          !identity?.deviceId ||
          !migrationApi?.readProjectMigrationSnapshot ||
          !migrationApi.archiveMigratedProject
        )
          throw new Error(current.t('localProjectMigration.unavailable'))
        const project = await migrateLocalProject({
          sourceApi: current.localApi,
          sourceGuard: {
            read: () => migrationApi.readProjectMigrationSnapshot!(sourceProject.id),
            archive: (version, fingerprint, target) =>
              migrationApi.archiveMigratedProject!(sourceProject.id, version, fingerprint, target),
          },
          targetApi: current.cloudApi,
          chat,
          http: createHttpClient({
            baseUrl: current.backend,
            getToken: () => current.token,
            redirectOnUnauthorized: false,
          }),
          project: sourceProject,
          source: JSON.stringify([
            current.backend,
            current.cloudUserId,
            identity.deviceId,
            sourceProject.id,
          ]),
          userId: current.userId,
          onProgress: stage => publish({ stage }),
        })
        if (!isCurrent()) return
        const stillSelected =
          snapshot.project?.id === sourceProject.id &&
          snapshot.project.project_store === sourceProject.project_store
        publish({
          ...(stillSelected ? { project: undefined } : {}),
          revision: snapshot.revision + 1,
        })
        if (stillSelected) {
          completedNavigation = { scope, project }
          revealCompletedMigration()
        }
      } catch (cause) {
        if (isCurrent() && snapshot.project?.id === sourceProject.id)
          publish({
            error:
              cause instanceof Error && cause.message === 'local_project_public_activity_running'
                ? current.t('localProjectMigration.busy')
                : cause instanceof Error &&
                    cause.message === 'local_project_changed_during_migration'
                  ? current.t('localProjectMigration.sourceChanged')
                  : cause instanceof Error
                    ? cause.message
                    : current.t('localProjectMigration.failed'),
          })
      } finally {
        publish({ pending: false })
      }
    },
  }
}
