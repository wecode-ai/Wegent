import { useEffect, useMemo, useState } from 'react'
import type { CollaborationProject } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, RuntimeTaskAddress, User } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage, reportStandInError } from '@/lib/stand-in-error-message'
import { createLocalWorkspaceApi } from './localWorkspaceApi'
import { createWeworkPlatformApi } from './weworkPlatformApi'
import { StandInOverviewPage } from './StandInOverviewPage'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'

export function PersonalStandInWorkspace({
  services,
  user,
  devices,
  active,
  contentRoute,
  onClose,
  onOpenTask,
}: {
  services: WorkbenchServices
  user: User
  devices: DeviceInfo[]
  active: boolean
  contentRoute: string
  onClose(): void
  onOpenTask(address: RuntimeTaskAddress): Promise<void> | void
}) {
  const { t, i18n } = useTranslation('common')
  const query = new URLSearchParams(contentRoute.split('?')[1] ?? '')
  const profileId = query.get('profileId') ?? undefined
  const deviceId = query.get('deviceId') ?? undefined
  const workView = query.get('view') === 'scheduled' ? 'scheduled' : 'work'
  const [projects, setProjects] = useState<CollaborationProject[]>([])
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!active || !isElectronRuntime() || getDesktopWindowLabel() !== 'main') return
    void invokeDesktopHost<void>('renderer.startupReady').catch(cause => {
      console.error('[Wework] Failed to reveal the personal stand-in workspace', cause)
    })
  }, [active])
  const api = useMemo(
    () =>
      createWeworkPlatformApi(
        services.sharedWorkspaceApi,
        createLocalWorkspaceApi(
          services.projectSpaceApis?.local,
          Number(user.id),
          user.user_name || 'local',
          user.email ?? null,
          services.projectSpaceDetailServices?.local,
          i18n.language === 'en' ? 'en' : 'zh-CN'
        )
      ),
    [services, user.id, user.user_name, user.email, i18n.language]
  )
  useEffect(() => {
    if (!api || !active) return
    let current = true
    void api.projects.list().then(
      rows => {
        if (current) {
          setProjects(rows)
          setError(null)
        }
      },
      cause => {
        if (current) {
          reportStandInError('load_projects', cause)
          setError(getStandInErrorMessage(cause, 'load_projects_failed'))
        }
      }
    )
    return () => {
      current = false
    }
  }, [api, active, attempt])
  if (!api)
    return (
      <p role="alert" className="p-5 text-sm">
        {t('standIn.errors.backend_connection_unavailable')}
      </p>
    )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="personal-stand-in-workspace">
      {error && (
        <div role="alert" className="flex items-center gap-2 px-5 py-2 text-sm text-error">
          <span>{error}</span>
          <button
            type="button"
            data-testid="stand-in-project-catalog-retry"
            onClick={() => setAttempt(value => value + 1)}
            className="min-h-11 px-2 underline md:min-h-8"
          >
            {t('standIn.reload')}
          </button>
        </div>
      )}
      <StandInOverviewPage
        key={deviceId ?? 'default'}
        initialProfileId={profileId}
        initialDeviceId={deviceId}
        settingsRequestKey={query.get('settingsRequest') ?? undefined}
        initialWorkView={workView}
        api={api}
        projects={projects}
        services={services}
        devices={devices}
        userId={Number(user.id)}
        active={active}
        onCancel={onClose}
        onOpenTask={onOpenTask}
      />
    </div>
  )
}
