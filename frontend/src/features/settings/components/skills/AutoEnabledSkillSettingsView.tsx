// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import type { SkillBinding, SkillBindingException, UnifiedSkill } from '@/apis/skills'
import { updateMyDefaultSkillBindingExceptions } from '@/apis/skills'
import { fetchTeamsList } from '@/features/settings/services/teams'
import type { Team, TaskType } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ArrowLeft, Globe, Settings2 } from 'lucide-react'
import { toast } from 'sonner'

const MODE_OPTIONS: Array<{ value: TaskType; key: string }> = [
  { value: 'chat', key: 'chat' },
  { value: 'code', key: 'code' },
  { value: 'knowledge', key: 'knowledge' },
  { value: 'task', key: 'task' },
  { value: 'video', key: 'video' },
  { value: 'image', key: 'image' },
]

type AgentGroupKey = 'personal' | 'group' | 'system'

const AGENT_GROUP_ORDER: AgentGroupKey[] = ['personal', 'group', 'system']

interface AutoEnabledSkillSettingsViewProps {
  skills: UnifiedSkill[]
  bindings: SkillBinding[]
  currentUserId?: number | null
  onBack: () => void
  onBindingChange: (binding: SkillBinding) => void
  getSkillSourceLabel: (skill: UnifiedSkill) => string
  isGroupSkill: (skill: UnifiedSkill) => boolean
}

function getExceptionsForSkill(bindings: SkillBinding[], skillId: number): SkillBindingException[] {
  return getBindingForSkill(bindings, skillId)?.exceptions || []
}

function getBindingForSkill(bindings: SkillBinding[], skillId: number): SkillBinding | undefined {
  return bindings.find(binding => binding.skill_ref.skill_id === skillId)
}

function isForcePreloadEnabled(bindings: SkillBinding[], skillId: number): boolean {
  return Boolean(getBindingForSkill(bindings, skillId)?.force_preload)
}

function hasException(
  exceptions: SkillBindingException[],
  type: SkillBindingException['type'],
  value: string
) {
  return exceptions.some(item => item.type === type && item.value === value)
}

function addException(
  exceptions: SkillBindingException[],
  target: SkillBindingException
): SkillBindingException[] {
  if (hasException(exceptions, target.type, target.value)) {
    return exceptions
  }
  return [...exceptions, target]
}

function removeException(
  exceptions: SkillBindingException[],
  target: SkillBindingException
): SkillBindingException[] {
  return exceptions.filter(item => !(item.type === target.type && item.value === target.value))
}

function setExceptionEnabled(
  exceptions: SkillBindingException[],
  target: SkillBindingException,
  enabled: boolean
): SkillBindingException[] {
  return enabled ? removeException(exceptions, target) : addException(exceptions, target)
}

function setAgentGroupEnabled(
  exceptions: SkillBindingException[],
  teams: Team[],
  enabled: boolean
): SkillBindingException[] {
  return teams.reduce((next, team) => {
    return setExceptionEnabled(next, { type: 'agent', value: String(team.id) }, enabled)
  }, exceptions)
}

function getTeamLabel(team: Team): string {
  return team.displayName || team.name
}

function getSkillName(skill: UnifiedSkill): string {
  return skill.displayName || skill.name
}

function getAgentGroupKey(team: Team, currentUserId?: number | null): AgentGroupKey {
  if (team.user_id === 0) return 'system'
  if (team.namespace && team.namespace !== 'default') return 'group'
  if (currentUserId && team.user_id === currentUserId) return 'personal'
  return 'group'
}

