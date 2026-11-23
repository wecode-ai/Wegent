import { roleIncludesProject } from '@/api/personalStandIn'
import { BetaBadge } from '@/components/common/BetaBadge'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
} from '@wegent/collaboration'
import { StandInIcon } from '@wegent/collaboration'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { createStandInPopoverSettingsResource } from './standInPopoverSettingsResource'
import { createPortal } from 'react-dom'
import { StandInSettingsPage, type StandInSettingsHandle } from './StandInSettingsPage'

/** Project entries select or create a personally owned stand-in for this project. */
export function StandInPopover({
  api,
  project,
  devices = [],
  services,
  initialDeviceId,
  initialProfileId,
  onSaved,
  onSavingChange,
  onCancel,
  embedded = false,
  userId,
  projects = [],
  onOpenPersonalSettings,
}: {
  api: SharedWorkspaceApi
  project: CollaborationProject
  devices?: DeviceInfo[]
  services?: WorkbenchServices
  readLocalIdentity?: WorkbenchServices['getLocalRuntimeSidebarIdentity']
  initialDeviceId?: string
  initialProfileId?: string
  onSaved?(settings: WorkspaceStandInSettings, action?: 'settings' | 'automatic'): void
  onSavingChange?(saving: boolean): void
  onCancel?(): void
  embedded?: boolean
  userId?: number
  projects?: CollaborationProject[]
  onOpenPersonalSettings?(roleId: string, deviceId: string): void
}) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(embedded)
  const [savedDeviceId, setSavedDeviceId] = useState<string>()
  const editorDeviceId = initialDeviceId || savedDeviceId
  const [saving, setSaving] = useState(false)
  const editorRef = useRef<StandInSettingsHandle>(null)
  const requestClose = () => {
    if (!saving) editorRef.current?.requestClose()
  }
  const dialogRef = useRef<HTMLElement>(null)
  const settingsResource = useMemo(
    () =>
      services?.standInApi && userId != null
        ? createStandInPopoverSettingsResource({
            api: services.standInApi,
            identify: services.getLocalRuntimeSidebarIdentity,
            userId,
            deviceId: editorDeviceId,
          })
        : null,
    [services, userId, editorDeviceId]
  )
  const settingsSnapshot = useSyncExternalStore(
    settingsResource?.subscribe ?? subscribeIdleResource,
    settingsResource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const settings = settingsSnapshot.data
  const projectResource = useMemo(
    () =>
      createAsyncResource(
        JSON.stringify(['stand-in-project-catalog', userId]),
        () => api.projects.list(),
        { refreshOnSubscribe: true }
      ),
    [api, userId]
  )
  const projectSnapshot = useSyncExternalStore(
    open && services?.standInApi && userId != null
      ? projectResource.subscribe
      : subscribeIdleResource,
    projectResource.getSnapshot,
    getIdleResourceSnapshot
  )
  const availableProjects = projectSnapshot.data ?? []
  if (!services?.standInApi || userId == null) return null
  const projectRef = {
    id: project.id,
    store: project.project_store === 'local' ? ('local' as const) : ('cloud' as const),
  }
  const enabled =
    settings?.roles.some(role => role.enabled && roleIncludesProject(role, projectRef)) ?? false
  const allProjects = [
    ...new Map(
      [...availableProjects, ...projects, project].map(row => [
        `${row.project_store}:${row.id}`,
        row,
      ])
    ).values(),
  ]
  const editor = (
    <StandInSettingsPage
      ref={editorRef}
      api={api}
      projects={allProjects}
      services={services}
      devices={devices}
      userId={userId}
      initialProject={project}
      initialDeviceId={editorDeviceId}
      initialProfileId={initialProfileId}
      onOpenPersonalSettings={
        onOpenPersonalSettings
          ? (roleId, deviceId) => {
              setOpen(false)
              onOpenPersonalSettings(roleId, deviceId)
            }
          : undefined
      }
      onCancel={() => {
        setOpen(false)
        onCancel?.()
      }}
      onSavingChange={value => {
        setSaving(value)
        onSavingChange?.(value)
      }}
      onSaved={value => {
        setSavedDeviceId(value.executionDeviceId)
        onSaved?.(value, 'settings')
        setOpen(false)
      }}
    />
  )
  if (embedded) return editor
  return (
    <>
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="stand-in-open"
        aria-label={t('standIn.title')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        title={t(enabled ? 'standIn.enabled' : 'standIn.title')}
        className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted"
      >
        <StandInIcon enabled={enabled} />
        <span>{t('standIn.title')}</span>
        <BetaBadge testId="stand-in-project-beta" />
        {enabled && (
          <span
            data-testid="stand-in-enabled"
            className="h-1.5 w-1.5 rounded-full bg-text-primary"
          />
        )}
      </ControlButton>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-modal flex items-center justify-center bg-black/20 p-4"
            onMouseDown={event => {
              if (event.target === event.currentTarget) requestClose()
            }}
          >
            <DialogSurface
              onClose={requestClose}
              active={open && !embedded}
              render={
                <section
                  ref={dialogRef}
                  tabIndex={-1}
                  aria-label={t('standIn.title')}
                  data-testid="stand-in-dialog"
                  className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-background shadow-lg"
                />
              }
            >
              {editor}
            </DialogSurface>
          </div>,
          document.body
        )}
    </>
  )
}
