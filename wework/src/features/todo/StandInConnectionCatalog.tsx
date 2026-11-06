import {
  Check,
  Clock,
  ChevronRight,
  Folder,
  Mail,
  MessageSquare,
  Search,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
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
  const [query, setQuery] = useState('')
  const [configuredOnly, setConfiguredOnly] = useState(false)
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
      active: projectConfigured && source.enabled,
      quietStatus: !projectConfigured || source.enabled,
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
        active: configured && ready && !loading,
        quietStatus: ready && !loading,
        summary: configured ? (
          <>
            {selected.map((row, index) => (
              <span key={JSON.stringify([row.profile, row.kind, row.id])}>
                {index > 0 && ' · '}
                <span
                  data-testid={`stand-in-connection-${prefix}-${row.profile}-${row.kind}-${row.id}`}
                >
                  {row.name}
                  {row.configurationSummary && <> · {row.configurationSummary}</>}
                </span>
              </span>
            ))}
            {selected.every(row => !row.configurationSummary) && (
              <> · {t('standIn.workspace.connection_default_configuration')}</>
            )}
          </>
        ) : (
          t(
            id === DINGTALK_PROVIDER
              ? 'standIn.workspace.message_connection_help'
              : id === EMAIL_PROVIDER
                ? 'standIn.workspace.connection_email_help'
                : 'standIn.workspace.connection_select_help'
          )
        ),
        status,
        summaryLabel: selected
          .map(row => [row.name, row.configurationSummary].filter(Boolean).join(' · '))
          .join(' · '),
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
  const search = query.trim().toLocaleLowerCase()
  const matches = (name: string, summary = '') =>
    `${name} ${summary}`.toLocaleLowerCase().includes(search)
  const visibleRows = rows.filter(
    row => (!configuredOnly || row.configured) && matches(row.name, row.summaryLabel)
  )
  const showSchedule =
    scheduling && !configuredOnly && matches(t('standIn.workspace.time_connection'))
  return (
    <div className="space-y-6" data-testid="stand-in-connection-type-picker">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-text-muted">
            {t('standIn.workspace.connection_catalog_help')}
          </p>
          <button
            type="button"
            data-testid="stand-in-connection-configured-filter"
            aria-pressed={configuredOnly}
            onClick={() => setConfiguredOnly(value => !value)}
            className="flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {configuredOnly
              ? t('standIn.workspace.connection_show_all')
              : t('standIn.workspace.connection_configured_count', {
                  count: rows.filter(row => row.configured).length,
                })}
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        <label className="flex min-h-11 items-center gap-2 rounded-xl bg-muted px-3 text-text-muted focus-within:ring-2 focus-within:ring-focus">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
          <input
            type="search"
            data-testid="stand-in-connection-search"
            aria-label={t('standIn.workspace.connection_search')}
            placeholder={t('standIn.workspace.connection_search')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="min-w-0 flex-1 appearance-none border-0 bg-transparent py-2 text-base text-text-primary outline-none placeholder:text-text-muted"
          />
        </label>
      </div>
      {[true, false].map(configured => {
        const group = visibleRows.filter(row => row.configured === configured)
        if (!group.length) return null
        return (
          <section
            key={String(configured)}
            className="space-y-2"
            data-testid={configured ? 'stand-in-connected-list' : 'stand-in-available-list'}
          >
            <h4 className="px-2 text-sm font-medium">
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
      {showSchedule && (
        <section className="space-y-2">
          <h4 className="px-2 text-sm font-medium">
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
      {!visibleRows.length && !showSchedule && (
        <p role="status" className="py-8 text-center text-sm text-text-muted">
          {t(
            configuredOnly && !search
              ? 'standIn.workspace.connection_configured_empty'
              : 'standIn.workspace.connection_search_empty'
          )}
        </p>
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
  active = false,
  quietStatus = false,
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
  active?: boolean
  quietStatus?: boolean
  disabled: boolean
  onSelect(): void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onSelect}
      className="group flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-4 text-left hover:bg-muted/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-40"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/50 text-text-primary">
        <Icon aria-hidden="true" className="h-6 w-6" strokeWidth={1.5} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium">{name}</span>
        <span
          className="mt-1 line-clamp-1 break-words text-sm text-text-muted"
          title={summaryLabel || undefined}
        >
          {summary}
        </span>
        {status && (
          <span
            className={quietStatus ? 'sr-only' : 'mt-1 block text-xs text-text-secondary'}
            data-testid={`${testId}-status`}
          >
            {status}
          </span>
        )}
      </span>
      <span className="flex max-w-32 shrink-0 items-center gap-1 rounded-full bg-muted px-3 py-1.5 text-center text-sm text-text-secondary group-hover:bg-background">
        {active && <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-success" />}
        {action}
      </span>
    </button>
  )
}
