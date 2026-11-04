import { Clock, ChevronRight, Folder, Mail, MessageSquare, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { CollaborationProject } from '@wegent/collaboration'
import type { StandInRole } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { EMAIL_PROVIDER } from './StandInEmailConnections'
import { findStandInProject } from './standInProjects'

const DINGTALK_PROVIDER = '@wegent/dsh-connection-dingtalk/dingtalk'

export function StandInConnectionCatalog({
  role,
  projects,
  providers,
  loading,
  disabled,
  scheduling,
  local = true,
  onSelect,
}: {
  role: StandInRole
  projects: CollaborationProject[]
  providers: ConnectionProviderDescriptor[]
  loading: boolean
  disabled: boolean
  scheduling: boolean
  local?: boolean
  onSelect(view: string): void
}) {
  const { t } = useTranslation('common')
  const source = role.collaboration
  const projectConfigured = source.allProjects || source.projects.length > 0
  const connections = role.connections ?? []
  const providerIds = [
    ...new Set([...providers.map(item => item.id), ...connections.map(row => row.providerId)]),
  ]
  const projectSummary = source.allProjects ? (
    <span data-testid="stand-in-connection-all-projects">
      {t('standIn.workspace.all_projects_with_exclusions', {
        count: source.excludedProjects.length,
      })}
    </span>
  ) : (
    source.projects.map((ref, index) => (
      <span key={`${ref.store}-${ref.id}`}>
        {index > 0 && ' · '}
        <span data-testid={`stand-in-connection-project-${ref.store}-${ref.id}`}>
          {findStandInProject(projects, ref)?.name ?? ref.id}
        </span>
      </span>
    ))
  )
  const rows = [
    {
      id: 'projects',
      testId: 'stand-in-add-projects-connection',
      icon: Folder,
      name: t('standIn.personal.collaboration'),
      configured: projectConfigured,
      summary: projectConfigured ? projectSummary : t('standIn.workspace.project_connection_help'),
      summaryLabel: source.allProjects
        ? t('standIn.workspace.all_projects_with_exclusions', {
            count: source.excludedProjects.length,
          })
        : source.projects.map(ref => findStandInProject(projects, ref)?.name ?? ref.id).join(' · '),
      status: t(
        !projectConfigured
          ? 'standIn.workspace.connection_not_configured'
          : !source.enabled
            ? 'standIn.workspace.connection_receiving_paused'
            : 'standIn.workspace.connection_configured'
      ),
      action: t(
        projectConfigured
          ? 'standIn.workspace.connection_manage'
          : 'standIn.workspace.connection_choose_scope'
      ),
    },
    ...providerIds.map(id => {
      const provider = providers.find(item => item.id === id)
      const selected = connections.filter(row => row.providerId === id)
      const configured = selected.length > 0
      const prefix = id === DINGTALK_PROVIDER ? 'dingtalk' : id
      const availability = provider?.availability.status
      const ready = availability === 'ready'
      const status = loading
        ? t('standIn.loading')
        : availability === 'auth_required'
          ? t('standIn.workspace.connection_needs_auth')
          : ready
            ? t(
                configured
                  ? 'standIn.workspace.connection_configured'
                  : 'standIn.workspace.connection_not_configured'
              )
            : provider?.availability.code
              ? getStandInErrorMessage({ code: provider.availability.code })
              : t('standIn.workspace.connection_status_' + availability, {
                  defaultValue: t('standIn.workspace.connection_unavailable'),
                })
      return {
        id,
        testId: `stand-in-add-${prefix}-connection`,
        icon: id === EMAIL_PROVIDER ? Mail : MessageSquare,
        name: provider?.displayName ?? t('standIn.workspace.connection_unknown_source'),
        configured,
        summary: configured
          ? selected.map((row, index) => (
              <span key={JSON.stringify([row.profile, row.kind, row.id])}>
                {index > 0 && ' · '}
                <span
                  data-testid={`stand-in-connection-${prefix}-${row.profile}-${row.kind}-${row.id}`}
                >
                  {row.name}
                </span>
              </span>
            ))
          : t('standIn.workspace.connection_select_help'),
        status,
        summaryLabel: selected.map(row => row.name).join(' · '),
        action: t(
          availability === 'dependency_missing'
            ? 'standIn.workspace.install_dependencies'
            : availability === 'auth_required'
              ? local
                ? 'standIn.workspace.connection_authorize'
                : 'standIn.workspace.connection_authorize_on_device'
              : ready
                ? configured
                  ? 'standIn.workspace.connection_manage'
                  : 'standIn.workspace.connection_choose_scope'
                : 'standIn.workspace.connection_view_details'
        ),
      }
    }),
  ]
  return (
    <div className="space-y-5" data-testid="stand-in-connection-type-picker">
      {[true, false].map(configured => {
        const group = rows.filter(row => row.configured === configured)
        if (!group.length) return null
        return (
          <section
            key={String(configured)}
            className="space-y-1"
            data-testid={configured ? 'stand-in-connected-list' : 'stand-in-available-list'}
          >
            <h4 className="px-2 text-xs font-medium text-text-muted">
              {t(
                configured
                  ? 'standIn.workspace.connection_configured_sources'
                  : 'standIn.workspace.connection_available_sources'
              )}
            </h4>
            {group.map(row => (
              <ConnectionRow
                key={row.id}
                {...row}
                disabled={disabled}
                onSelect={() => onSelect(row.id)}
              />
            ))}
          </section>
        )
      })}
      {scheduling && (
        <section className="space-y-1">
          <h4 className="px-2 text-xs font-medium text-text-muted">
            {t('standIn.workspace.connection_scheduled_work')}
          </h4>
          <ConnectionRow
            testId="stand-in-time-connections"
            icon={Clock}
            name={t('standIn.workspace.time_connection')}
            summary={t('standIn.workspace.calendar_help')}
            action={t('standIn.workspace.connection_manage_schedule')}
            disabled={disabled}
            onSelect={() => onSelect('time')}
          />
        </section>
      )}
    </div>
  )
}

function ConnectionRow({
  testId,
  icon: Icon,
  name,
  summary,
  summaryLabel,
  status,
  action,
  disabled,
  onSelect,
}: {
  testId: string
  icon: LucideIcon
  name: string
  summary: ReactNode
  summaryLabel?: string
  status?: string
  action: string
  disabled: boolean
  onSelect(): void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onSelect}
      className="flex min-h-11 w-full flex-wrap items-center gap-3 rounded-md px-2 py-3 text-left hover:bg-muted disabled:opacity-40"
    >
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{name}</span>
        <span
          className="mt-1 line-clamp-2 break-words text-xs text-text-muted"
          title={summaryLabel || undefined}
        >
          {summary}
        </span>
        {status && (
          <span className="mt-1 block text-xs text-text-secondary" data-testid={`${testId}-status`}>
            {status}
          </span>
        )}
      </span>
      <span className="flex items-center gap-1 text-xs text-text-secondary">
        {action}
        <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0" />
      </span>
    </button>
  )
}
