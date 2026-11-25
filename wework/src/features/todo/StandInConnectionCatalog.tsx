import {
  STAND_IN_DINGTALK_PROVIDER,
  type StandInDingTalkDelegation,
  type StandInRole,
} from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor } from '@/api/standIn'
import {
  isDingTalkDelegationSource,
  matchesDingTalkAccount,
} from '@/features/collaboration-exp/stand-in/dingtalkDelegation'
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
import { findStandInProject } from './standInProjects'

export function StandInConnectionCatalog({
  role,
  projects,
  providers,
  loading,
  disabled,
  scheduling,
  projectScopeConfigured = true,
  onSelect,
  dingTalkDelegation,
}: {
  role: StandInRole
  projects: CollaborationProject[]
  providers: ConnectionProviderDescriptor[]
  loading: boolean
  disabled: boolean
  scheduling: boolean
  projectScopeConfigured?: boolean
  onSelect(view: string): void
  dingTalkDelegation?: StandInDingTalkDelegation
}) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const [configuredOnly, setConfiguredOnly] = useState(false)
  const source = role.collaboration
  const participates = source.includeParticipatingIssues === true
  const projectConfigured =
    projectScopeConfigured && (participates || source.allProjects || source.projects.length > 0)
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
      summary: projectConfigured ? (
        <>
          {participates && (
            <span>
              {t('standIn.workspace.receive_participating_issues')}
              {(source.allProjects || source.projects.length > 0) && ' · '}
            </span>
          )}
          {projectSummary}
        </>
      ) : (
        t('standIn.workspace.project_connection_help')
      ),
      summaryLabel: [
        participates && t('standIn.workspace.receive_participating_issues'),
        ...(source.allProjects
          ? [
              t('standIn.workspace.all_projects_with_exclusions', {
                count: source.excludedProjects.length,
              }),
            ]
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
      const primaryDingTalk = isDingTalk && role.id === '@primary'
      const prefix = isDingTalk ? 'dingtalk' : id
      const availability = provider?.availability.status
      const ready = availability === 'ready'
      const activeDelegation =
        dingTalkDelegation?.authorized === true &&
        !dingTalkDelegation.paused &&
        !dingTalkDelegation.accountInvalidated &&
        (Boolean(dingTalkDelegation.organizationId) ||
          matchesDingTalkAccount(provider?.availability, dingTalkDelegation)) &&
        selected.some(row => row.delegated && !row.paused)
      const status = loading
        ? t('standIn.loading')
        : availability === 'auth_required'
          ? t('standIn.workspace.connection_needs_auth')
          : ready
            ? t(
                !configured
                  ? 'standIn.workspace.connection_not_configured'
                  : primaryDingTalk && !activeDelegation
                    ? 'standIn.workspace.connection_receiving_paused'
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
        active: configured && ready && !loading && (!primaryDingTalk || activeDelegation),
        quietStatus: ready && !loading && (!primaryDingTalk || activeDelegation),
        summary: configured ? (
          <>
            {selected.map((row, index) => (
              <span key={JSON.stringify([row.profile, row.kind, row.id])}>
                {index > 0 && ' · '}
                <span
                  data-testid={`stand-in-connection-${prefix}-${row.profile}-${row.kind}-${row.id}`}
                >
                  {row.name}
                  {primaryDingTalk ? (
                    isDingTalkDelegationSource(row) && row.kind === 'group' ? (
                      <> · {t('standIn.dingtalk_delegation.group_mentions')}</>
                    ) : null
                  ) : (
                    row.configurationSummary && <> · {row.configurationSummary}</>
                  )}
                </span>
              </span>
            ))}
            {!primaryDingTalk && selected.every(row => !row.configurationSummary) && (
              <> · {t('standIn.workspace.connection_default_configuration')}</>
            )}
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
        summaryLabel: selected
          .map(row => [row.name, row.configurationSummary].filter(Boolean).join(' · '))
          .join(' · '),
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
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="text-sm text-text-secondary">
            {t('standIn.workspace.connection_catalog_help')}
          </p>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="stand-in-connection-configured-filter"
            aria-pressed={configuredOnly}
            onClick={() => setConfiguredOnly(value => !value)}
            className="flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted"
          >
            {configuredOnly
              ? t('standIn.workspace.connection_show_all')
              : t('standIn.workspace.connection_configured_count', {
                  count: rows.filter(row => row.configured).length,
                })}
          </ControlButton>
        </div>
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
            <ul className="divide-y divide-border">
              {group.map(row => (
                <li key={row.id}>
                  <ConnectionRow {...row} disabled={disabled} onSelect={() => onSelect(row.id)} />
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
        <span
          className="mt-0.5 line-clamp-2 break-words text-sm text-text-secondary"
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
      {active && <Check aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />}
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-text-secondary" />
    </ControlButton>
  )
}
