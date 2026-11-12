import { useEffect, useMemo, useState } from 'react'
import {
  normalizeProjectAgent,
  type CollaborationGroup,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { ChatGroupMember } from '@/api/chatGroups'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

type Source = { kind: 'group' | 'project'; id: string; name?: string }
type Result = {
  source: Source
  agents: Array<{ id: string; name: string }>
  crews: CollaborationGroup[]
  failed: boolean
}

export function ThreadAssigneeField({
  api,
  crews,
  groupCrews,
  canExecute,
  executionHint,
  groupId,
  project,
  members,
  value,
  sourceId,
  assignedName,
  disabled,
  onChange,
}: {
  api: SharedWorkspaceApi['agents']
  crews: SharedWorkspaceApi['projects']
  groupCrews: SharedWorkspaceApi['projects']
  canExecute: boolean
  executionHint?: string
  groupId: string
  project: { id: string; name: string } | null
  members: ChatGroupMember[]
  value: string
  sourceId?: string | null
  assignedName?: string | null
  disabled: boolean
  onChange(value: string, sourceId?: string | null): void
}) {
  const { t } = useTranslation('collaboration')
  const [revision, setRevision] = useState(0)
  const scope = useMemo(
    () => ({
      api,
      crews,
      groupCrews,
      groupId,
      projectId: project?.id,
      projectName: project?.name,
      revision,
    }),
    [api, crews, groupCrews, groupId, project?.id, project?.name, revision]
  )
  const [loaded, setLoaded] = useState<{ scope: typeof scope; results: Result[] } | null>(null)
  useEffect(() => {
    let active = true
    const sources: Source[] = [{ kind: 'group', id: scope.groupId }]
    if (scope.projectId)
      sources.push({ kind: 'project', id: scope.projectId, name: scope.projectName })
    const results: Result[] = []
    for (const source of sources) {
      const crewApi = source.kind === 'group' ? scope.groupCrews : scope.crews
      void Promise.allSettled([
        scope.api.list(source.id),
        crewApi.listCollaborationGroups
          ? crewApi.listCollaborationGroups(source.id)
          : Promise.reject(new Error('Collaboration group catalog is unavailable')),
      ]).then(([agentResult, crewResult]) =>
        finish({
          source,
          agents:
            agentResult.status === 'fulfilled'
              ? agentResult.value
                  .filter(agent => !agent.status || agent.status === 'active')
                  .map(normalizeProjectAgent)
                  .filter(agent => agent.canUse)
                  .map(agent => ({ id: agent.id, name: agent.displayName }))
              : [],
          crews: crewResult.status === 'fulfilled' ? crewResult.value : [],
          failed: agentResult.status === 'rejected' || crewResult.status === 'rejected',
        })
      )
    }
    function finish(result: Result) {
      if (!active) return
      results.push(result)
      setLoaded({ scope, results: [...results] })
    }
    return () => {
      active = false
    }
  }, [scope])
  const results = loaded?.scope === scope ? loaded.results : []
  const pending = results.length < (project ? 2 : 1)
  const failed = results.some(result => result.failed)
  const available = results.flatMap(result => result.agents)
  const assignableMembers = members.filter(member => member.role !== 'Viewer')
  const selectedValue =
    value.startsWith('group:') && sourceId
      ? `crew:${JSON.stringify([sourceId, value.slice(6)])}`
      : value
  const availableCrew =
    value.startsWith('group:') &&
    results.some(
      result =>
        result.source.id === sourceId && result.crews.some(crew => value === `group:${crew.id}`)
    )
  const unavailableSelection =
    Boolean(value) &&
    !availableCrew &&
    !available.some(agent => value === `agent:${agent.id}`) &&
    !assignableMembers.some(member => value === `user:${member.user_id}`)
  return (
    <div className="space-y-2 text-sm text-text-primary">
      <label className="block space-y-2">
        <span>{t('assignee')}</span>
        <select
          data-testid="thread-settings-assignee"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-text-primary focus-visible:ring-2 focus-visible:ring-focus"
          disabled={disabled}
          value={selectedValue}
          onChange={event => {
            if (disabled || (!canExecute && /^(agent:|crew:)/.test(event.target.value))) return
            const next = event.target.value
            if (next.startsWith('crew:')) {
              const [source, id] = JSON.parse(next.slice(5)) as [string, string]
              onChange(`group:${id}`, source)
            } else onChange(next)
          }}
        >
          <option value="">{t('unassigned')}</option>
          {assignableMembers.map(member => (
            <option key={member.user_id} value={`user:${member.user_id}`}>
              {member.user_id === 0 ? t('you') : member.name}
            </option>
          ))}
          {(['group', 'project'] as const).map(kind =>
            results
              .filter(
                result =>
                  result.source.kind === kind &&
                  (result.agents.length > 0 || result.crews.length > 0)
              )
              .map(result => (
                <optgroup
                  key={`${kind}:${result.source.id}`}
                  label={
                    kind === 'group'
                      ? t('groupAgents')
                      : t('projectAgents', { name: result.source.name })
                  }
                >
                  {result.agents.map(agent => (
                    <option key={agent.id} value={`agent:${agent.id}`} disabled={!canExecute}>
                      {agent.name}
                    </option>
                  ))}
                  {result.crews.map(crew => (
                    <option
                      key={`crew:${crew.id}`}
                      value={`crew:${JSON.stringify([result.source.id, crew.id])}`}
                      disabled={!canExecute}
                    >
                      {t('crewAssignee', { name: crew.name })}
                    </option>
                  ))}
                </optgroup>
              ))
          )}
          {unavailableSelection && (
            <option value={selectedValue} disabled>
              {assignedName ?? t('unavailableAssignee')}
            </option>
          )}
        </select>
      </label>
      {!disabled && !canExecute && executionHint && (
        <p className="text-xs text-text-muted" data-testid="thread-assignee-execution-hint">
          {executionHint}
        </p>
      )}
      {pending && (
        <p role="status" className="text-xs text-text-muted">
          {t('loadingAgents')}
        </p>
      )}
      {failed && (
        <div className="flex items-center gap-2 text-xs">
          <p role="alert">{t('agentLoadFailed')}</p>
          <Button
            type="button"
            variant="ghost"
            data-testid="thread-assignees-retry"
            onClick={() => setRevision(value => value + 1)}
          >
            {t('retry')}
          </Button>
        </div>
      )}
    </div>
  )
}
