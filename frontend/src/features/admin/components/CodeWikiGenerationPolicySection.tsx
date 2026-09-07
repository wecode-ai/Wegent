// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { CollapsibleSection } from '@/components/common/CollapsibleSection'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { adminApis } from '@/apis/admin'
import type {
  AdminPublicTeam,
  CodeWikiGenerationPolicyConfig,
  CodeWikiGenerationPolicyStrategy,
} from '@/apis/admin'

function strategyName(
  strategy: Pick<CodeWikiGenerationPolicyStrategy, 'id' | 'display_name'>,
  t: (key: string) => string
) {
  const key = `code_wiki_generation_strategy_${strategy.id}_title`
  const translated = t(key)
  return translated === key ? strategy.display_name : translated
}

function strategyDescription(
  strategy: Pick<CodeWikiGenerationPolicyStrategy, 'id' | 'description'>,
  t: (key: string) => string
) {
  const key = `code_wiki_generation_strategy_${strategy.id}_description`
  const translated = t(key)
  return translated === key ? strategy.description : translated
}

function teamValue(team: Pick<AdminPublicTeam, 'name' | 'namespace'>) {
  return `${team.namespace}/${team.name}`
}

export function CodeWikiGenerationPolicySection() {
  const { t } = useTranslation('admin')
  const { toast } = useToast()
  const [policy, setPolicy] = useState<CodeWikiGenerationPolicyConfig | null>(null)
  const [teams, setTeams] = useState<AdminPublicTeam[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void Promise.all([adminApis.getCodeWikiGenerationPolicy(), adminApis.getPublicTeams(1, 1000)])
      .then(([nextPolicy, response]) => {
        setPolicy(nextPolicy)
        setTeams(response.items.filter(team => team.is_active))
        setLoadState('ready')
      })
      .catch(() => setLoadState('error'))
  }, [])

  const enabledStrategies = useMemo(
    () => policy?.strategies.filter(strategy => strategy.enabled) ?? [],
    [policy]
  )
  const defaultStrategy = enabledStrategies.some(item => item.id === policy?.default_strategy)
    ? policy?.default_strategy
    : (enabledStrategies[0]?.id ?? '')

  const updateStrategy = (id: string, update: Partial<CodeWikiGenerationPolicyStrategy>) => {
    setPolicy(current =>
      current
        ? {
            ...current,
            strategies: current.strategies.map(strategy =>
              strategy.id === id ? { ...strategy, ...update } : strategy
            ),
          }
        : current
    )
  }

  const save = async () => {
    if (!policy || !defaultStrategy) {
      toast({
        title: t('system_config.code_wiki_generation_policy_default_required'),
        variant: 'destructive',
      })
      return
    }
    setSaving(true)
    try {
      const response = await adminApis.updateCodeWikiGenerationPolicy({
        default_strategy: defaultStrategy,
        strategies: policy.strategies,
      })
      setPolicy(response)
      toast({ title: t('system_config.code_wiki_generation_policy_saved') })
    } catch {
      toast({
        title: t('system_config.code_wiki_generation_policy_save_failed'),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <CollapsibleSection
      title={t('system_config.code_wiki_generation_policy_title')}
      defaultOpen={false}
      className="mb-0"
      triggerTestId="code-wiki-generation-policy-toggle"
    >
      <p className="text-sm text-text-muted">
        {t('system_config.code_wiki_generation_policy_description')}
      </p>
      {policy && !policy.configured && (
        <p className="text-sm text-warning">
          {t('system_config.code_wiki_generation_policy_bootstrap')}
        </p>
      )}
      {loadState === 'error' ? (
        <p className="text-sm text-destructive">
          {t('system_config.code_wiki_generation_policy_load_failed')}
        </p>
      ) : (
        <>
          <div className="space-y-3">
            {policy?.strategies.map(strategy => {
              const selectedTeam = `${strategy.team_namespace}/${strategy.team_name}`
              return (
                <div key={strategy.id} className="rounded-lg border border-border p-3 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-text-primary">
                        {strategyName(strategy, t)}
                      </p>
                      <p className="text-xs text-text-muted">{strategyDescription(strategy, t)}</p>
                    </div>
                    <Switch
                      checked={strategy.enabled}
                      onCheckedChange={enabled => updateStrategy(strategy.id, { enabled })}
                      aria-label={strategyName(strategy, t)}
                    />
                  </div>
                  <Select
                    value={selectedTeam}
                    onValueChange={next => {
                      const team = teams.find(item => teamValue(item) === next)
                      if (team) {
                        updateStrategy(strategy.id, {
                          team_name: team.name,
                          team_namespace: team.namespace,
                        })
                      }
                    }}
                    disabled={!strategy.enabled || teams.length === 0}
                  >
                    <SelectTrigger className="bg-base">
                      <SelectValue
                        placeholder={t(
                          'system_config.code_wiki_generation_policy_team_placeholder'
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {teams.map(team => (
                        <SelectItem key={team.id} value={teamValue(team)}>
                          {team.display_name || team.name} ({team.namespace})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )
            })}
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-text-primary">
              {t('system_config.code_wiki_generation_policy_default')}
            </p>
            <Select
              value={defaultStrategy}
              onValueChange={default_strategy =>
                setPolicy(current => (current ? { ...current, default_strategy } : current))
              }
              disabled={loadState !== 'ready' || enabledStrategies.length === 0}
            >
              <SelectTrigger className="bg-base">
                <SelectValue
                  placeholder={t('system_config.code_wiki_generation_policy_default_placeholder')}
                />
              </SelectTrigger>
              <SelectContent>
                {enabledStrategies.map(strategy => (
                  <SelectItem key={strategy.id} value={strategy.id}>
                    {strategyName(strategy, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="primary"
            className="h-11"
            onClick={save}
            disabled={saving || loadState !== 'ready' || enabledStrategies.length === 0}
            data-testid="save-code-wiki-generation-policy"
          >
            {t('common:actions.save')}
          </Button>
        </>
      )}
    </CollapsibleSection>
  )
}
