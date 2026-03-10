// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Bot, Zap, Clock, AlertCircle, Save, CheckCircle, ListTodo, ArrowRight } from 'lucide-react'
import { getAuthorGradingConfig, updateAuthorGradingConfig } from '@wecode/api/evaluation-author'
import type { GradingConfig, TopicStatistics } from '@wecode/types/evaluation'
import { teamApis } from '@/apis/team'
import type { Team } from '@/types/api'
import Link from 'next/link'

const TRIGGER_CONDITIONS = {
  ON_SUBMIT: 'on_submit',
  MANUAL: 'manual',
  SCHEDULED: 'scheduled',
}

const NO_TEAM_VALUE = '__none__'

interface GradingConfigTabProps {
  topicId: number
  statistics: TopicStatistics | null
}

// Check if a team uses Chat shell type (for AI grading)
function isChatShellTeam(team: Team): boolean {
  const agentType = team.agent_type?.toLowerCase() || ''
  if (agentType.includes('chat')) {
    return true
  }
  return (
    team.bots?.some(teamBot => {
      const shellType = teamBot.bot?.shell_type?.toLowerCase() || ''
      return shellType.includes('chat')
    }) ?? false
  )
}

export function GradingConfigTab({ topicId, statistics }: GradingConfigTabProps) {
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const [, setConfig] = useState<GradingConfig | null>(null)
  const [groupTeams, setGroupTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Form state
  const [teamId, setTeamId] = useState<string>('')
  const [autoTrigger, setAutoTrigger] = useState(false)
  const [triggerCondition, setTriggerCondition] = useState(TRIGGER_CONDITIONS.ON_SUBMIT)
  const [gradingTimeout, setGradingTimeout] = useState(3600)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [configData, teamsData] = await Promise.all([
        getAuthorGradingConfig(topicId),
        teamApis.getTeams({ page: 1, limit: 100 }, 'group'),
      ])
      setConfig(configData)
      setGroupTeams(teamsData.items || [])

      // Populate form state
      setTeamId(configData.team_id?.toString() || NO_TEAM_VALUE)
      setAutoTrigger(configData.auto_trigger || false)
      setTriggerCondition(configData.trigger_condition || TRIGGER_CONDITIONS.ON_SUBMIT)
      setGradingTimeout(configData.grading_timeout || 3600)
    } catch (_error) {
      toast({
        title: t('errors.load_failed'),
        description: t('errors.not_found'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [topicId, toast, t])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateAuthorGradingConfig(topicId, {
        team_id: teamId && teamId !== NO_TEAM_VALUE ? parseInt(teamId) : undefined,
        auto_trigger: autoTrigger,
        trigger_condition: triggerCondition,
        grading_timeout: gradingTimeout,
      })

      toast({
        title: t('grading.config_saved'),
        description: '',
      })
      loadData()
    } catch (error) {
      toast({
        title: t('errors.save_failed'),
        description: error instanceof Error ? error.message : t('errors.save_failed'),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  // Filter teams by Chat shell type
  const chatTeams = groupTeams.filter(isChatShellTeam)
  const availableTeams = chatTeams.length > 0 ? chatTeams : groupTeams

  // Calculate grading stats
  const totalAnswers = statistics?.total_answers || 0
  const completedGradings = statistics?.grading_completed || 0
  const pendingGradings = statistics?.grading_pending || 0

  if (loading) {
    return <GradingConfigSkeleton />
  }

  return (
    <div className="space-y-6">
      {/* Team Selection Card */}
      <Card className="bg-white rounded-2xl shadow-sm border border-gray-100">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Bot className="h-5 w-5 text-primary" />
            {t('grading.select_team')}
          </CardTitle>
          <CardDescription className="text-sm text-text-secondary">
            {t('grading.select_team_description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="team" className="text-sm font-medium">
              {t('grading.team')}
            </Label>
            <Select value={teamId} onValueChange={setTeamId}>
              <SelectTrigger id="team" className="w-full">
                <SelectValue placeholder={t('grading.select_team_placeholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TEAM_VALUE}>{t('grading.no_team')}</SelectItem>
                {availableTeams.map(team => (
                  <SelectItem key={team.id} value={team.id?.toString() || NO_TEAM_VALUE}>
                    {team.namespace && team.namespace !== 'default'
                      ? `[${team.namespace}] ${team.name || `Team ${team.id}`}`
                      : team.name || `Team ${team.id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {groupTeams.length === 0 && (
              <p className="text-xs text-amber-600">{t('grading.no_group_teams')}</p>
            )}
            {chatTeams.length === 0 && groupTeams.length > 0 && (
              <p className="text-xs text-text-muted">{t('grading.all_teams_shown')}</p>
            )}
          </div>

          {(!teamId || teamId === NO_TEAM_VALUE) && (
            <Alert className="bg-amber-50 border-amber-200">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-amber-700 text-sm">
                {t('grading.no_team_warning')}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Auto Trigger Configuration Card */}
      <Card className="bg-white rounded-2xl shadow-sm border border-gray-100">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Zap className="h-5 w-5 text-amber-500" />
            {t('grading.auto_trigger')}
          </CardTitle>
          <CardDescription className="text-sm text-text-secondary">
            {t('grading.auto_trigger_description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">{t('grading.enable_auto_trigger')}</Label>
              <p className="text-xs text-text-muted">{t('grading.enable_auto_trigger_hint')}</p>
            </div>
            <Switch
              checked={autoTrigger}
              onCheckedChange={setAutoTrigger}
              disabled={!teamId || teamId === NO_TEAM_VALUE}
            />
          </div>

          {autoTrigger && (
            <div className="space-y-2 pt-2">
              <Label htmlFor="triggerCondition" className="text-sm font-medium">
                {t('grading.trigger_condition')}
              </Label>
              <Select value={triggerCondition} onValueChange={setTriggerCondition}>
                <SelectTrigger id="triggerCondition" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TRIGGER_CONDITIONS.ON_SUBMIT}>
                    {t('grading.trigger_on_submit')}
                  </SelectItem>
                  <SelectItem value={TRIGGER_CONDITIONS.MANUAL}>
                    {t('grading.trigger_manual')}
                  </SelectItem>
                  <SelectItem value={TRIGGER_CONDITIONS.SCHEDULED}>
                    {t('grading.trigger_scheduled')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Timeout Configuration Card */}
      <Card className="bg-white rounded-2xl shadow-sm border border-gray-100">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Clock className="h-5 w-5 text-blue-500" />
            {t('grading.timeout_config')}
          </CardTitle>
          <CardDescription className="text-sm text-text-secondary">
            {t('grading.timeout_description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="timeout" className="text-sm font-medium">
              {t('grading.timeout_seconds')}
            </Label>
            <Input
              id="timeout"
              type="number"
              value={gradingTimeout}
              onChange={e => setGradingTimeout(parseInt(e.target.value) || 3600)}
              min={60}
              max={86400}
              className="w-full"
            />
            <p className="text-xs text-text-muted">
              {t('grading.timeout_hint', { minutes: Math.floor(gradingTimeout / 60) })}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Grading Tasks Summary Card */}
      <Card className="bg-white rounded-2xl shadow-sm border border-gray-100">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <ListTodo className="h-5 w-5 text-purple-500" />
            {t('grading.tasks_summary')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center p-4 bg-gray-50 rounded-xl">
              <div className="text-2xl font-bold text-gray-900">{totalAnswers}</div>
              <div className="text-xs text-text-secondary mt-1">{t('grading.total_answers')}</div>
            </div>
            <div className="text-center p-4 bg-green-50 rounded-xl">
              <div className="text-2xl font-bold text-green-600">{completedGradings}</div>
              <div className="text-xs text-green-600/70 mt-1">{t('grading.completed')}</div>
            </div>
            <div className="text-center p-4 bg-amber-50 rounded-xl">
              <div className="text-2xl font-bold text-amber-600">{pendingGradings}</div>
              <div className="text-xs text-amber-600/70 mt-1">{t('grading.pending')}</div>
            </div>
          </div>

          <Link
            href={`/evaluation/grader/topics/${topicId}`}
            className="mt-4 flex items-center justify-center gap-2 w-full px-4 py-3 text-sm font-medium text-primary bg-primary/5 hover:bg-primary/10 rounded-xl transition-colors"
          >
            <CheckCircle className="h-4 w-4" />
            {t('grading.view_grading_tasks')}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end gap-4">
        <Button variant="primary" onClick={handleSave} disabled={saving} className="px-6">
          <Save className="mr-2 h-4 w-4" />
          {saving ? t('common:actions.saving') : t('common:actions.save')}
        </Button>
      </div>
    </div>
  )
}

function GradingConfigSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-48 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-32 w-full rounded-2xl" />
      <Skeleton className="h-48 w-full rounded-2xl" />
      <div className="flex justify-end">
        <Skeleton className="h-10 w-32" />
      </div>
    </div>
  )
}