export function AutoEnabledSkillSettingsView({
  skills,
  bindings,
  currentUserId,
  onBack,
  onBindingChange,
  getSkillSourceLabel,
  isGroupSkill,
}: AutoEnabledSkillSettingsViewProps) {
  const { t: tBase } = useTranslation('settings')
  const t = (key: string, options?: Record<string, unknown>) => tBase(key, options)
  const [teams, setTeams] = useState<Team[]>([])
  const [selectedSkill, setSelectedSkill] = useState<UnifiedSkill | null>(null)
  const [draftExceptions, setDraftExceptions] = useState<SkillBindingException[]>([])
  const [draftForcePreload, setDraftForcePreload] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let mounted = true
    fetchTeamsList('all')
      .then(items => {
        if (mounted) setTeams(items)
      })
      .catch(() => {
        if (mounted) setTeams([])
      })
    return () => {
      mounted = false
    }
  }, [])

  const openSkill = (skill: UnifiedSkill) => {
    const exceptions = getExceptionsForSkill(bindings, skill.id)
    setSelectedSkill(skill)
    setDraftExceptions(exceptions)
    setDraftForcePreload(isForcePreloadEnabled(bindings, skill.id))
  }

  const closeDialog = () => {
    setSelectedSkill(null)
  }

  const saveSelectedSkill = async () => {
    if (!selectedSkill) return
    setSaving(true)
    try {
      const binding = await updateMyDefaultSkillBindingExceptions(
        selectedSkill.id,
        draftExceptions,
        draftForcePreload
      )
      onBindingChange(binding)
      toast.success(t('skills.autoSettings.saveSuccess'))
      closeDialog()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('skills.autoSettings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const agentGroups = AGENT_GROUP_ORDER.map(key => ({
    key,
    label: t(`skills.autoSettings.agentGroups.${key}`),
    teams: teams.filter(team => getAgentGroupKey(team, currentUserId) === key),
  }))

  const getModeSummary = (exceptions: SkillBindingException[]) => {
    const disabledModes = exceptions.filter(item => item.type === 'mode').length
    if (disabledModes === 0) return t('skills.autoSettings.allModesEnabled')
    return t('skills.autoSettings.enabledModeCount', {
      enabled: MODE_OPTIONS.length - disabledModes,
      total: MODE_OPTIONS.length,
    })
  }

  const getAgentSummary = (exceptions: SkillBindingException[]) => {
    if (teams.length === 0) return t('skills.autoSettings.noAgentsAvailable')
    const disabledAgents = exceptions.filter(item => item.type === 'agent').length
    if (disabledAgents === 0) return t('skills.autoSettings.allAgentsEnabled')
    return t('skills.autoSettings.enabledAgentCount', {
      enabled: Math.max(teams.length - disabledAgents, 0),
      total: teams.length,
    })
  }

  const getExceptionSummary = (exceptions: SkillBindingException[]) =>
    exceptions.length === 0
      ? t('skills.autoSettings.noExceptions')
      : t('skills.autoSettings.exceptionCount', { count: exceptions.length })

  return (
    <div className="space-y-4" data-testid="auto-enabled-settings-view">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="mb-2 h-9 px-0"
            onClick={onBack}
            data-testid="back-to-skill-library-button"
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t('skills.autoSettings.back')}
          </Button>
          <h2 className="text-lg font-semibold text-text-primary">
            {t('skills.autoSettings.title')}
          </h2>
          <p className="text-sm text-text-secondary">{t('skills.autoSettings.description')}</p>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-surface text-left text-xs font-medium text-text-secondary">
              <tr>
                <th className="px-4 py-3">{t('skills.autoSettings.skillColumn')}</th>
                <th className="px-4 py-3">{t('skills.autoSettings.forcePreload')}</th>
                <th className="px-4 py-3">{t('skills.autoSettings.modeColumn')}</th>
                <th className="px-4 py-3">{t('skills.autoSettings.agentColumn')}</th>
                <th className="px-4 py-3">{t('skills.autoSettings.exceptionColumn')}</th>
                <th className="px-4 py-3 text-right">{t('skills.autoSettings.actionColumn')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-base">
              {skills.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-text-secondary">
                    {t('skills.defaultEnabled.emptyTitle')}
                  </td>
                </tr>
              ) : (
                skills.map(skill => {
                  const exceptions = getExceptionsForSkill(bindings, skill.id)
                  const forcePreload = isForcePreloadEnabled(bindings, skill.id)
                  const skillName = getSkillName(skill)
                  return (
                    <tr key={skill.id} data-testid={`auto-enabled-settings-skill-${skill.id}`}>
                      <td className="px-4 py-3">
                        <div className="flex min-w-0 flex-col gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-medium text-text-primary">
                              {skillName}
                            </span>
                            <Badge variant="secondary" className="text-xs">
                              {skill.is_public && <Globe className="mr-1 h-3 w-3" />}
                              {getSkillSourceLabel(skill)}
                            </Badge>
                            {isGroupSkill(skill) && (
                              <Badge variant="info" className="text-xs">
                                {skill.namespace}
                              </Badge>
                            )}
                          </div>
                          <p className="line-clamp-1 text-xs text-text-secondary">
                            {skill.description}
                          </p>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-text-secondary">
                        {forcePreload ? (
                          <span className="font-medium text-text-primary">
                            {t('skills.autoSettings.forcePreload')}
                          </span>
                        ) : (
                          t('skills.autoSettings.forcePreloadDisabled')
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-text-secondary">
                        {getModeSummary(exceptions)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-text-secondary">
                        {getAgentSummary(exceptions)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-text-secondary">
                        {getExceptionSummary(exceptions)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-9 min-w-[44px]"
                          onClick={() => openSkill(skill)}
                          aria-label={t('skills.autoSettings.configureSkill', {
                            name: skillName,
                          })}
                          data-testid={`configure-auto-enabled-skill-${skill.id}`}
                        >
                          <Settings2 className="h-4 w-4" aria-hidden />
                          {t('skills.autoSettings.configure')}
                        </Button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={Boolean(selectedSkill)} onOpenChange={open => !open && closeDialog()}>
        <DialogContent
          className="max-h-[90vh] max-w-[calc(100vw-2rem)] overflow-hidden sm:max-w-3xl"
          data-testid="auto-enabled-settings-dialog"
        >
          <DialogHeader>
            <DialogTitle>{selectedSkill ? getSkillName(selectedSkill) : ''}</DialogTitle>
            <DialogDescription>{t('skills.autoSettings.drawerDescription')}</DialogDescription>
          </DialogHeader>

          <div className="max-h-[calc(90vh-12rem)] space-y-5 overflow-y-auto pr-1">
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary">
                    {t('skills.autoSettings.defaultScopeTitle')}
                  </div>
                  <p className="mt-1 text-sm text-text-secondary">
                    {t('skills.autoSettings.defaultScopeDescription')}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-base p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-text-primary">
                  {t('skills.autoSettings.forcePreload')}
                </div>
                <p className="mt-1 text-sm text-text-secondary">
                  {t('skills.autoSettings.forcePreloadDescription')}
                </p>
              </div>
              <Switch
                checked={draftForcePreload}
                onCheckedChange={setDraftForcePreload}
                aria-label={t('skills.autoSettings.forcePreload')}
                data-testid="force-preload-switch"
              />
            </div>

            <section className="space-y-3">
              <h3 className="text-sm font-medium text-text-primary">
                {t('skills.autoSettings.modeExceptions')}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {MODE_OPTIONS.map(option => {
                  const label = t(`skills.autoSettings.modes.${option.key}`)
                  const checkboxLabel = t('skills.autoSettings.modeEnableLabel', {
                    mode: label,
                  })
                  const checked = !hasException(draftExceptions, 'mode', option.value)
                  return (
                    <label
                      key={option.value}
                      className="flex min-h-11 items-center gap-3 rounded-md border border-border bg-base px-3 py-2 text-sm"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={nextChecked => {
                          setDraftExceptions(prev =>
                            setExceptionEnabled(
                              prev,
                              { type: 'mode', value: option.value },
                              nextChecked === true
                            )
                          )
                        }}
                        aria-label={checkboxLabel}
                        data-testid={`mode-enable-checkbox-${option.value}`}
                      />
                      <span className="font-medium text-text-primary">{label}</span>
                    </label>
                  )
                })}
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium text-text-primary">
                {t('skills.autoSettings.agentExceptions')}
              </h3>
              <div className="space-y-3">
                {agentGroups.map(group => {
                  const enabledCount = group.teams.filter(
                    team => !hasException(draftExceptions, 'agent', String(team.id))
                  ).length
                  const groupChecked =
                    group.teams.length > 0 && enabledCount === group.teams.length
                      ? true
                      : enabledCount > 0
                        ? 'indeterminate'
                        : false
                  return (
                    <div key={group.key} className="rounded-lg border border-border bg-base">
                      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border px-3 py-2">
                        <label className="flex items-center gap-3 text-sm font-medium text-text-primary">
                          <Checkbox
                            checked={groupChecked}
                            disabled={group.teams.length === 0}
                            onCheckedChange={() => {
                              setDraftExceptions(prev =>
                                setAgentGroupEnabled(
                                  prev,
                                  group.teams,
                                  enabledCount !== group.teams.length
                                )
                              )
                            }}
                            aria-label={t('skills.autoSettings.agentGroupEnableLabel', {
                              group: group.label,
                            })}
                            data-testid={`agent-group-enable-checkbox-${group.key}`}
                          />
                          <span>{group.label}</span>
                        </label>
                        <span className="text-xs text-text-secondary">
                          {group.teams.length === 0
                            ? t('skills.autoSettings.emptyAgentGroup')
                            : t('skills.autoSettings.enabledAgentCount', {
                                enabled: enabledCount,
                                total: group.teams.length,
                              })}
                        </span>
                      </div>

                      {group.teams.length > 0 && (
                        <div className="grid gap-1 p-2 sm:grid-cols-2">
                          {group.teams.map(team => {
                            const label = getTeamLabel(team)
                            const value = String(team.id)
                            const checked = !hasException(draftExceptions, 'agent', value)
                            return (
                              <label
                                key={team.id}
                                className="flex min-h-10 items-center gap-3 rounded-md px-2 text-sm hover:bg-surface"
                              >
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={nextChecked => {
                                    setDraftExceptions(prev =>
                                      setExceptionEnabled(
                                        prev,
                                        { type: 'agent', value },
                                        nextChecked === true
                                      )
                                    )
                                  }}
                                  aria-label={t('skills.autoSettings.agentEnableLabel', {
                                    name: label,
                                  })}
                                  data-testid={`agent-enable-checkbox-${team.id}`}
                                />
                                <span className="min-w-0 truncate text-text-primary">{label}</span>
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDraftExceptions([])}
              disabled={draftExceptions.length === 0 || saving}
              data-testid="clear-auto-enabled-exceptions-button"
            >
              {t('skills.autoSettings.clearExceptions')}
            </Button>
            <Button
              variant="primary"
              onClick={saveSelectedSkill}
              disabled={saving}
              data-testid="save-auto-enabled-settings-button"
            >
              {t('skills.autoSettings.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
