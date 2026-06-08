'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Task Settings Section - Execution target, prompt input with agent, model, and skill selectors
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronDown, Database, Settings, Sparkles, Users, X, Variable } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  GroupedModelSelect,
  type ModelCascadeLabels,
  type SpecialModelOption,
} from '@/components/model-select/ModelCascadeSelect'
import { Badge } from '@/components/ui/badge'
import { RichSkillSelector } from '@/features/settings/components/skills/RichSkillSelector'
import { RichKnowledgeBaseSelector } from '../RichKnowledgeBaseSelector'
import { CollapsibleSection } from '@/components/common/CollapsibleSection'
import type { SendAreaSectionProps } from './types'
import type { DeviceInfo } from '@/apis/devices'
import type { SubscriptionExecutionTargetType } from '@/types/subscription'
import type { CompatibleProvider } from '@/utils/modelCompatibility'

const sortDevicesForSelection = (devices: DeviceInfo[]): DeviceInfo[] =>
  [...devices].sort((left, right) => {
    if (left.device_type !== right.device_type) {
      return left.device_type === 'local' ? -1 : 1
    }
    if (left.is_default !== right.is_default) {
      return left.is_default ? -1 : 1
    }
    return left.name.localeCompare(right.name)
  })

const getPreferredDevice = (devices: DeviceInfo[]): DeviceInfo | null => {
  const sortedDevices = sortDevicesForSelection(devices)
  return sortedDevices[0] || null
}

