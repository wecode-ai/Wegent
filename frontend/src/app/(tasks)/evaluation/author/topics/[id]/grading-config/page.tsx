// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { ArrowLeft, Bot, Save, Zap, Clock, AlertCircle } from 'lucide-react'
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
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useToast } from '@/hooks/use-toast'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import {
  getAuthorTopic,
  getAuthorGradingConfig,
  updateAuthorGradingConfig,
} from '@wecode/api/evaluation-author'
import type { Topic, GradingConfig } from '@wecode/types/evaluation'
import { useTranslation } from '@/hooks/useTranslation'
import { teamApis } from '@/apis/team'
import type { Team } from '@/types/api'

const TRIGGER_CONDITIONS = {
  ON_SUBMIT: 'on_submit',
  MANUAL: 'manual',
  SCHEDULED: 'scheduled',
}

// Special value for "no team selected" - Radix Select doesn't allow empty string
const NO_TEAM_VALUE = '__none__'

function GradingConfigContent() {
  const router = useRouter()
  const params = useParams()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')
  const topicId = parseInt(params.id as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [config, setConfig] = useState<GradingConfig | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
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
      const [topicData, configData, teamsData] = await Promise.all([
        getAuthorTopic(topicId),
        getAuthorGradingConfig(topicId),
        teamApis.getTeams({ page: 1, limit: 100 }),
      ])
      setTopic(topicData)
      setConfig(configData)
      setTeams(teamsData.items || [])

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
      router.push(`/evaluation/author/topics/${topicId}`)
    } finally {
      setLoading(false)
    }
  }, [topicId, toast, router, t])

  useEffect(() => {
    if (topicId) {
      loadData()
    }
  }, [topicId, loadData])

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

  // Filter teams by ClaudeCode shell type (as per spec)
  const claudeCodeTeams = teams.filter(team => {
    // Check team's agent_type directly
    if (team.agent_type?.toLowerCase().includes('claudecode') ||
        team.agent_type?.toLowerCase().includes('claude')) {
      return true
    }
    // Check if any bot in the team uses ClaudeCode shell
    return team.bots?.some(
      teamBot => teamBot.bot?.shell_type?.toLowerCase().includes('claudecode') ||
                 teamBot.bot?.shell_type?.toLowerCase().includes('claude')
    )
  })

  if (loading) {
    return (
      <div className="container mx-auto max-w-2xl px-4 py-8">
        <Skeleton className="mb-6 h-10 w-32" />
        <div className="space-y-6">
          <Skeleton className="h-48" />
          <Skeleton className="h-32" />
          <Skeleton className="h-64" />
        </div>
      </div>
    )
  }

  if (!topic || !config) {
    return null
  }

  return (
    <div className="container mx-auto max-w-2xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <Button
          variant="ghost"
          onClick={() => router.push(`/evaluation/author/topics/${topicId}`)}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t('actions.back')}
        </Button>
      </div>

      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-text-primary">
          {t('grading.config_title')}
        </h1>
        <p className="text-text-secondary">
          {t('topics.title')}: {topic.name}
        </p>
      </div>

      <div className="space-y-6">
        {/* Team Selection */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              {t('grading.select_team')}
            </CardTitle>
            <CardDescription>{t('grading.select_team_description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="team">{t('grading.team')}</Label>
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger id="team">
                  <SelectValue placeholder={t('grading.select_team_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TEAM_VALUE}>{t('grading.no_team')}</SelectItem>
                  {(claudeCodeTeams.length > 0 ? claudeCodeTeams : teams).map(team => (
                    <SelectItem key={team.id} value={team.id?.toString() || NO_TEAM_VALUE}>
                      {team.name || `Team ${team.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {claudeCodeTeams.length === 0 && teams.length > 0 && (
                <p className="text-xs text-text-muted">
                  {t('grading.all_teams_shown')}
                </p>
              )}
            </div>

            {(!teamId || teamId === NO_TEAM_VALUE) && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{t('grading.no_team_warning')}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Auto Trigger Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              {t('grading.auto_trigger')}
            </CardTitle>
            <CardDescription>{t('grading.auto_trigger_description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>{t('grading.enable_auto_trigger')}</Label>
                <p className="text-xs text-text-muted">{t('grading.enable_auto_trigger_hint')}</p>
              </div>
              <Switch checked={autoTrigger} onCheckedChange={setAutoTrigger} disabled={!teamId || teamId === NO_TEAM_VALUE} />
            </div>

            {autoTrigger && (
              <div className="space-y-2">
                <Label htmlFor="triggerCondition">{t('grading.trigger_condition')}</Label>
                <Select value={triggerCondition} onValueChange={setTriggerCondition}>
                  <SelectTrigger id="triggerCondition">
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

        {/* Timeout Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              {t('grading.timeout_config')}
            </CardTitle>
            <CardDescription>{t('grading.timeout_description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="timeout">{t('grading.timeout_seconds')}</Label>
              <Input
                id="timeout"
                type="number"
                value={gradingTimeout}
                onChange={e => setGradingTimeout(parseInt(e.target.value) || 3600)}
                min={60}
                max={86400}
              />
              <p className="text-xs text-text-muted">
                {t('grading.timeout_hint', { minutes: Math.floor(gradingTimeout / 60) })}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Save Button */}
        <div className="flex justify-end gap-4">
          <Button
            variant="outline"
            onClick={() => router.push(`/evaluation/author/topics/${topicId}`)}
          >
            {t('actions.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? '...' : t('actions.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function GradingConfigPage() {
  return (
    <EvaluationPageLayout>
      <GradingConfigContent />
    </EvaluationPageLayout>
  )
}
