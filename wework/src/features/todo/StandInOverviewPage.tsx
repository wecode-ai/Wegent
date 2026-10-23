import { useContext, useEffect, useState, type ComponentProps } from 'react'
import { ChevronRight, Folder, Settings } from 'lucide-react'
import { roleIncludesProject, subscribePersonalStandIn } from '@/api/personalStandIn'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { standInOrigin, standInState } from '@/features/notifications/standInNotifications'
import type { RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { usePersonalStandIn } from './usePersonalStandIn'
import { StandInSettingsPage } from './StandInSettingsPage'
import { standInDeviceLabel, standInErrorMessage } from './standInErrors'
import { StandInIcon } from '@wegent/collaboration'

type SettingsProps = ComponentProps<typeof StandInSettingsPage>

export function StandInOverviewPage({
  onOpenTask,
  ...props
}: SettingsProps & { onOpenTask?(address: RuntimeTaskAddress): Promise<void> | void }) {
  const { t } = useTranslation('common')
  const workbench = useContext(WorkbenchContext)
  const state = usePersonalStandIn(props.services, props.userId, undefined, false)
  const { saved, setDraft } = state
  const errorMessage =
    state.error &&
    standInErrorMessage(
      state.error,
      standInDeviceLabel(props.devices, state.loadDeviceId || state.currentDeviceId),
      t
    )
  const [editing, setEditing] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  useEffect(() => {
    const unsubscribe = subscribePersonalStandIn(value => {
      if (value.userId === props.userId && value.executionDeviceId === saved?.executionDeviceId)
        setDraft(value)
    })
    return () => {
      unsubscribe()
    }
  }, [props.userId, saved?.executionDeviceId, setDraft])
  const roles = state.draft?.roles ?? []
  const connected = props.projects.filter(project =>
    roles.some(role =>
      roleIncludesProject(role, {
        id: project.id,
        store: project.project_store === 'local' ? 'local' : 'cloud',
      })
    )
  )
  const items = (workbench?.runtimeTaskReminders.items ?? [])
    .filter(item => standInOrigin(item))
    .sort((a, b) => standInState(b).updatedAt.localeCompare(standInState(a).updatedAt))
  const groups = new Map<string, { name: string; items: typeof items }>()
  for (const item of items) {
    const origin = standInOrigin(item)!
    const key = `${origin.projectStore}:${origin.cloudProjectId}`
    const project = props.projects.find(
      project =>
        project.id === origin.cloudProjectId &&
        (project.project_store === 'local' ? 'local' : 'cloud') ===
          (origin.projectStore === 'local' ? 'local' : 'cloud')
    )
    const group = groups.get(key) ?? {
      name: project?.name || item.projectName || t('standIn.personal.collaboration'),
      items: [],
    }
    group.items.push(item)
    groups.set(key, group)
  }
  if (editing)
    return (
      <StandInSettingsPage
        {...props}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          state.reload()
          setEditing(false)
        }}
      />
    )
  return (
    <section
      className="h-full overflow-y-auto p-5 text-base text-text-primary"
      data-testid="stand-in-overview"
    >
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <header className="flex items-center justify-between gap-4">
          <h1 className="heading-md">{t('standIn.title')}</h1>
          <button
            type="button"
            data-testid="stand-in-settings-open"
            onClick={() => setEditing(true)}
            className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted"
          >
            <Settings className="h-4 w-4" />
            {t('standIn.personal.settings')}
          </button>
        </header>
        {state.loading ? (
          <p role="status" className="text-text-muted">
            {t('standIn.loading')}
          </p>
        ) : errorMessage ? (
          <div role="alert" className="text-sm text-error">
            <p>{errorMessage}</p>
            <button
              type="button"
              data-testid="stand-in-overview-retry"
              onClick={state.reload}
              className="mt-2 underline"
            >
              {t('standIn.reload')}
            </button>
          </div>
        ) : (
          <div
            className="flex items-center gap-3 rounded-xl bg-muted/40 p-4"
            data-testid="stand-in-overview-status"
          >
            <StandInIcon
              enabled={roles.some(role => role.enabled && role.collaboration.enabled)}
              className="h-5 w-5 shrink-0"
            />
            <div>
              <p className="font-medium">
                {t(
                  roles.some(role => role.enabled && role.collaboration.enabled)
                    ? 'standIn.auto_on'
                    : 'standIn.auto_off'
                )}
              </p>
              <p className="mt-1 text-sm text-text-muted">
                {t('standIn.personal.connected_selected', { count: connected.length })}
              </p>
            </div>
          </div>
        )}
        <div className="space-y-4" data-testid="stand-in-activity">
          <h2 className="font-medium">{t('standIn.personal.activity')}</h2>
          {!items.length && (
            <p className="py-8 text-sm text-text-muted">{t('standIn.personal.activity_empty')}</p>
          )}
          {[...groups].map(([key, group]) => (
            <section key={key} data-testid="stand-in-activity-project" className="space-y-2">
              <h3 className="flex items-center gap-2 text-sm text-text-muted">
                <Folder className="h-4 w-4" />
                {group.name}
              </h3>
              <div className="divide-y divide-border">
                {group.items.map(item => {
                  const status = standInState(item)
                  return (
                    <button
                      key={item.key}
                      type="button"
                      data-testid={`stand-in-activity-task-${item.task.taskId}`}
                      disabled={!onOpenTask}
                      onClick={async () => {
                        setOpenError(null)
                        try {
                          await onOpenTask?.(item.address)
                        } catch (cause) {
                          setOpenError(String(cause))
                        }
                      }}
                      className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-muted disabled:opacity-50"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{item.task.title}</span>
                        <span className="mt-1 block text-xs text-text-muted">
                          {new Date(status.updatedAt).toLocaleString()}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm text-text-secondary">
                        {t(`standIn.personal.activity_${status.status}`)}
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
          {openError && (
            <p role="alert" className="text-sm text-error">
              {openError}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
