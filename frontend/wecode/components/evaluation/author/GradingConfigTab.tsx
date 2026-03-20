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
import {
  Bot,
  Zap,
  Clock,
  AlertCircle,
  Save,
  CheckCircle,
  ListTodo,
  ArrowRight,
  FileText,
  Layers,
} from 'lucide-react'
import { getAuthorGradingConfig, updateAuthorGradingConfig } from '@wecode/api/evaluation-author'
import type { GradingConfig, TopicStatistics } from '@wecode/types/evaluation'
import { teamApis } from '@/apis/team'
import type { Team } from '@/types/api'
import Link from 'next/link'
import { Textarea } from '@/components/ui/textarea'
import {
  EvaluationModelSelector,
  EvaluationMultiModelSelector,
  type MultiModelEntry,
} from '@wecode/components/evaluation/common/EvaluationModelSelector'

const TRIGGER_CONDITIONS = {
  ON_SUBMIT: 'on_submit',
  MANUAL: 'manual',
  SCHEDULED: 'scheduled',
}

const GRADING_MODES = {
  SINGLE: 'single',
  MULTI: 'multi',
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

  // Form state - Single Model Mode
  const [teamId, setTeamId] = useState<string>('')
  const [autoTrigger, setAutoTrigger] = useState(false)
  const [triggerCondition, setTriggerCondition] = useState(TRIGGER_CONDITIONS.ON_SUBMIT)
  const [gradingTimeout, setGradingTimeout] = useState(3600)
  const [promptTemplate, setPromptTemplate] = useState<string>('')
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [forceOverride, setForceOverride] = useState(false)

  // Form state - Multi Model Mode
  const [gradingMode, setGradingMode] = useState<string>(GRADING_MODES.SINGLE)
  const [scorerTeamId, setScorerTeamId] = useState<string>('')
  const [aggregatorTeamId, setAggregatorTeamId] = useState<string>('')
  const [scorerModels, setScorerModels] = useState<MultiModelEntry[]>([])
  const [aggregatorModel, setAggregatorModel] = useState<string>('')
  const [aggregatorForceOverride, setAggregatorForceOverride] = useState(true)
  const [scorerPromptTemplate, setScorerPromptTemplate] = useState<string>('')
  const [aggregatorPromptTemplate, setAggregatorPromptTemplate] = useState<string>('')

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [configData, teamsData] = await Promise.all([
        getAuthorGradingConfig(topicId),
        teamApis.getTeams({ page: 1, limit: 100 }, 'group'),
      ])
      setConfig(configData)
      setGroupTeams(teamsData.items || [])

      // Populate form state - Common
      setGradingMode(configData.grading_mode || GRADING_MODES.SINGLE)
      setTeamId(configData.team_id?.toString() || NO_TEAM_VALUE)
      setAutoTrigger(configData.auto_trigger || false)
      setTriggerCondition(configData.trigger_condition || TRIGGER_CONDITIONS.ON_SUBMIT)
      setGradingTimeout(configData.grading_timeout || 3600)
      setPromptTemplate(configData.prompt_template || '')

      // Populate form state - Single Model
      setSelectedModel(configData.model_id || '')
      setForceOverride(configData.force_override_bot_model || false)

      // Populate form state - Multi Model
      setScorerTeamId(configData.scorer_team_id?.toString() || NO_TEAM_VALUE)
      setAggregatorTeamId(configData.aggregator_team_id?.toString() || NO_TEAM_VALUE)
      // Convert scorer_models to MultiModelEntry format
      const scorerModelsData = configData.scorer_models || []
      setScorerModels(
        scorerModelsData.map((m, index) => ({
          id: `scorer-${index}-${Date.now()}`,
          modelId: m.model_id,
          forceOverride: m.force_override,
        }))
      )
      setAggregatorModel(configData.aggregator_model?.model_id || '')
      setAggregatorForceOverride(configData.aggregator_model?.force_override ?? true)
      setScorerPromptTemplate(configData.scorer_prompt_template || '')
      setAggregatorPromptTemplate(configData.aggregator_prompt_template || '')
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
      const payload: Record<string, unknown> = {
        auto_trigger: autoTrigger,
        trigger_condition: triggerCondition,
        grading_timeout: gradingTimeout,
        grading_mode: gradingMode,
      }

      if (gradingMode === GRADING_MODES.SINGLE) {
        // Single model mode
        payload.team_id = teamId && teamId !== NO_TEAM_VALUE ? parseInt(teamId) : undefined
        payload.prompt_template = promptTemplate || undefined
        payload.model_id = selectedModel || undefined
        payload.force_override_bot_model = forceOverride
      } else {
        // Multi model mode
        payload.scorer_team_id = scorerTeamId && scorerTeamId !== NO_TEAM_VALUE ? parseInt(scorerTeamId) : undefined
        payload.aggregator_team_id = aggregatorTeamId && aggregatorTeamId !== NO_TEAM_VALUE ? parseInt(aggregatorTeamId) : undefined
        // Convert MultiModelEntry to ScorerModelConfig
        payload.scorer_models = scorerModels.length > 0
          ? scorerModels.map(m => ({
              model_id: m.modelId,
              force_override: m.forceOverride,
            }))
          : undefined
        payload.aggregator_model = aggregatorModel ? {
          model_id: aggregatorModel,
          force_override: aggregatorForceOverride,
        } : undefined
        payload.scorer_prompt_template = scorerPromptTemplate || undefined
        payload.aggregator_prompt_template = aggregatorPromptTemplate || undefined
      }

      await updateAuthorGradingConfig(topicId, payload)

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
      {/* Grading Mode Selection Card */}
      <Card className="bg-white rounded-2xl shadow-sm border border-gray-100">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Layers className="h-5 w-5 text-primary" />
            {t('grading.grading_mode') || 'Grading Mode'}
          </CardTitle>
          <CardDescription className="text-sm text-text-secondary">
            {t('grading.grading_mode_description') || 'Choose between single model or multi-model grading'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="gradingMode" className="text-sm font-medium">
              {t('grading.mode') || 'Mode'}
            </Label>
            <Select value={gradingMode} onValueChange={setGradingMode}>
              <SelectTrigger id="gradingMode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={GRADING_MODES.SINGLE}>
                  {t('grading.single_mode') || 'Single Model'}
                </SelectItem>
                <SelectItem value={GRADING_MODES.MULTI}>
                  {t('grading.multi_mode') || 'Multi-Model (with Aggregation)'}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {gradingMode === GRADING_MODES.MULTI && (
            <Alert className="bg-blue-50 border-blue-200">
              <AlertCircle className="h-4 w-4 text-blue-600" />
              <AlertDescription className="text-blue-700 text-sm">
                {t('grading.multi_mode_info') ||
                  'Configure multiple scorer models (1-N) to run in parallel, then aggregate results for a stable final score. You can use the same model multiple times.'}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {gradingMode === GRADING_MODES.SINGLE ? (
        <>
          {/* Team Selection Card - Single Mode */}
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

          {/* Model Selection Card - Single Mode */}
          <Card className="bg-white rounded-2xl shadow-sm border border-gray-100">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Bot className="h-5 w-5 text-indigo-500" />
                {t('grading.model_config')}
              </CardTitle>
              <CardDescription className="text-sm text-text-secondary">
                {t('grading.model_config_description')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('grading.model_select')}</Label>
                <EvaluationModelSelector
                  value={selectedModel}
                  onChange={(modelId, force) => {
                    setSelectedModel(modelId)
                    setForceOverride(force)
                  }}
                  forceOverride={forceOverride}
                  disabled={!teamId || teamId === NO_TEAM_VALUE}
                  placeholder={t('grading.select_model') || 'Select Model'}
                />
              </div>
            </CardContent>
          </Card>

          {/* Prompt Template Configuration Card */}
          <Card className="bg-white rounded-2xl shadow-sm border border-gray-100">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <FileText className="h-5 w-5 text-emerald-500" />
                {t('grading.prompt_template')}
              </CardTitle>
              <CardDescription className="text-sm text-text-secondary">
                {t('grading.prompt_template_description')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="promptTemplate" className="text-sm font-medium">
                  {t('grading.prompt_template_label')}
                </Label>
                <Textarea
                  id="promptTemplate"
                  value={promptTemplate}
                  onChange={e => setPromptTemplate(e.target.value)}
                  placeholder={t('grading.prompt_template_placeholder')}
                  className="w-full min-h-[120px] font-mono text-sm"
                />
                <div className="text-xs text-text-muted space-y-1">
                  <p>{t('grading.prompt_template_hint')}</p>
                  <p className="font-mono bg-gray-100 px-2 py-1 rounded">
                    {'{user_id}, {grading_task_id}, {topic_id}, {question_id}, {question_title}'}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          {/* Scorer Team Selection Card - Multi Mode */}
          <Card className="bg-white rounded-2xl shadow-sm border border-gray-100">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Bot className="h-5 w-5 text-blue-500" />
                {t('grading.scorer_team') || 'Scorer Team'}
              </CardTitle>
              <CardDescription className="text-sm text-text-secondary">
                {t('grading.scorer_team_description') ||
                  'Select the team for scoring models (3-5 models will run in parallel)'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="scorerTeam" className="text-sm font-medium">
                  {t('grading.team')}
                </Label>
                <Select value={scorerTeamId} onValueChange={setScorerTeamId}>
                  <SelectTrigger id="scorerTeam" className="w-full">
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
              </div>

              {/* Scorer Models */}
              <div className="space-y-3 pt-2">
                <Label className="text-sm font-medium">
                  {t('grading.scorer_models') || 'Scorer Models'}
                </Label>
                <EvaluationMultiModelSelector
                  value={scorerModels}
                  onChange={setScorerModels}
                  disabled={!scorerTeamId || scorerTeamId === NO_TEAM_VALUE}
                  maxModels={10}
                  minModels={0}
                />
              </div>

              {/* Scorer Prompt Template */}
              <div className="space-y-2 pt-2">
                <Label htmlFor="scorerPromptTemplate" className="text-sm font-medium">
                  {t('grading.scorer_prompt_template') || 'Scorer Prompt Template'}
                </Label>
                <Textarea
                  id="scorerPromptTemplate"
                  value={scorerPromptTemplate}
                  onChange={e => setScorerPromptTemplate(e.target.value)}
                  placeholder={t('grading.scorer_prompt_placeholder') || 'Prompt template for scorer models...'}
                  className="w-full min-h-[100px] font-mono text-sm"
                />
              </div>
            </CardContent>
          </Card>

          {/* Aggregator Team Selection Card - Multi Mode */}
          <Card className="bg-white rounded-2xl shadow-sm border border-gray-100">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Layers className="h-5 w-5 text-purple-500" />
                {t('grading.aggregator_team') || 'Aggregator Team'}
              </CardTitle>
              <CardDescription className="text-sm text-text-secondary">
                {t('grading.aggregator_team_description') ||
                  'Select the team for the aggregator model (combines all scorer results)'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="aggregatorTeam" className="text-sm font-medium">
                  {t('grading.team')}
                </Label>
                <Select value={aggregatorTeamId} onValueChange={setAggregatorTeamId}>
                  <SelectTrigger id="aggregatorTeam" className="w-full">
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
              </div>

              {/* Aggregator Model */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  {t('grading.aggregator_model') || 'Aggregator Model'}
                </Label>
                <EvaluationModelSelector
                  value={aggregatorModel}
                  onChange={(modelId, force) => {
                    setAggregatorModel(modelId)
                    setAggregatorForceOverride(force)
                  }}
                  forceOverride={aggregatorForceOverride}
                  disabled={!aggregatorTeamId || aggregatorTeamId === NO_TEAM_VALUE}
                  placeholder={t('grading.select_aggregator_model') || 'Select Aggregator Model'}
                />
              </div>

              {/* Aggregator Prompt Template */}
              <div className="space-y-2 pt-2">
                <Label htmlFor="aggregatorPromptTemplate" className="text-sm font-medium">
                  {t('grading.aggregator_prompt_template') || 'Aggregator Prompt Template'}
                </Label>
                <Textarea
                  id="aggregatorPromptTemplate"
                  value={aggregatorPromptTemplate}
                  onChange={e => setAggregatorPromptTemplate(e.target.value)}
                  placeholder={t('grading.aggregator_prompt_placeholder') ||
                    'Prompt template for aggregator model. Use {scorer_results} to include all scorer outputs...'}
                  className="w-full min-h-[100px] font-mono text-sm"
                />
                <div className="text-xs text-text-muted">
                  <p className="font-mono bg-gray-100 px-2 py-1 rounded inline-block">
                    {'{scorer_results}'}
                  </p>{' '}
                  {t('grading.aggregator_template_hint') || 'will be replaced with all scorer outputs'}
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}

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
              disabled={
                gradingMode === GRADING_MODES.SINGLE
                  ? !teamId || teamId === NO_TEAM_VALUE
                  : (!scorerTeamId || scorerTeamId === NO_TEAM_VALUE || !aggregatorTeamId || aggregatorTeamId === NO_TEAM_VALUE)
              }
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