export function SendAreaSection({
  executionTarget,
  setExecutionTarget,
  availableDevices,
  devicesLoading,
  promptTemplate,
  setPromptTemplate,
  triggerType,
  triggerConfig,
  teamId,
  setTeamId,
  teams,
  teamsLoading,
  selectedModel,
  setSelectedModel,
  models,
  modelsLoading,
  modelRequired,
  compatibleProvider,
  skillRefs,
  setSkillRefs,
  availableSkills,
  skillsLoading,
  knowledgeBaseRefs,
  setKnowledgeBaseRefs,
  preserveHistory,
  setPreserveHistory,
  historyMessageCount,
  setHistoryMessageCount,
  isRental,
}: SendAreaSectionProps) {
  const { t } = useTranslation('feed')
  const promptTemplateRef = useRef<HTMLTextAreaElement>(null)
  const [variablesPopoverOpen, setVariablesPopoverOpen] = useState(false)

  // Build prompt variables list based on trigger type
  const isInboxMessageTrigger =
    triggerType === 'event' && triggerConfig?.event_type === 'inbox_message'
  const isWebhookTrigger = triggerType === 'event' && triggerConfig?.event_type === 'webhook'

  const promptVariables = [
    { key: '{{date}}', description: t('variable_date_desc') || '当前日期' },
    { key: '{{time}}', description: t('variable_time_desc') || '当前时间' },
    { key: '{{datetime}}', description: t('variable_datetime_desc') || '当前日期时间' },
    {
      key: '{{subscription_name}}',
      description: t('variable_subscription_name_desc') || '订阅名称',
    },
    // Show {{inbox_message}} only for inbox_message event triggers
    ...(isInboxMessageTrigger
      ? [
          {
            key: '{{inbox_message}}',
            description: t('variable_inbox_message_desc') || '收件箱消息内容（JSON 格式）',
          },
        ]
      : []),
    // Show {{webhook_data}} only for webhook event triggers
    ...(isWebhookTrigger
      ? [
          {
            key: '{{webhook_data}}',
            description: t('variable_webhook_data_desc') || 'Webhook 数据',
          },
        ]
      : []),
  ]

  const handleInsertPromptVariable = useCallback(
    (variableKey: string) => {
      const textarea = promptTemplateRef.current
      if (!textarea) {
        setPromptTemplate(`${promptTemplate}${variableKey}`)
        setVariablesPopoverOpen(false)
        return
      }

      const currentValue = textarea.value
      const selectionStart = textarea.selectionStart ?? currentValue.length
      const selectionEnd = textarea.selectionEnd ?? currentValue.length
      const nextValue =
        currentValue.slice(0, selectionStart) + variableKey + currentValue.slice(selectionEnd)

      setPromptTemplate(nextValue)
      setVariablesPopoverOpen(false)
      requestAnimationFrame(() => {
        textarea.focus()
        const caretPosition = selectionStart + variableKey.length
        textarea.setSelectionRange(caretPosition, caretPosition)
      })
    },
    [promptTemplate, setPromptTemplate]
  )

  const handleTeamChange = useCallback(
    (value: string) => {
      const newTeamId = parseInt(value)
      setTeamId(newTeamId)
    },
    [setTeamId]
  )

  const selectableDevices = sortDevicesForSelection(availableDevices)
  const hasSelectableDevices = selectableDevices.length > 0

  const handleExecutionTargetTypeChange = useCallback(
    (type: SubscriptionExecutionTargetType | 'device') => {
      if (type === 'managed') {
        setExecutionTarget({ type: 'managed' })
        return
      }

      const preferredDevice = getPreferredDevice(availableDevices)
      if (!preferredDevice) {
        setExecutionTarget({ type: 'local' })
        return
      }

      setExecutionTarget({
        type: preferredDevice.device_type,
        device_id: preferredDevice.device_id,
      })
    },
    [availableDevices, setExecutionTarget]
  )

  const handleExecutionTargetDeviceChange = useCallback(
    (deviceId: string) => {
      const selectedDevice = availableDevices.find(device => device.device_id === deviceId)
      if (!selectedDevice) return

      setExecutionTarget({
        type: selectedDevice.device_type,
        device_id: selectedDevice.device_id,
      })
    },
    [availableDevices, setExecutionTarget]
  )

  // Filter models based on search and compatibility
  const compatibleModels = compatibleProvider
    ? models.filter(model => compatibleProvider.includes(model.provider as CompatibleProvider))
    : models

  const cascadeLabels: ModelCascadeLabels = useMemo(
    () => ({
      ungrouped: t('common:models.ungrouped', 'Ungrouped'),
      uncategorized: t('common:models.uncategorized', 'Uncategorized'),
      searchPlaceholder: t('common:models.search_models', 'Search models or groups...'),
      searchResults: t('common:models.search_results', 'Search results'),
      noModels: t('common:models.no_models', 'No models available'),
      noMatch: t('common:models.no_match', 'No matching models'),
      primaryGroups: t('common:models.primary_groups', 'Primary groups'),
      secondaryGroups: t('common:models.secondary_groups', 'Secondary groups'),
    }),
    [t]
  )
  const defaultModelOption: SpecialModelOption[] = useMemo(
    () => [
      {
        key: '__default__',
        label: t('use_default_model'),
      },
    ],
    [t]
  )

  return (
    <CollapsibleSection
      title={t('send_area') || '任务设置'}
      icon={<Settings className="h-4 w-4 text-primary" />}
      defaultOpen={true}
      primary
    >
      {/* Prompt Template Input */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">
            {t('prompt_template')} <span className="text-destructive">*</span>
          </Label>
          <Popover open={variablesPopoverOpen} onOpenChange={setVariablesPopoverOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs gap-1">
                <Variable className="h-3.5 w-3.5" />
                {t('insert_variable') || '插入变量'}
                <ChevronDown className="h-3 w-3 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[280px] p-2" align="end">
              <div className="space-y-1">
                <p className="text-xs text-text-muted px-2 py-1">
                  {t('prompt_variables_hint') || '点击插入变量到提示词中'}
                </p>
                {promptVariables.map(variable => (
                  <Button
                    key={variable.key}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start h-auto py-2 px-2"
                    onClick={() => handleInsertPromptVariable(variable.key)}
                  >
                    <div className="flex flex-col items-start gap-0.5">
                      <code className="text-xs font-mono text-primary">{variable.key}</code>
                      <span className="text-xs text-text-muted">{variable.description}</span>
                    </div>
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <Textarea
          ref={promptTemplateRef}
          value={promptTemplate}
          onChange={e => setPromptTemplate(e.target.value)}
          placeholder={t('prompt_template_placeholder')}
          rows={4}
          className="resize-none border-border/50 focus:border-primary/50"
        />
      </div>

      {/* Execution Target - 执行位置 */}
      <div className="space-y-2 pt-3 border-t border-border/30">
        <Label className="text-sm font-medium">{t('execution_target_type')}</Label>
        <div className="flex gap-2">
          {(
            [
              ['managed', t('execution_target_type_managed')],
              ['device', t('execution_target_type_device')],
            ] as const
          ).map(([type, label]) => (
            <Button
              key={type}
              type="button"
              variant={
                (type === 'managed' && executionTarget.type === 'managed') ||
                (type === 'device' && executionTarget.type !== 'managed')
                  ? 'primary'
                  : 'outline'
              }
              size="sm"
              className="flex-1"
              onClick={() => handleExecutionTargetTypeChange(type)}
            >
              {label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-text-muted">
          {executionTarget.type === 'managed'
            ? t('execution_target_type_managed_hint')
            : t('execution_target_type_device_hint')}
        </p>

        {executionTarget.type !== 'managed' && (
          <div className="space-y-2 mt-2">
            <Label className="text-sm font-medium">{t('execution_target_device')}</Label>
            <Select
              value={executionTarget.device_id || ''}
              onValueChange={handleExecutionTargetDeviceChange}
              disabled={devicesLoading || !hasSelectableDevices}
            >
              <SelectTrigger className="h-10">
                <SelectValue
                  placeholder={
                    devicesLoading
                      ? t('execution_target_loading_devices')
                      : t('execution_target_select_device')
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {selectableDevices.map(device => (
                  <SelectItem key={device.device_id} value={device.device_id}>
                    {device.name}
                    {device.is_default ? ` · ${t('default')}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!hasSelectableDevices && !devicesLoading && (
              <p className="text-xs text-destructive">{t('execution_target_no_devices')}</p>
            )}
          </div>
        )}
      </div>

      {/* Agent and Skill Selection */}
      <div className="space-y-3 pt-3 border-t border-border/30">
        {/* Row 1: Team/Agent and Model */}
        <div className="grid grid-cols-2 gap-3">
          {/* Team/Agent Selection */}
          <div className="space-y-1.5">
            <Label className="text-xs text-text-muted">{t('select_team_label') || '智能体'}</Label>
            <Select
              value={teamId?.toString() || ''}
              onValueChange={handleTeamChange}
              disabled={teamsLoading}
            >
              <SelectTrigger className="h-9 border-border/50">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-text-muted" />
                  <SelectValue placeholder={t('select_team_placeholder')} />
                </div>
              </SelectTrigger>
              <SelectContent>
                {teams.map(team => (
                  <SelectItem key={team.id} value={team.id.toString()}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Model Selection */}
          <div className="space-y-1.5">
            <Label className="text-xs text-text-muted">{t('select_model_label') || '模型'}</Label>
            <GroupedModelSelect
              models={compatibleModels}
              selectedModel={selectedModel}
              selectedSpecialKey={selectedModel ? null : '__default__'}
              specialOptions={defaultModelOption}
              labels={cascadeLabels}
              onSelectModel={setSelectedModel}
              onSelectSpecialOption={() => setSelectedModel(null)}
              placeholder={modelsLoading ? t('common:loading') : t('select_model_placeholder')}
              disabled={modelsLoading}
              dataTestId="subscription-model-select"
              triggerClassName="h-9 border-border/50"
              getModelKey={model => `${model.type || ''}-${model.name}`}
              renderModelBadges={model =>
                model.type ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-text-muted">
                    {model.type}
                  </span>
                ) : null
              }
              renderModelMeta={model =>
                model.provider || model.modelId ? (
                  <span className="block truncate text-xs text-text-muted">
                    {[model.provider, model.modelId].filter(Boolean).join(' · ')}
                  </span>
                ) : null
              }
            />
            {modelRequired && !selectedModel && (
              <p className="text-xs text-destructive">{t('select_model_required')}</p>
            )}
          </div>
        </div>

        {/* Row 2: Skills and Knowledge Base */}
        <div className="grid grid-cols-2 gap-3">
          {/* Skills Selection */}
          <div className="space-y-1.5">
            <Label className="text-xs text-text-muted">{t('select_skills_label') || '技能'}</Label>
            {/* Selected Skills - displayed above selector */}
            {skillRefs.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {skillRefs.map(skill => (
                  <Badge
                    key={`skill-${skill.namespace}/${skill.name}`}
                    variant="secondary"
                    className="h-6 flex items-center gap-1 pl-1.5 pr-0.5"
                  >
                    <Sparkles className="h-3 w-3 text-amber-500" />
                    <span className="text-xs">{skill.name}</span>
                    {!isRental && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-4 w-4 p-0 hover:bg-transparent"
                        onClick={() => {
                          setSkillRefs(prev =>
                            prev.filter(
                              s => !(s.name === skill.name && s.namespace === skill.namespace)
                            )
                          )
                        }}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </Badge>
                ))}
              </div>
            )}
            {/* Skill Selector */}
            {skillsLoading ? (
              <div className="h-9 flex items-center px-3 rounded-md border border-border/50 bg-background">
                <span className="text-xs text-text-muted">{t('common:loading')}</span>
              </div>
            ) : (
              <RichSkillSelector
                skills={availableSkills}
                selectedSkillNames={skillRefs.map(s => s.name)}
                onSelectSkill={skill => {
                  if (skill && !skillRefs.some(s => s.name === skill.name)) {
                    setSkillRefs(prev => [
                      ...prev,
                      {
                        name: skill.name,
                        namespace: skill.namespace || 'default',
                        is_public: skill.is_public || false,
                      },
                    ])
                  }
                }}
                disabled={isRental}
              />
            )}
          </div>

          {/* Knowledge Base Selection */}
          <div className="space-y-1.5">
            <Label className="text-xs text-text-muted">
              {t('select_knowledge_base_label') || '知识库'}
            </Label>
            {/* Selected Knowledge Bases - displayed above selector */}
            {knowledgeBaseRefs.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {knowledgeBaseRefs.map(kb => (
                  <Badge
                    key={`kb-${kb.namespace}/${kb.name}`}
                    variant="secondary"
                    className="h-6 flex items-center gap-1 pl-1.5 pr-0.5 bg-primary/5 border border-primary/20"
                  >
                    <Database className="h-3 w-3 text-primary" />
                    <span className="text-xs">{kb.name}</span>
                    {!isRental && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-4 w-4 p-0 hover:bg-transparent"
                        onClick={() => {
                          const filtered = knowledgeBaseRefs.filter(
                            k => !(k.name === kb.name && k.namespace === kb.namespace)
                          )
                          setKnowledgeBaseRefs(filtered)
                        }}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </Badge>
                ))}
              </div>
            )}
            {/* Knowledge Base Selector - using same style as RichSkillSelector */}
            <RichKnowledgeBaseSelector
              selectedKnowledgeBases={knowledgeBaseRefs}
              onSelectKnowledgeBase={kb => {
                if (
                  !knowledgeBaseRefs.some(k => k.name === kb.name && k.namespace === kb.namespace)
                ) {
                  setKnowledgeBaseRefs([...knowledgeBaseRefs, kb])
                }
              }}
              disabled={isRental}
            />
          </div>
        </div>
      </div>

      {/* Model required hint */}
      {modelRequired && <p className="text-xs text-destructive">{t('model_required_hint')}</p>}

      {/* Preserve History */}
      <div className="space-y-3 pt-2 border-t border-border/30">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label className="text-sm font-medium">{t('preserve_history')}</Label>
            <p className="text-xs text-text-muted">{t('preserve_history_hint')}</p>
          </div>
          <Switch checked={preserveHistory} onCheckedChange={setPreserveHistory} />
        </div>

        {/* History Message Count - only show when preserve history is enabled */}
        {preserveHistory && (
          <div className="flex items-center gap-3 pl-4 border-l-2 border-primary/30">
            <Label className="text-sm text-text-muted whitespace-nowrap">
              {t('history_message_count')}
            </Label>
            <Input
              type="number"
              min={1}
              max={50}
              value={historyMessageCount}
              onChange={e => {
                const value = parseInt(e.target.value) || 10
                setHistoryMessageCount(Math.min(50, Math.max(1, value)))
              }}
              className="w-20 h-8 text-center"
            />
            <span className="text-xs text-text-muted">{t('history_message_count_hint')}</span>
          </div>
        )}
      </div>
    </CollapsibleSection>
  )
}
