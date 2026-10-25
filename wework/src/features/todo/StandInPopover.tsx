import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
} from '@wegent/collaboration'
import {
  roleIncludesProject,
  subscribePersonalStandIn,
  type PersonalStandInSettings,
} from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInSettingsPage, type StandInSettingsHandle } from './StandInSettingsPage'
import { StandInIcon } from '@wegent/collaboration'

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
  const [settings, setSettings] = useState<PersonalStandInSettings | null>(null)
  const [availableProjects, setAvailableProjects] = useState<CollaborationProject[]>([])
  const requestClose = () => {
    if (!saving) editorRef.current?.requestClose()
  }
  const dialogRef = useDialogKeyboard<HTMLElement>(requestClose, open && !embedded)
  useEffect(() => {
    let active = true
    let targetDeviceId = editorDeviceId
    const unsubscribe = subscribePersonalStandIn(value => {
      if (active && value.userId === userId && value.executionDeviceId === targetDeviceId)
        setSettings(value)
    })
    void (async () => {
      const identity = await services?.getLocalRuntimeSidebarIdentity?.()
      if (!identity || !services?.standInApi || userId == null) return
      targetDeviceId = editorDeviceId || identity.deviceId
      const result = await services.standInApi.personalGet(userId, targetDeviceId)
      if (active) setSettings(result)
    })().catch(() => {
      /* The settings page exposes load errors and recovery. */
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [services, userId, editorDeviceId])
  useEffect(() => {
    if (!open) return
    let active = true
    void api.projects
      .list()
      .then(rows => {
        if (active) setAvailableProjects(rows)
      })
      .catch(() => {
        /* Existing project data remains available while disconnected. */
      })
    return () => {
      active = false
    }
  }, [api, open])
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
      <button
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
        {enabled && (
          <span
            data-testid="stand-in-enabled"
            className="h-1.5 w-1.5 rounded-full bg-text-primary"
          />
        )}
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-modal flex items-center justify-center bg-black/20 p-4"
            onMouseDown={event => {
              if (event.target === event.currentTarget) requestClose()
            }}
          >
            <section
              ref={dialogRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-label={t('standIn.title')}
              data-testid="stand-in-dialog"
              className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-background shadow-lg"
            >
              {editor}
            </section>
          </div>,
          document.body
        )}
    </>
  )
}
