import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useStandInOpened } from '@/telemetry/useStandInOpened'
import { useContext, useEffect, useRef, useState, type ComponentProps } from 'react'
import { Brain, MessageSquare, Plus, Settings } from 'lucide-react'
import { createPortal } from 'react-dom'
import { StandInIcon } from '@wegent/collaboration'
import {
  roleIncludesProject,
  standInRoleName,
  subscribePersonalStandIn,
} from '@/api/personalStandIn'
import type { StandInProposal } from '@/api/standIn'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { standInOrigin, standInState } from '@/features/notifications/standInNotifications'
import type { RuntimeTaskAddress } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { usePersonalStandIn } from './usePersonalStandIn'
import { StandInSettingsPage, type StandInSettingsHandle } from './StandInSettingsPage'
import { StandInConversation } from './StandInConversation'
import { StandInWorkList } from './StandInWorkList'
import { standInWorkRole } from './standInWork'
import { StandInMemoryPanel } from './StandInMemoryPanel'
import { StandInPrimaryProfile } from './StandInPrimaryProfile'
import { StandInProposalCard } from './StandInProposalCard'
import { inboxRuntimeItem, useStandInInbox } from './useStandInInbox'

type SettingsProps = ComponentProps<typeof StandInSettingsPage>

export function StandInOverviewPage({
  onOpenTask,
  initialPrimaryProfile = false,
  active = true,
  ...props
}: SettingsProps & {
  onOpenTask?(address: RuntimeTaskAddress): Promise<void> | void
  initialPrimaryProfile?: boolean
  active?: boolean
}) {
  const { t } = useTranslation('common')
  const workbench = useContext(WorkbenchContext)
  const state = usePersonalStandIn(props.services, props.userId, props.initialDeviceId, false)
  const [roleId, setRoleId] = useState<string>()
  const [chatting, setChatting] = useState(false)
  const [profile, setProfile] = useState<'primary' | 'role' | 'create' | 'memory' | null>(
    initialPrimaryProfile ? 'primary' : null
  )
  const [proposal, setProposal] = useState<StandInProposal | null>(null)
  const [proposalError, setProposalError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const panelRef = useRef<StandInSettingsHandle>(null)
  const pressedInPanel = useRef(false)
  const { saved, setDraft, reload } = state
  const deviceId = saved?.executionDeviceId
  const api = props.services.standInApi
  const inbox = useStandInInbox(api, props.userId, deviceId)
  useEffect(
    () =>
      subscribePersonalStandIn(value => {
        if (value.userId === props.userId && value.executionDeviceId === deviceId) {
          setDraft(value)
          reload()
        }
      }),
    [props.userId, deviceId, setDraft, reload]
  )
  useEffect(() => {
    if (!api || !deviceId) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api.proposal(props.userId, deviceId, roleId)
        if (active) {
          setProposal(next)
          setProposalError(null)
        }
      } catch (cause) {
        if (active) setProposalError(getStandInErrorMessage(cause))
      } finally {
        if (active) timer = setTimeout(poll, 3000)
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [api, deviceId, props.userId, roleId])
  const roles = state.draft?.roles ?? []
  const role = roles.find(value => value.id === roleId)
  useStandInOpened(
    profile === 'memory' ? 'memory' : profile === 'primary' ? 'settings' : 'overview',
    roleId ? 'role' : 'primary',
    active && profile !== 'role' && profile !== 'create'
  )
  const title = role
    ? standInRoleName(role, roles.indexOf(role), t('standIn.personal.default_role'))
    : t('standIn.title')
  const merged = new Map(
    (workbench?.runtimeTaskReminders.items ?? []).map(item => {
      const origin = standInOrigin(item)
      const project = props.projects.find(
        project =>
          project.id === origin?.cloudProjectId &&
          (project.project_store === 'local' ? 'local' : 'cloud') ===
            (origin?.projectStore === 'local' ? 'local' : 'cloud')
      )
      return [item.task.taskId, { ...item, projectName: project?.name || item.projectName }]
    })
  )
  const visibleInbox = inbox.items.filter(work => work.messageCount > 0 || work.task)
  if (deviceId)
    for (const work of visibleInbox)
      merged.set(work.taskId, inboxRuntimeItem(work, deviceId, merged.get(work.taskId)))
  const items = [...merged.values()]
    .filter(item => standInWorkRole(item) !== null)
    .sort((a, b) => standInState(b).updatedAt.localeCompare(standInState(a).updatedAt))
  const roleItems = items.filter(item => standInWorkRole(item) === (roleId ?? '@primary'))
  const needsAttention = items.filter(
    item =>
      ['waiting', 'failed'].includes(standInState(item).status) ||
      inbox.items.some(
        work =>
          work.taskId === item.task.taskId && ['needs_grouping', 'failed'].includes(work.status)
      )
  )
  const conversation = roleId ? chatting : !chatting
  const enabled = role ? role.enabled : state.draft?.primary?.enabled !== false
  const chooseRole = (id?: string) => {
    setRoleId(id)
    setChatting(false)
    setProfile(null)
  }
  return (
    <section
      className="relative flex h-full min-h-0 min-w-0 text-base text-text-primary"
      data-testid="stand-in-overview"
    >
      <nav
        aria-label={t('standIn.workspace.navigation')}
        className="flex w-36 shrink-0 flex-col border-r border-border bg-muted/30 p-2 md:w-44"
        data-testid="stand-in-overview-status"
      >
        <button
          type="button"
          data-testid="stand-in-primary-open"
          aria-current={!roleId ? 'page' : undefined}
          onClick={() => chooseRole()}
          className={`flex min-h-9 items-center gap-2 rounded-md px-2 text-left text-sm ${!roleId ? 'bg-muted font-medium' : 'hover:bg-muted'}`}
        >
          <StandInIcon
            enabled={state.draft?.primary?.enabled !== false}
            className="h-5 w-5 shrink-0"
          />
          {t('standIn.title')}
        </button>
        <p className="px-2 pb-2 pt-6 text-xs text-text-muted">{t('standIn.workspace.roles')}</p>
        {roles.map((value, index) => {
          const projects = props.projects.filter(project =>
            roleIncludesProject(value, {
              id: project.id,
              store: project.project_store === 'local' ? 'local' : 'cloud',
            })
          )
          return (
            <button
              key={value.id}
              type="button"
              data-testid={`stand-in-overview-role-${value.id}`}
              aria-current={roleId === value.id ? 'page' : undefined}
              onClick={() => chooseRole(value.id)}
              className={`min-h-9 rounded-md px-2 py-2 text-left text-sm ${roleId === value.id ? 'bg-muted font-medium' : 'hover:bg-muted'}`}
            >
              <span className="flex items-center gap-2">
                <StandInIcon enabled={value.enabled} className="h-4 w-4 shrink-0" />
                <span className="truncate">
                  {standInRoleName(value, index, t('standIn.personal.default_role'))}
                </span>
              </span>
              <span className="sr-only">
                {t(value.enabled ? 'standIn.auto_on' : 'standIn.auto_off')}
                {t('standIn.personal.connected_selected', { count: projects.length })}
              </span>
              <span
                className="mt-1 block truncate pl-6 text-xs text-text-muted"
                title={[
                  ...projects.map(project => project.name),
                  ...(value.connections ?? []).map(source => source.name),
                ].join(' · ')}
              >
                {[
                  ...projects.map(project => project.name),
                  ...(value.connections ?? []).map(source => source.name),
                ].join(' · ') ||
                  t(value.enabled ? 'standIn.workspace.receiving' : 'standIn.workspace.paused')}
              </span>
            </button>
          )
        })}
        <button
          type="button"
          data-testid="stand-in-create-role"
          onClick={() => setProfile('create')}
          className="mt-2 inline-flex min-h-9 items-center gap-2 rounded-md px-2 text-left text-sm text-text-secondary hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
          {t('standIn.workspace.create_role')}
        </button>
      </nav>
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h1 className="heading-md truncate">{title}</h1>
            <p className="mt-1 text-xs text-text-muted">
              {t(enabled ? 'standIn.workspace.receiving' : 'standIn.workspace.paused')}
            </p>
          </div>
          {
            <button
              type="button"
              data-testid="stand-in-role-chat"
              onClick={() => setChatting(value => !value)}
              className="inline-flex min-h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted"
            >
              <MessageSquare className="h-4 w-4" />
              {t(
                conversation
                  ? 'standIn.workspace.work_list'
                  : proposal && (proposal.roleId ?? undefined) === roleId
                    ? 'standIn.workspace.review_pending_changes'
                    : role
                      ? 'standIn.workspace.role_chat'
                      : 'standIn.title'
              )}
            </button>
          }
          {api && saved && (
            <button
              type="button"
              data-testid="stand-in-memory-open"
              onClick={() => setProfile('memory')}
              className="inline-flex min-h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted"
            >
              <Brain className="h-4 w-4" />
              {t('standIn.memory.title')}
            </button>
          )}
          <button
            type="button"
            data-testid="stand-in-settings-open"
            onClick={() => setProfile(role ? 'role' : 'primary')}
            className="inline-flex min-h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted"
          >
            <Settings className="h-4 w-4" />
            {t(role ? 'standIn.workspace.role_profile' : 'standIn.workspace.primary_profile')}
          </button>
        </header>
        {state.loading && !state.saved ? (
          <p role="status" className="p-5 text-text-muted">
            {t('standIn.loading')}
          </p>
        ) : state.error && !state.saved ? (
          <div role="alert" className="p-5 text-error">
            <p>{state.error}</p>
            <button
              type="button"
              data-testid="stand-in-overview-retry"
              onClick={reload}
              className="mt-2 underline"
            >
              {t('standIn.reload')}
            </button>
          </div>
        ) : (
          <>
            {(state.error || proposalError || inbox.error) && (
              <div role="alert" className="flex items-center gap-3 px-5 py-2 text-sm text-error">
                <span className="flex-1">{state.error || proposalError || inbox.error}</span>
                {state.error && (
                  <button
                    type="button"
                    data-testid="stand-in-overview-inline-retry"
                    onClick={reload}
                    className="min-h-11 min-w-11 underline"
                  >
                    {t('standIn.reload')}
                  </button>
                )}
              </div>
            )}
            {inbox.sourceErrors.map(value => (
              <div
                key={`${value.source.profile}:${value.source.kind}:${value.source.id}`}
                role="alert"
                className="flex items-center gap-3 px-5 py-2 text-sm text-error"
              >
                <span className="flex-1">
                  {value.source.name} · {getStandInErrorMessage(value.error)}
                </span>
                <button
                  type="button"
                  data-testid={`stand-in-source-retry-${value.source.id}`}
                  className="min-h-9 underline"
                  onClick={async () => {
                    try {
                      await api?.retrySource(props.userId, deviceId!, value.source)
                      inbox.refresh()
                    } catch (cause) {
                      setProposalError(getStandInErrorMessage(cause))
                    }
                  }}
                >
                  {t('standIn.reload')}
                </button>
              </div>
            ))}
            {!roleId && conversation && !!needsAttention.length && (
              <div className="flex flex-wrap gap-2 px-5 pt-3" data-testid="stand-in-important-work">
                {needsAttention.slice(0, 3).map(item => (
                  <button
                    type="button"
                    key={item.key}
                    data-testid={`stand-in-attention-${item.task.taskId}`}
                    onClick={() => {
                      const owner = standInWorkRole(item)
                      setRoleId(owner === '@primary' ? undefined : (owner ?? undefined))
                      setChatting(owner === '@primary')
                    }}
                    className="min-h-8 rounded-md border border-border px-3 text-sm hover:bg-muted"
                  >
                    {item.task.title} ·{' '}
                    {t(`standIn.personal.activity_${standInState(item).status}`)}
                  </button>
                ))}
              </div>
            )}
            {conversation && api && deviceId ? (
              <StandInConversation
                active={active && conversation}
                key={`${deviceId}:${props.userId}:${roleId ? `role:${roleId}` : 'primary'}`}
                api={api}
                userId={props.userId}
                deviceId={deviceId}
                roleId={roleId}
                pendingConfiguration={
                  proposal && (proposal.roleId ?? undefined) === roleId && state.saved ? (
                    <StandInProposalCard
                      proposal={proposal}
                      projects={props.projects}
                      current={state.saved}
                      busy={resolving}
                      onResolve={async accept => {
                        if (!api || !deviceId) return
                        setResolving(true)
                        try {
                          await api.resolveProposal(props.userId, deviceId, proposal.id, accept)
                          setProposal(null)
                          reload()
                        } catch (cause) {
                          setProposalError(getStandInErrorMessage(cause))
                        } finally {
                          setResolving(false)
                        }
                      }}
                    />
                  ) : null
                }
                onOpenTask={onOpenTask}
              />
            ) : (
              <StandInWorkList
                active={active && !conversation}
                key={roleId ? `role:${roleId}` : 'primary'}
                items={roleItems}
                inbox={visibleInbox.filter(work => work.roleId === (roleId ?? '@primary'))}
                api={api}
                userId={props.userId}
                deviceId={deviceId}
                onRefresh={inbox.refresh}
                onOpenTask={onOpenTask}
              />
            )}
          </>
        )}
        {profile &&
          createPortal(
            <div
              className="fixed inset-0 z-modal bg-black/20 text-text-primary"
              data-testid="stand-in-profile-backdrop"
              onMouseDown={event => {
                pressedInPanel.current = event.target !== event.currentTarget
              }}
              onClick={event => {
                if (event.target === event.currentTarget && !pressedInPanel.current)
                  panelRef.current?.requestClose()
                pressedInPanel.current = false
              }}
            >
              <aside
                role="dialog"
                aria-modal="true"
                aria-label={t(
                  profile === 'memory'
                    ? 'standIn.memory.title'
                    : profile === 'primary'
                      ? 'standIn.workspace.primary_profile'
                      : 'standIn.workspace.role_profile'
                )}
                data-testid="stand-in-profile-panel"
                className="absolute inset-y-0 right-0 z-20 w-full overflow-y-auto border-l border-border bg-background shadow-lg md:max-w-lg"
              >
                {profile === 'memory' && api && saved ? (
                  <StandInMemoryPanel
                    ref={panelRef}
                    key={saved.executionDeviceId}
                    api={api}
                    settings={saved}
                    projects={props.projects.filter(
                      project =>
                        project.project_store !== 'local' ||
                        saved.executionDeviceId === state.currentDeviceId
                    )}
                    onClose={() => setProfile(null)}
                  />
                ) : profile === 'primary' && state.draft ? (
                  <StandInPrimaryProfile
                    ref={panelRef}
                    key={state.draft.executionDeviceId}
                    settings={state.draft}
                    saving={state.saving || state.loading}
                    services={props.services}
                    devices={props.devices}
                    onSelectDevice={state.setDeviceId}
                    onClose={() => {
                      setProfile(null)
                      if (initialPrimaryProfile) props.onCancel?.()
                    }}
                    onSave={async value => {
                      if (await state.save(value)) {
                        setProfile(null)
                        if (initialPrimaryProfile) props.onCancel?.()
                      }
                    }}
                    error={state.error}
                    api={api}
                    localDeviceId={state.currentDeviceId}
                    projects={props.projects}
                  />
                ) : (
                  <StandInSettingsPage
                    {...props}
                    ref={panelRef}
                    initialProfileId={roleId}
                    initialCreate={profile === 'create'}
                    onDeleted={() => {
                      setRoleId(undefined)
                      setChatting(false)
                      reload()
                      setProfile(null)
                    }}
                    onCancel={() => setProfile(null)}
                    onSaved={() => {
                      reload()
                      setProfile(null)
                    }}
                  />
                )}
              </aside>
            </div>,
            document.body
          )}
      </main>
    </section>
  )
}
