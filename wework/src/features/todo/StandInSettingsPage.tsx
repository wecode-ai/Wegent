import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import type { StandInProjectSettings } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInPopover } from './StandInPopover'
import { StandInIcon } from './StandInIcon'

function standInListError(cause: unknown, outdatedMessage: string) {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /Unsupported runtime RPC method: runtime\.stand_in\./.test(message)
    ? outdatedMessage
    : message
}

export function StandInSettingsPage({
  api,
  projects,
  services,
  devices,
  userId,
}: {
  api: SharedWorkspaceApi
  projects: CollaborationProject[]
  services: WorkbenchServices
  devices: DeviceInfo[]
  userId: number
}) {
  const { t } = useTranslation('common')
  const [result, setResult] = useState<{
    key: string
    rows: StandInProjectSettings[]
    error: string | null
  } | null>(null)
  const [revision, setRevision] = useState(0)
  const [editing, setEditing] = useState<{
    projectId: string
    deviceId?: string
    profileId?: string
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const closeEditor = () => {
    if (!saving) setEditing(null)
  }
  const dialogRef = useDialogKeyboard<HTMLElement>(
    closeEditor,
    Boolean(editing),
    'select:not([disabled])'
  )
  const project = projects.find(project => project.id === editing?.projectId)
  const deviceKeys = devices
    .filter(device => device.status !== 'offline')
    .map(device => device.device_id)
    .sort()
    .join('\n')
  const requestKey = JSON.stringify([userId, deviceKeys, revision])
  const currentResult = result?.key === requestKey ? result : null
  const loading = !currentResult
  const rows = currentResult?.rows ?? []
  const error = currentResult?.error ?? null
  useEffect(() => {
    let active = true
    void (async () => {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      const targets = new Set(deviceKeys.split('\n').filter(Boolean))
      if (identity?.deviceId) {
        for (const device of devices)
          if ([device.device_id, device.app_device_id].includes(identity.deviceId))
            targets.delete(device.device_id)
        targets.add(identity.deviceId)
      }
      const results = await Promise.allSettled(
        [...targets].map(deviceId => services.standInApi!.list(userId, deviceId, true))
      )
      if (!active) return
      const failure = results.find(result => result.status === 'rejected')
      setResult({
        key: requestKey,
        rows: results.flatMap(result => (result.status === 'fulfilled' ? result.value : [])),
        error:
          failure?.status === 'rejected'
            ? standInListError(failure.reason, t('standIn.executor_update_required'))
            : null,
      })
    })().catch(cause => {
      if (active) setResult({ key: requestKey, rows: [], error: String(cause) })
    })
    return () => {
      active = false
    }
  }, [services, userId, deviceKeys, devices, revision, requestKey, t])
  const visibleRows = rows.filter(row =>
    projects.some(
      project =>
        project.id === row.projectId &&
        (project.project_store === 'local' ? 'local' : 'cloud') === row.projectStore
    )
  )
  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-y-auto px-6 py-6"
      data-testid="stand-in-page"
    >
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="heading-lg text-text-primary">{t('standIn.title')}</h1>
            <p className="mt-1 text-sm text-text-muted">{t('standIn.list_description')}</p>
          </div>
          <button
            type="button"
            data-testid="stand-in-list-configure"
            disabled={!projects.length}
            onClick={() => setEditing({ projectId: projects[0].id })}
            className="min-h-11 shrink-0 rounded-lg bg-text-primary px-3 text-sm text-background disabled:opacity-40 md:min-h-8"
          >
            {t('standIn.configure')}
          </button>
        </header>
        {error && (
          <div
            role="alert"
            data-testid="stand-in-list-error"
            className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-error"
          >
            <p>{error}</p>
            <button
              type="button"
              data-testid="stand-in-list-retry"
              onClick={() => setRevision(value => value + 1)}
              className="underline"
            >
              {t('standIn.reload')}
            </button>
          </div>
        )}
        {loading ? (
          <p role="status" className="text-sm text-text-muted">
            {t('standIn.loading')}
          </p>
        ) : visibleRows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="stand-in-list">
              <thead className="text-xs text-text-muted">
                <tr>
                  {['title', 'collaboration_project', 'device', 'auto', 'actions'].map(key => (
                    <th
                      key={key}
                      scope="col"
                      className="border-b border-border px-3 py-2 font-normal"
                    >
                      {t(`standIn.${key}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(row => {
                  const project = projects.find(
                    project =>
                      project.id === row.projectId &&
                      (project.project_store === 'local' ? 'local' : 'cloud') === row.projectStore
                  )!
                  const device = devices.find(device =>
                    [device.device_id, device.app_device_id].includes(row.executionDeviceId)
                  )
                  return (
                    <tr
                      key={`${row.projectStore}:${row.projectId}:${row.executionDeviceId}:${row.id}`}
                      data-testid={`stand-in-list-row-${row.projectId}`}
                      className="border-b border-border/60"
                    >
                      <td className="px-3 py-4">
                        <span className="inline-flex items-center gap-2 font-medium text-text-primary">
                          <StandInIcon enabled={row.enabled} />
                          {row.name || t('standIn.default_profile')}
                        </span>
                      </td>
                      <td className="px-3 py-4 text-text-secondary">{project.name}</td>
                      <td className="px-3 py-4 text-text-secondary">
                        <span>{device?.name ?? row.executionDeviceId}</span>
                        <span className="mt-1 block max-w-64 truncate text-xs text-text-muted">
                          {row.workspace?.workspacePath || t('standIn.inherit_environment')}
                        </span>
                      </td>
                      <td className="px-3 py-4 text-text-secondary">
                        {t(row.enabled ? 'standIn.auto_on' : 'standIn.auto_off')}
                      </td>
                      <td className="px-3 py-4">
                        <button
                          type="button"
                          data-testid={`stand-in-list-edit-${row.projectId}`}
                          onClick={() =>
                            setEditing({
                              projectId: row.projectId,
                              deviceId: row.executionDeviceId,
                              profileId: row.id,
                            })
                          }
                          className="min-h-11 rounded-md px-2 text-text-secondary hover:bg-muted md:min-h-7"
                        >
                          {t('standIn.configure')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div
            className="py-16 text-center text-sm text-text-muted"
            data-testid="stand-in-list-empty"
          >
            {t(projects.length ? 'standIn.list_empty' : 'standIn.no_projects')}
          </div>
        )}
      </div>
      {editing && project && (
        <div
          className="fixed inset-0 z-modal flex items-center justify-center bg-black/25 p-4"
          onMouseDown={event => {
            if (event.target === event.currentTarget) closeEditor()
          }}
        >
          <section
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="stand-in-page-editor-title"
            data-testid="stand-in-page-editor"
            className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-background shadow-lg"
          >
            <header className="flex items-center gap-3 px-5 pb-2 pt-4">
              <h2 id="stand-in-page-editor-title" className="heading-sm mr-auto">
                {t('standIn.configure')}
              </h2>
              <label className="sr-only" htmlFor="stand-in-project-select">
                {t('standIn.collaboration_project')}
              </label>
              <select
                id="stand-in-project-select"
                data-testid="stand-in-project-select"
                value={project.id}
                disabled={saving}
                onChange={event => setEditing({ projectId: event.target.value })}
                className="min-h-8 max-w-56 rounded-md bg-transparent px-2 text-sm text-text-secondary"
              >
                {projects.map(project => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid="stand-in-page-editor-close"
                aria-label={t('standIn.close')}
                disabled={saving}
                onClick={closeEditor}
                className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <StandInPopover
              key={`${project.id}:${editing.deviceId}:${editing.profileId}`}
              embedded
              api={api}
              project={project}
              services={services}
              devices={devices}
              readLocalIdentity={services.getLocalRuntimeSidebarIdentity}
              userId={userId}
              projects={projects}
              initialDeviceId={editing.deviceId}
              initialProfileId={editing.profileId}
              onSavingChange={setSaving}
              onCancel={closeEditor}
              onSaved={() => {
                setRevision(value => value + 1)
                setSaving(false)
                setEditing(null)
              }}
            />
          </section>
        </div>
      )}
    </section>
  )
}
