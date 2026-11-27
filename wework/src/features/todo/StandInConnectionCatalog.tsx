import { STAND_IN_DINGTALK_PROVIDER, type StandInRole } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { CollaborationProject } from '@wegent/collaboration'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import {
  Check,
  ChevronRight,
  Clock,
  Folder,
  GitBranch,
  Mail,
  MessageSquare,
  Search,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { EMAIL_PROVIDER } from './StandInEmailConnections'
import { GIT_CONNECTION_PREFIX } from './StandInGitConnections'
import { hasAllDingTalkMessages } from './sourceConnectionsModel'
import { hasConnectionDraft } from './standInConnectionSettingsModel'
import {
  effectiveProjectSource,
  findStandInProject,
  hasAllCollaborationSources,
} from './standInProjects'

export function StandInConnectionCatalog({
  role,
  savedConfiguration,
  projects,
  providers,
  loading,
  disabled,
  scheduling,
  projectScopeConfigured = true,
  onSelect,
}: {
  role: StandInRole
  savedConfiguration?: Pick<StandInRole, 'connections' | 'collaboration'>
  projects: CollaborationProject[]
  providers: ConnectionProviderDescriptor[]
  loading: boolean
  disabled: boolean
  scheduling: boolean
  projectScopeConfigured?: boolean
  onSelect(view: string): void
}) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const source = effectiveProjectSource(role.collaboration)
  const fullCollaborationScope = hasAllCollaborationSources(source)
  const issueScopes = fullCollaborationScope
    ? ''
    : [
        source.includeParticipatingIssues && t('standIn.workspace.receive_participating_issues'),
        source.includeIndependentIssues && t('standIn.workspace.receive_independent_issues'),
      ]
        .filter(Boolean)
        .join(' · ')
  const projectConfigured = Boolean(
    projectScopeConfigured && (issueScopes || source.allProjects || source.projects.length)
  )
  const connections = role.connections ?? []
  const savedConnections = savedConfiguration?.connections ?? []
  const providerIds = [
    ...new Set([
      ...providers.map(item => item.id),
      ...connections.map(row => row.providerId),
      ...savedConnections.map(row => row.providerId),
    ]),
  ]
  const allProjectsLabel = source.excludedProjects.length
    ? t('standIn.workspace.all_projects_with_exclusions', { count: source.excludedProjects.length })
    : t(
        fullCollaborationScope
          ? 'standIn.workspace.project_scope_all'
          : 'standIn.workspace.project_only_all'
      )
  const projectSummary = source.allProjects ? (
    <span data-testid="stand-in-connection-all-projects">{allProjectsLabel}</span>
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
      pending: hasConnectionDraft(role, savedConfiguration, 'projects'),
      active: projectConfigured && source.enabled,
      quietStatus: !projectConfigured || source.enabled,
      summary: projectConfigured ? (
        <>
          {issueScopes && (
            <span>
              {issueScopes}
              {(source.allProjects || source.projects.length > 0) && ' · '}
            </span>
          )}
          {projectSummary}
        </>
      ) : (
        t('standIn.workspace.project_connection_help')
      ),
      summaryLabel: [
        issueScopes,
        ...(source.allProjects
          ? [allProjectsLabel]
          : source.projects.map(ref => findStandInProject(projects, ref)?.name ?? ref.id)),
      ]
        .filter(Boolean)
        .join(' · '),
      status: t(
        !projectConfigured
          ? 'standIn.workspace.connection_not_configured'
          : !source.enabled
            ? 'standIn.workspace.connection_receiving_paused'
            : 'standIn.workspace.connection_configured'
      ),
    },
    ...providerIds.map(id => {
      const provider = providers.find(item => item.id === id)
      const selected = connections.filter(row => row.providerId === id)
      const configured = selected.length > 0
      const isDingTalk = id === STAND_IN_DINGTALK_PROVIDER
      const completeProfiles = new Set<string>()
      if (isDingTalk) {
        const accounts = new Map<string, typeof selected>()
        for (const row of selected) {
          const account = accounts.get(row.profile)
          if (account) account.push(row)
          else accounts.set(row.profile, [row])
        }
        for (const [profile, account] of accounts) {
          if (hasAllDingTalkMessages(account)) completeProfiles.add(profile)
        }
      }
      const summarySources = selected.flatMap(row => {
        if (!completeProfiles.has(row.profile) || row.scope !== 'all') return [row]
        if (row.kind === 'direct') return []
        return row.kind === 'group'
          ? [
              {
                ...row,
                name: t('standIn.workspace.dingtalk_every_message'),
                configurationSummary: undefined,
              },
            ]
          : [row]
      })
      const prefix = isDingTalk ? 'dingtalk' : id
      const availability = provider?.availability.status
      const ready = availability === 'ready'
      const status = loading
        ? t('standIn.loading')
        : availability === 'auth_required'
          ? t('standIn.workspace.connection_needs_auth')
          : ready
            ? t(
                !configured
                  ? 'standIn.workspace.connection_not_configured'
                  : 'standIn.workspace.connection_configured'
              )
            : provider?.availability.code
              ? getStandInErrorMessage({ code: provider.availability.code })
              : t('standIn.workspace.connection_status_' + availability, {
                  defaultValue: t('standIn.workspace.connection_unavailable'),
                })
      return {
        id,
        testId: `stand-in-add-${prefix}-connection`,
        icon:
          id === EMAIL_PROVIDER
            ? Mail
            : id.startsWith(GIT_CONNECTION_PREFIX)
              ? GitBranch
              : MessageSquare,
        name:
          provider?.displayName ??
          t(
            isDingTalk
              ? 'standIn.dingtalk_delegation.provider'
              : 'standIn.workspace.connection_unknown_source'
          ),
        configured,
        pending: hasConnectionDraft(role, savedConfiguration, id),
        active: configured && ready && !loading,
        quietStatus: ready && !loading,
        summary: configured ? (
          <>
            {summarySources.map((row, index) => (
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
          </>
        ) : (
          t(
            isDingTalk
              ? 'standIn.workspace.message_connection_help'
              : id === EMAIL_PROVIDER
                ? 'standIn.workspace.connection_email_help'
                : 'standIn.workspace.connection_select_help'
          )
        ),
        status,
        summaryLabel: summarySources
          .map(row => [row.name, row.configurationSummary].filter(Boolean).join(' · '))
          .join(' · '),
      }
    }),
  ]
  const search = query.trim().toLocaleLowerCase()
  const matches = (name: string, summary = '') =>
    `${name} ${summary}`.toLocaleLowerCase().includes(search)
  const visibleRows = rows.filter(row => matches(row.name, row.summaryLabel))
  const groups = [
    {
      id: 'stand-in-pending-list',
      title: 'standIn.workspace.connection_pending_sources',
      rows: visibleRows.filter(row => row.pending),
    },
    {
      id: 'stand-in-connected-list',
      title: 'standIn.workspace.connection_configured_sources',
      rows: visibleRows.filter(row => !row.pending && row.configured),
    },
    {
      id: 'stand-in-available-list',
      title: rows.some(row => row.configured || row.pending)
        ? 'standIn.workspace.connection_available_sources'
        : null,
      rows: visibleRows.filter(row => !row.pending && !row.configured),
    },
  ]
  const showSchedule = scheduling && matches(t('standIn.workspace.time_connection'))
  const showSearch = rows.length > 4 || Boolean(query)
  return (
    <div className="space-y-3" data-testid="stand-in-connection-type-picker">
      {showSearch && (
        <div className="space-y-3">
          <label className="flex min-h-11 items-center gap-2 rounded-xl bg-muted px-3 text-text-secondary">
            <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
            <ControlInput
              appearance="plain"
              type="search"
              data-testid="stand-in-connection-search"
              aria-label={t('standIn.workspace.connection_search')}
              placeholder={t('standIn.workspace.connection_search')}
              value={query}
              onChange={event => setQuery(event.target.value)}
              className="min-w-0 flex-1 appearance-none text-base placeholder:text-text-secondary"
            />
          </label>
        </div>
      )}
      {groups.map(({ id, title, rows }) => {
        if (!rows.length) return null
        return (
          <section key={id} className="space-y-2" data-testid={id}>
            {title && <h4 className="px-2 text-sm font-medium">{t(title)}</h4>}
            <ul className="divide-y divide-border">
              {rows.map(row => (
                <li key={row.id}>
                  <ConnectionRow
                    {...row}
                    active={row.active && !row.pending}
                    status={
                      row.pending
                        ? row.configured
                          ? undefined
                          : t('standIn.workspace.scope_off')
                        : row.status
                    }
                    quietStatus={!row.pending && row.quietStatus}
                    summary={row.configured ? row.summary : undefined}
                    disabled={disabled}
                    onSelect={() => onSelect(row.id)}
                  />
                </li>
              ))}
            </ul>
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
            disabled={disabled}
            onSelect={() => onSelect('time')}
          />
        </section>
      )}
      {!visibleRows.length && !showSchedule && (
        <p role="status" className="py-8 text-center text-sm text-text-secondary">
          {t('standIn.workspace.connection_search_empty')}
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
  active = false,
  quietStatus = false,
  disabled,
  onSelect,
}: {
  testId: string
  icon: LucideIcon
  name: string
  summary?: ReactNode
  summaryLabel?: string
  status?: string
  active?: boolean
  quietStatus?: boolean
  disabled: boolean
  onSelect(): void
}) {
  return (
    <ControlButton
      variant="unstyled"
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onSelect}
      className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-muted/60 disabled:opacity-40"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-text-secondary">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{name}</span>
        {summary && (
          <span
            className="mt-0.5 line-clamp-2 break-words text-sm text-text-secondary"
            title={summaryLabel || undefined}
          >
            {summary}
          </span>
        )}
        {status && (
          <span
            className={quietStatus ? 'sr-only' : 'mt-1 block text-xs text-text-secondary'}
            data-testid={`${testId}-status`}
          >
            {status}
          </span>
        )}
      </span>
      {active && <Check aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />}
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
    </ControlButton>
  )
}
