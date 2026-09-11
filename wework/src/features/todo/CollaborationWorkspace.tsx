// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CollaborationPlatformApp,
  type CollaborationPlatformLocation,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import { ArrowLeft, HardDrive, X } from 'lucide-react'
import type { CloudProject } from '@/api/deliveries'
import { DesktopSidebarAccount } from '@/components/layout/DesktopSidebarAccount'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { openExternalUrl } from '@/lib/external-links'
import { useTranslation } from '@/hooks/useTranslation'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import type { RuntimeProjectSpaceRef } from '@/types/api'
import { cn } from '@/lib/utils'
import {
  toWeworkCloudExecutionProject,
  useWeworkCollaborationIssueTaskHost,
  type WeworkIssueTaskStartFailure,
} from '@/features/collaboration/WeworkCollaborationIssueTaskHost'
import { CloudTodoWorkspace, type CloudTodoWorkspaceProps } from './CloudTodoWorkspace'

const rootLocation: CollaborationPlatformLocation = {
  platformView: 'spaces',
  workspaceId: null,
  workspaceView: 'home',
  projectId: null,
  projectView: 'board',
  issueId: null,
}

function SharedCollaborationWorkspace({
  api,
  ...props
}: CloudTodoWorkspaceProps & { api: SharedWorkspaceApi }) {
  const { t, i18n } = useTranslation('common')
  const { onActiveProjectChange, onFocusedItemHandled } = props
  const localProjectApi = props.services.projectSpaceApis?.local
  const [location, setLocation] = useState<CollaborationPlatformLocation>(rootLocation)
  const [localProjects, setLocalProjects] = useState<CloudProject[]>([])
  const [localProjectRef, setLocalProjectRef] = useState<RuntimeProjectSpaceRef | null>(null)
  const [issueTaskError, setIssueTaskError] = useState<string | null>(null)
  const projectNavigationTokenRef = useRef(0)
  const activeProjectControlled = props.activeProjectRef !== undefined
  const activeProjectStore = props.activeProjectRef?.projectStore
  const activeProjectId = props.activeProjectRef?.projectId

  useEffect(() => {
    let active = true
    if (!localProjectApi) return
    void localProjectApi
      .listCloudProjects()
      .then(response => {
        if (active) setLocalProjects(response.items)
      })
      .catch(() => {
        if (active) setLocalProjects([])
      })
    return () => {
      active = false
    }
  }, [localProjectApi])

  const navigate = useCallback(
    (next: CollaborationPlatformLocation) => {
      const requestToken = ++projectNavigationTokenRef.current
      setLocation(next)
      setLocalProjectRef(null)
      if (location.issueId && !next.issueId) onFocusedItemHandled?.()
      if (!next.projectId) {
        onActiveProjectChange?.(null)
        return
      }
      if (!api || next.projectId === location.projectId) return
      void api.projects
        .get(next.projectId)
        .then(project => {
          if (projectNavigationTokenRef.current !== requestToken) return
          onActiveProjectChange?.(toWeworkCloudExecutionProject(project))
        })
        .catch(error => {
          if (projectNavigationTokenRef.current !== requestToken) return
          console.error('[Wework] Failed to open the collaboration project', error)
        })
    },
    [api, location.issueId, location.projectId, onActiveProjectChange, onFocusedItemHandled]
  )

  const handleIssueTaskError = useCallback(
    (failure: WeworkIssueTaskStartFailure) => {
      setIssueTaskError(
        failure.kind === 'runtime_unavailable'
          ? t('todo.run_unavailable', '运行服务当前不可用')
          : failure.cause.message ||
              t('workbench.issue_task_prepare_failed', '无法准备本地任务，请重试')
      )
    },
    [t]
  )
  const { onCreateTask, launcher } = useWeworkCollaborationIssueTaskHost({
    api,
    services: props.services,
    localProjects: props.localProjects,
    runtimeWork: props.runtimeWork,
    onOpenRuntimeTask: props.onOpenRuntimeTask,
    onError: handleIssueTaskError,
  })
  const startIssueTask = useCallback(
    async (...args: Parameters<typeof onCreateTask>) => {
      setIssueTaskError(null)
      await onCreateTask(...args)
    },
    [onCreateTask]
  )
  const revealReadyWorkspace = useCallback(() => {
    if (!props.startupActive || !isElectronRuntime() || getDesktopWindowLabel() !== 'main') return
    void invokeDesktopHost<void>('renderer.startupReady').catch(error => {
      console.error('[Wework] Failed to reveal the ready collaboration space', error)
    })
  }, [props.startupActive])
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  const host = useMemo(
    () => ({
      location,
      capabilities: {
        automation: false,
        dingtalkAitable: false,
      },
      navigate,
      openExternal: (url: string) => {
        void openExternalUrl(url)
      },
    }),
    [location, navigate]
  )

  const openLocalProject = useCallback(
    (projectId: string) => {
      const project = localProjects.find(candidate => String(candidate.id) === projectId)
      if (!project) return
      const ref: RuntimeProjectSpaceRef = {
        projectStore: 'local',
        projectId: String(project.id),
      }
      setLocalProjectRef(ref)
      onActiveProjectChange?.({ ...project, location: 'local' })
    },
    [localProjects, onActiveProjectChange]
  )

  const externallySelectedProjectRef =
    activeProjectControlled && activeProjectStore && activeProjectId
      ? {
          projectStore: activeProjectStore,
          projectId: activeProjectId,
        }
      : null
  const selectedProjectRef = externallySelectedProjectRef ?? localProjectRef

  return (
    <div
      className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-background text-text-primary"
      data-testid="wework-collaboration-platform"
    >
      <header className="electron-titlebar-interactive-region flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          {selectedProjectRef ? (
            <button
              type="button"
              data-testid="wework-collaboration-back-to-platform"
              className="flex h-7 items-center gap-1 rounded-lg px-2 text-sm text-text-secondary transition hover:bg-muted hover:text-text-primary"
              onClick={() => {
                setLocalProjectRef(null)
                onActiveProjectChange?.(null)
              }}
            >
              <ArrowLeft className="h-4 w-4" />
              {t('workbench.back_to_collaboration', '返回协作空间')}
            </button>
          ) : (
            <span className="truncate text-sm font-medium">
              {t('workbench.workspace_tab_board', '协作')}
            </span>
          )}
        </div>
        <div className="electron-titlebar-interactive-region flex items-center gap-2">
          {localProjectApi && localProjects.length > 0 && !selectedProjectRef ? (
            <label className="flex items-center gap-1.5 text-sm text-text-secondary">
              <HardDrive className="h-4 w-4" />
              <span>{t('workbench.local_project_spaces', '本地项目')}</span>
              <select
                data-testid="wework-local-project-space-select"
                className={cn(
                  'h-7 max-w-48 rounded-lg border border-border bg-background px-2 text-sm text-text-primary',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus'
                )}
                value=""
                onChange={event => openLocalProject(event.target.value)}
              >
                <option value="">{t('todo.select_local_project', '选择项目')}</option>
                {localProjects.map(project => (
                  <option key={project.id} value={String(project.id)}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {props.onOpenSettings && props.onLogout ? (
            <DesktopSidebarAccount
              compact
              user={props.user}
              onOpenSettings={props.onOpenSettings}
              onLogout={props.onLogout}
            />
          ) : null}
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        {selectedProjectRef ? (
          <CloudTodoWorkspace
            {...props}
            activeProjectRef={selectedProjectRef}
            defaultProjectRequested={false}
            focusedItemId={props.focusedItemId}
            onFocusedItemHandled={() => undefined}
          />
        ) : (
          <CollaborationPlatformApp
            api={api}
            host={host}
            locale={locale}
            onCreateTask={startIssueTask}
            onReady={revealReadyWorkspace}
          />
        )}
        {issueTaskError ? (
          <div
            role="alert"
            data-testid="wework-collaboration-issue-task-error"
            className="absolute left-1/2 top-3 z-popover flex max-w-[560px] -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm text-danger shadow-lg"
          >
            <span className="min-w-0 flex-1">{issueTaskError}</span>
            <button
              type="button"
              data-testid="wework-collaboration-issue-task-error-dismiss"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
              aria-label={t('common.close', '关闭')}
              onClick={() => setIssueTaskError(null)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}
        {launcher}
      </div>
    </div>
  )
}

export interface CollaborationWorkspaceProps extends CloudTodoWorkspaceProps {
  entryMode: 'platform' | 'project'
}

export function CollaborationWorkspace({ entryMode, ...props }: CollaborationWorkspaceProps) {
  const api = props.services.sharedWorkspaceApi
  if (!api || entryMode === 'project') return <CloudTodoWorkspace {...props} />
  return <SharedCollaborationWorkspace {...props} api={api} />
}
