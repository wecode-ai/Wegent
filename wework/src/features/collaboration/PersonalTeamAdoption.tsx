import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { createAgentResourceApi } from '@/api/agentResources'
import { useState } from 'react'
import type { ProjectAgentConfigurationHost } from '@wegent/collaboration'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { Button } from '@/components/ui/button'
import type { StandInExecutorApi } from '@/api/standIn'
import type { StandInTeam } from '@/api/personalStandIn'
import type { LocalRuntimeSidebarIdentity } from '@/lib/local-runtime-sidebar-identity'
import { configuredPrimaryStandInDevice } from '@/features/todo/standInAccountInstanceSource'
import { isLocalWorkbenchDeviceAlias } from '@/lib/workbench-device'
import { useTranslation } from '@/hooks/useTranslation'

type HostProps = Parameters<
  NonNullable<ProjectAgentConfigurationHost['renderPersonalTeamAdoption']>
>[0]
type TeamOption = Pick<StandInTeam, 'id' | 'name' | 'members' | 'leadId'> & {
  names: Record<string, string>
  matchedAgents: Record<string, string>
  accountTeamIds: ReadonlyMap<string, number>
  localReferences: Record<string, string | null | undefined>
  devices: Record<string, string>
  version: number
  device: string
}

export function PersonalTeamAdoption({
  userId,
  location,
  api,
  identity,
  accountApi,
  agentApi,
  agents,
  adopt,
}: HostProps & {
  userId: number
  api: Pick<StandInExecutorApi, 'binding' | 'personalGet'>
  accountApi?: Pick<NonNullable<WorkbenchServices['personalAssistantAccountApi']>, 'get'>
  agentApi?: Pick<ReturnType<typeof createAgentResourceApi>, 'getTeamIdentity'>
  identity?(): Promise<LocalRuntimeSidebarIdentity | null>
}) {
  const { t } = useTranslation('common')
  const [teams, setTeams] = useState<TeamOption[] | null>(null)
  const [selected, setSelected] = useState('')
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [matchUnavailable, setMatchUnavailable] = useState(false)
  const team = teams?.find(item => item.id === selected)
  const roster = Object.entries(team?.members ?? {})
  const available = new Set(agents.map(agent => agent.id))
  const assigned = new Set(Object.values(bindings))
  const ready =
    team &&
    roster.length > 0 &&
    roster.every(([id]) => available.has(bindings[id])) &&
    assigned.size === roster.length

  async function open() {
    setBusy(true)
    setError('')
    try {
      const [local, account] = await Promise.all([
        identity?.(),
        location === 'cloud' ? accountApi?.get() : null,
      ])
      const configured = configuredPrimaryStandInDevice(account ?? undefined)
      const binding =
        location === 'cloud' && !configured && local ? await api.binding(local.deviceId) : undefined
      const target =
        configured ?? (binding?.target?.userId === userId ? binding.target.deviceId : undefined)
      const device = target && !isLocalWorkbenchDeviceAlias(target) ? target : local?.deviceId
      if (!device) throw new Error(t('standIn.adoption.unavailable'))
      const profile = await api.personalGet(userId, device, { deviceSettingsOnly: true })
      if (profile.userId !== userId || profile.executionDeviceId !== device)
        throw new Error(t('standIn.adoption.unavailable'))
      const teamIds = [...new Set(agents.flatMap(agent => (agent.team_id ? [agent.team_id] : [])))]
      const resources =
        agentApi && account && profile.teams?.length
          ? await Promise.allSettled(teamIds.map(id => agentApi.getTeamIdentity(id)))
          : []
      setMatchUnavailable(resources.some(row => row.status === 'rejected'))
      const owned = new Map(
        resources.flatMap(result => {
          if (result.status !== 'fulfilled' || result.value.userId !== userId) return []
          const { namespace, name, id } = result.value
          return [[JSON.stringify([namespace, name]), id] as const]
        })
      )
      const candidates = new Map<number, string[]>()
      for (const agent of agents) {
        if (!agent.team_id) continue
        const list = candidates.get(agent.team_id) ?? []
        list.push(agent.id)
        candidates.set(agent.team_id, list)
      }
      const matched = new Map<string, string>()
      const accountTeamIds = new Map<string, number>()
      for (const definition of account?.definitions ?? []) {
        const { namespace, name } = definition.team.metadata
        const id = owned.get(JSON.stringify([namespace, name]))
        if (id) accountTeamIds.set(definition.roleId, id)
        const options = id && candidates.get(id)
        if (options && options.length === 1) matched.set(definition.roleId, options[0])
      }
      const roles = new Map(profile.roles.map(role => [role.id, role]))
      const roleReferences = new Map<string, string | null | undefined>([
        ['@primary', profile.primary?.teamRef],
        ...profile.roles.map(role => [role.id, role.teamRef] as const),
      ])
      setTeams(
        (profile.teams ?? []).map(({ id, name, members, leadId, memberRoutes }) => ({
          id,
          name,
          members,
          leadId,
          device,
          version: profile.version,
          accountTeamIds,
          localReferences: Object.fromEntries(
            Object.keys(members).map(role => [
              role,
              !memberRoutes?.[role] &&
              (roles.get(role)?.executionDeviceId === device ||
                !roles.get(role)?.executionDeviceId ||
                roleReferences.get(role)?.startsWith('LA-'))
                ? roleReferences.get(role)
                : undefined,
            ])
          ),
          matchedAgents: Object.fromEntries(
            Object.keys(members).flatMap(role => {
              const reference = roleReferences.get(role)
              if (location === 'local')
                return !memberRoutes?.[role] &&
                  reference?.startsWith('LA-') &&
                  available.has(reference)
                  ? [[role, reference]]
                  : []
              const candidate = matched.get(role)
              return candidate && !reference?.startsWith('LA-') && !memberRoutes?.[role]
                ? [[role, candidate]]
                : []
            })
          ),
          devices: Object.fromEntries(
            Object.keys(members).map(role => [
              role,
              memberRoutes?.[role]?.executionDeviceId ?? device,
            ])
          ),
          names: Object.fromEntries(
            Object.keys(members).map(role => [
              role,
              role === '@primary'
                ? t('standIn.personal.default_role')
                : memberRoutes?.[role]?.name || roles.get(role)?.name || role,
            ])
          ),
        }))
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    if (!ready) return
    setBusy(true)
    setError('')
    try {
      const source = await api.personalGet(userId, team.device, { deviceSettingsOnly: true })
      if (source.userId !== userId || source.version !== team.version)
        throw new Error(t('standIn.adoption.changed'))
      const definition = {
        id: team.id,
        name: team.name,
        leadId: team.leadId,
        members: team.members,
      }
      if (location === 'local') {
        await adopt({
          definition,
          sourceOwnerId: source.userId,
          memberAgentIds: bindings,
          memberTeamDefinitions: {},
        })
        setTeams(null)
        setSelected('')
        return
      }
      const sourceTeamIds: Record<string, number> = {}
      const definitions = await Promise.all(
        roster.map(async ([role]) => {
          const roleDevice = team.devices[role]
          const accountTeamId = team.accountTeamIds.get(role)
          const projectTeamId = agents.find(agent => agent.id === bindings[role])?.team_id
          if (role !== '@primary' && accountTeamId && accountTeamId === projectTeamId) {
            const profile =
              roleDevice === team.device
                ? source
                : await api.personalGet(userId, roleDevice, { deviceSettingsOnly: true })
            if (profile.userId !== userId || profile.executionDeviceId !== roleDevice)
              throw new Error(t('standIn.adoption.unavailable'))
            if (!profile.roles.some(identity => identity.id === role)) {
              sourceTeamIds[role] = accountTeamId
              return []
            }
          }
          const exported = await api.personalGet(userId, team.devices[role], {
            exportTeamRoleId: role,
          })
          if (
            exported.userId !== userId ||
            exported.executionDeviceId !== team.devices[role] ||
            !exported.portableTeam ||
            (team.devices[role] === team.device && exported.version !== team.version)
          ) {
            throw new Error(t('standIn.adoption.exportFailed', { name: team.names[role] }))
          }
          return [[role, exported.portableTeam] as const]
        })
      )
      await adopt({
        definition: { id: team.id, name: team.name, leadId: team.leadId, members: team.members },
        memberTeamDefinitions: Object.fromEntries(definitions.flat()),
        ...(Object.keys(sourceTeamIds).length ? { memberSourceTeamIds: sourceTeamIds } : {}),
        memberAgentIds: Object.fromEntries(roster.map(([id]) => [id, bindings[id]])),
      })
      setTeams(null)
      setSelected('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-2">
      {error && <p role="alert">{error}</p>}
      {teams === null ? (
        <Button
          variant="outline"
          disabled={busy}
          data-testid="project-personal-team-open"
          onClick={() => void open()}
        >
          {t('standIn.adoption.open')}
        </Button>
      ) : (
        <>
          {teams.length ? (
            <SelectField
              value={selected}
              options={teams.map(item => ({ value: item.id, label: item.name }))}
              testId="project-personal-team-select"
              accessibleLabel={t('standIn.adoption.select')}
              placeholder={t('standIn.adoption.select')}
              disabled={busy}
              onChange={id => {
                setSelected(id)
                setBindings(teams.find(item => item.id === id)?.matchedAgents ?? {})
                setError('')
              }}
            />
          ) : (
            <p>{t('standIn.adoption.empty')}</p>
          )}
          {team && (
            <p>
              {t(
                location === 'local' ? 'standIn.adoption.localHelp' : 'standIn.adoption.bindingHelp'
              )}
            </p>
          )}
          {team && matchUnavailable && (
            <p role="status">{t('standIn.adoption.matchUnavailable')}</p>
          )}
          {roster.map(([role, duty]) => (
            <label key={role} className="grid gap-1">
              {team?.names[role]} {role === team?.leadId && t('standIn.teams.lead')} {duty}
              {location === 'local' &&
                team &&
                (!team.localReferences[role] ||
                  (team.localReferences[role]?.startsWith('LA-') &&
                    !available.has(team.localReferences[role]!))) && (
                  <span>
                    {t(
                      team.localReferences[role]
                        ? 'standIn.adoption.localGrant'
                        : 'standIn.adoption.localSource',
                      { reference: team.localReferences[role] ?? '' }
                    )}
                  </span>
                )}
              <SelectField
                value={bindings[role] ?? ''}
                testId={`project-personal-team-member-${role}`}
                accessibleLabel={team?.names[role] ?? role}
                placeholder={t('standIn.adoption.agent')}
                disabled={busy}
                options={agents
                  .filter(agent => {
                    if (location !== 'local') return true
                    const reference = team?.localReferences[role]
                    return (
                      !!reference &&
                      team?.devices[role] === team?.device &&
                      (!reference.startsWith('LA-') || agent.id === reference)
                    )
                  })
                  .map(agent => ({
                    value: agent.id,
                    label: agent.name + ' (' + agent.id + ')',
                    disabled: assigned.has(agent.id) && bindings[role] !== agent.id,
                  }))}
                onChange={id => setBindings(previous => ({ ...previous, [role]: id }))}
              />
            </label>
          ))}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy}
              data-testid="project-personal-team-cancel"
              onClick={() => {
                setTeams(null)
                setSelected('')
                setError('')
              }}
            >
              {t('standIn.teams.cancel')}
            </Button>
            {team && (
              <Button
                disabled={busy || !ready}
                data-testid="project-personal-team-adopt"
                onClick={() => void save()}
              >
                {t('standIn.adoption.open')}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
