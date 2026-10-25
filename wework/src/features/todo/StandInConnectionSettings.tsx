import { useState } from 'react'
import { ArrowLeft, ChevronRight, Folder, MessageSquare, Plus } from 'lucide-react'
import type { CollaborationProject } from '@wegent/collaboration'
import { standInPolicy, type StandInHandlingPolicy, type StandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInConnections } from './StandInConnections'
import { StandInDingTalkConnections } from './StandInDingTalkConnections'

export function StandInConnectionSettings({
  role,
  projects,
  api,
  deviceId,
  localDeviceId,
  disabled,
  onChange,
  focusedProjectId,
}: {
  role: StandInRole
  projects: CollaborationProject[]
  api?: StandInExecutorApi
  deviceId: string
  localDeviceId: string
  disabled: boolean
  onChange(role: StandInRole): void
  focusedProjectId?: string
}) {
  const { t } = useTranslation('common')
  const [view, setView] = useState<'projects' | 'dingtalk' | null>(null)
  const [adding, setAdding] = useState(false)
  const policyLabel = (policy: StandInHandlingPolicy) =>
    t(
      !policy.automatic
        ? 'standIn.workspace.policy_manual'
        : policy.askBeforeAct
          ? 'standIn.workspace.policy_confirm'
          : 'standIn.workspace.policy_automatic'
    )
  const source = role.collaboration
  const projectRows = !source.enabled
    ? []
    : source.allProjects
      ? [
          {
            key: 'all-projects',
            name: t('standIn.personal.all_projects'),
            detail: t('standIn.workspace.project_scope_summary', {
              count: source.excludedProjects.length,
            }),
            policy: standInPolicy(role),
            view: 'projects' as const,
          },
        ]
      : source.projects.map(ref => ({
          key: `project-${ref.store}-${ref.id}`,
          name:
            projects.find(
              project =>
                project.id === ref.id &&
                (project.project_store === 'local' ? 'local' : 'cloud') === ref.store
            )?.name ?? ref.id,
          detail: t('standIn.personal.collaboration'),
          policy: standInPolicy(role, ref),
          view: 'projects' as const,
        }))
  const rows = [
    ...projectRows,
    ...(role.dingtalk ?? []).map(connection => ({
      key: `dingtalk-${connection.profile}-${connection.kind}-${connection.id}`,
      name: connection.name,
      detail: t(
        connection.kind === 'group'
          ? 'standIn.workspace.connection_group_summary'
          : 'standIn.workspace.connection_contact_summary'
      ),
      policy: connection.policy,
      view: 'dingtalk' as const,
    })),
  ]
  return (
    <section className="space-y-3" data-testid="stand-in-connection-settings">
      {view ? (
        <>
          <button
            type="button"
            data-testid="stand-in-connections-back"
            disabled={disabled}
            className="flex min-h-8 items-center gap-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-40"
            onClick={() => setView(null)}
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            {t('standIn.workspace.back_to_connections')}
          </button>
          {view === 'projects' ? (
            <StandInConnections
              role={role}
              projects={projects}
              focusedProjectId={focusedProjectId}
              disabled={disabled}
              onChange={onChange}
            />
          ) : (
            api && (
              <StandInDingTalkConnections
                role={role}
                api={api}
                deviceId={deviceId}
                localDeviceId={localDeviceId}
                disabled={disabled}
                onChange={onChange}
              />
            )
          )}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-medium">{t('standIn.workspace.connections')}</h3>
            <button
              type="button"
              data-testid="stand-in-add-connection"
              aria-expanded={adding}
              disabled={disabled}
              onClick={() => setAdding(value => !value)}
              className="flex min-h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted disabled:opacity-40"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t('standIn.workspace.add_connection')}
            </button>
          </div>
          {adding && (
            <div
              className="rounded-lg border border-border p-1"
              data-testid="stand-in-connection-type-picker"
            >
              {(['projects', ...(api ? ['dingtalk'] : [])] as ('projects' | 'dingtalk')[]).map(
                type => (
                  <button
                    key={type}
                    type="button"
                    data-testid={`stand-in-add-${type}-connection`}
                    disabled={disabled}
                    className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setView(type)
                      setAdding(false)
                    }}
                  >
                    {type === 'projects' ? (
                      <Folder aria-hidden="true" className="h-4 w-4" />
                    ) : (
                      <MessageSquare aria-hidden="true" className="h-4 w-4" />
                    )}
                    <span className="flex-1">
                      {t(
                        type === 'projects'
                          ? 'standIn.personal.collaboration'
                          : 'standIn.workspace.dingtalk'
                      )}
                    </span>
                    <ChevronRight aria-hidden="true" className="h-4 w-4 text-text-muted" />
                  </button>
                )
              )}
            </div>
          )}
          {rows.length ? (
            <div className="divide-y divide-border" data-testid="stand-in-connected-list">
              {rows.map(row => (
                <button
                  key={row.key}
                  type="button"
                  data-testid={`stand-in-connection-${row.key}`}
                  disabled={disabled}
                  onClick={() => setView(row.view)}
                  className="flex min-h-14 w-full items-center gap-3 rounded-md px-2 py-3 text-left hover:bg-muted disabled:opacity-40"
                >
                  {row.view === 'projects' ? (
                    <Folder aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
                  ) : (
                    <MessageSquare
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-text-secondary"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{row.name}</span>
                    <span className="mt-1 block text-xs text-text-muted">{row.detail}</span>
                  </span>
                  <span className="max-w-32 text-right text-xs text-text-secondary">
                    {policyLabel(row.policy)}
                  </span>
                  <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                </button>
              ))}
            </div>
          ) : (
            <p className="py-4 text-sm text-text-muted" data-testid="stand-in-connections-empty">
              {t('standIn.workspace.connections_empty')}
            </p>
          )}
        </>
      )}
    </section>
  )
}
