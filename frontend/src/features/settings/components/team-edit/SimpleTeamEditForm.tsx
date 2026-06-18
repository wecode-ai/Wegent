// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { type ReactNode, useId, useMemo, useState } from 'react'
import { ChevronDown, Database, Plus, SettingsIcon, Wand2, XIcon } from 'lucide-react'

import type { SkillRefMeta } from '@/apis/bots'
import type { ModelTypeEnum, UnifiedModel } from '@/apis/models'
import type { UnifiedShell } from '@/apis/shells'
import type { UnifiedSkill } from '@/apis/skills'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  GroupedModelSelect,
  type ModelCascadeLabels,
  type SpecialModelOption,
} from '@/components/model-select/ModelCascadeSelect'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import PromptFineTuneDialog from '@/features/prompt-tune/components/PromptFineTuneDialog'
import McpConfigSection from '@/features/settings/components/McpConfigSection'
import SkillManagementModal from '@/features/settings/components/skills/SkillManagementModal'
import { RichSkillSelector } from '@/features/settings/components/skills/RichSkillSelector'
import type { AgentType as McpAgentType } from '@/features/settings/utils/mcpTypeAdapter'
import ContextSelector from '@/features/tasks/components/chat/ContextSelector'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ContextItem, ContextType } from '@/types/context'
import type { DefaultContextRef } from '@/types/default-context'
import type { KnowledgeBaseDefaultRef, TaskType } from '@/types/api'
import {
  contextItemsToDefaultContextRefs,
  defaultContextRefsToContextItems,
} from '@/features/context-selector/adapters/defaultContextAdapters'
import { getRuntimeConfigSync } from '@/lib/runtime-config'

import { TeamIconPicker } from '../teams/TeamIconPicker'
import ExecutorModeSelector from './ExecutorModeSelector'
import { SimpleConfigGroup, SimpleConfigRow } from './SimpleConfigLayout'
import QuickPhraseEditor from './QuickPhraseEditor'
import TeamBindModeCards from './TeamBindModeCards'
import { parseModelSelectValue, toModelSelectValue } from './model-select-utils'
import type { SimpleExecutorMode } from './simple-team-edit-utils'

function getDefaultContextAllowedTypes(): ContextType[] {
  return getRuntimeConfigSync().enableDingTalkContext
    ? ['knowledge_base', 'external_document']
    : ['knowledge_base']
}

function filterDefaultContextItems(items: ContextItem[]): ContextItem[] {
  const allowedTypes = getDefaultContextAllowedTypes()
  const seen = new Set<string>()
  const filtered: ContextItem[] = []

  for (const item of items) {
    if (!allowedTypes.includes(item.type)) {
      continue
    }

    const key = `${item.type}:${item.id}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    filtered.push(item)
  }

  return filtered
}

interface SimpleTeamEditFormProps {
  name: string
  setName: (value: string) => void
  displayName: string
  setDisplayName: (value: string) => void
  description: string
  setDescription: (value: string) => void
  quickPhrases: string[]
  onQuickPhrasesChange: (value: string[]) => void
  bindMode: TaskType[]
  setBindMode: (value: TaskType[]) => void
  icon: string | null
  setIcon: (value: string) => void
  requiresWorkspace: boolean | null
  setRequiresWorkspace: (value: boolean | null) => void
  executorMode: SimpleExecutorMode
  setExecutorMode: (value: SimpleExecutorMode) => void
  shells: UnifiedShell[]
  customShellName: string
  setCustomShellName: (value: string) => void
  executorHelperText?: string | null
  disabledExecutorModes?: SimpleExecutorMode[]
  modelName: string
  modelType?: ModelTypeEnum
  modelNamespace?: string
  models: UnifiedModel[]
  loadingModels: boolean
  onModelChange: (value: { name: string; type?: ModelTypeEnum; namespace?: string }) => void
  selectedSkills: string[]
  selectedSkillRefs: Record<string, SkillRefMeta>
  preloadSkills: string[]
  onPreloadSkillsChange: (skills: string[]) => void
  supportsPreloadSkills: boolean
  availableSkills: UnifiedSkill[]
  allSkills: UnifiedSkill[]
  loadingSkills: boolean
  onSkillsChange: (skills: string[], refs: Record<string, SkillRefMeta>) => void
  onReloadSkills: () => void
  defaultContextRefs: DefaultContextRef[]
  onDefaultContextRefsChange: (value: DefaultContextRef[]) => void
  defaultKnowledgeBaseRefs: KnowledgeBaseDefaultRef[]
  onDefaultKnowledgeBaseRefsChange: (value: KnowledgeBaseDefaultRef[]) => void
  mcpConfig: string
  onMcpConfigChange: (value: string) => void
  mcpAgentType?: McpAgentType
  prompt: string
  onPromptChange: (value: string) => void
  toast: ReturnType<typeof import('@/hooks/use-toast').useToast>['toast']
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
}

function SimpleSection({
  title,
  sectionId,
  children,
}: {
  title: string
  sectionId: string
  children: ReactNode
}) {
  const [isExpanded, setIsExpanded] = useState(true)
  const contentId = useId()

  return (
    <section className="space-y-4">
      <button
        type="button"
        aria-controls={contentId}
        aria-expanded={isExpanded}
        data-testid={`simple-section-${sectionId}-trigger`}
        onClick={() => setIsExpanded(current => !current)}
        className="group flex w-full items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <h3 className="shrink-0 text-sm font-semibold text-text-primary">{title}</h3>
        <div className="h-px flex-1 bg-border transition-colors group-hover:bg-primary/40" />
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-text-muted transition-transform duration-200',
            !isExpanded && '-rotate-90'
          )}
        />
      </button>
      {isExpanded && (
        <div id={contentId} className="space-y-4">
          {children}
        </div>
      )}
    </section>
  )
}

export default function SimpleTeamEditForm({
  name,
  setName,
  displayName,
  setDisplayName,
  description,
  setDescription,
  quickPhrases,
  onQuickPhrasesChange,
  bindMode,
  setBindMode,
  icon,
  setIcon,
  requiresWorkspace,
  setRequiresWorkspace,
  executorMode,
  setExecutorMode,
  shells,
  customShellName,
  setCustomShellName,
  executorHelperText,
  disabledExecutorModes,
  modelName,
  modelType,
  modelNamespace,
  models,
  loadingModels,
  onModelChange,
  selectedSkills,
  selectedSkillRefs,
  preloadSkills,
  onPreloadSkillsChange,
  supportsPreloadSkills,
  availableSkills,
  allSkills,
  loadingSkills,
  onSkillsChange,
  onReloadSkills,
  defaultContextRefs,
  onDefaultContextRefsChange,
  mcpConfig,
  onMcpConfigChange,
  mcpAgentType,
  prompt,
  onPromptChange,
  toast,
  scope,
  groupName,
}: SimpleTeamEditFormProps) {
  const { t } = useTranslation()
  const [skillManagementModalOpen, setSkillManagementModalOpen] = useState(false)
  const [promptFineTuneOpen, setPromptFineTuneOpen] = useState(false)
  const [defaultContextsOpen, setDefaultContextsOpen] = useState(false)
  const defaultContextItems = useMemo(
    () => filterDefaultContextItems(defaultContextRefsToContextItems(defaultContextRefs)),
    [defaultContextRefs]
  )
  const updateDefaultContextItems = (items: ContextItem[]) => {
    onDefaultContextRefsChange(contextItemsToDefaultContextRefs(filterDefaultContextItems(items)))
  }
  const showRequiresWorkspace = bindMode.includes('code')
  const modelSelectValue = toModelSelectValue(modelName, modelType, modelNamespace)
  const selectedModel = useMemo(
    () =>
      models.find(
        model => toModelSelectValue(model.name, model.type, model.namespace) === modelSelectValue
      ) ?? null,
    [modelSelectValue, models]
  )
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
  const noModelOption: SpecialModelOption[] = useMemo(
    () => [
      {
        key: '__none__',
        label: t('common:bot.no_model_binding'),
      },
    ],
    [t]
  )
  const togglePreloadSkill = (skillName: string, checked: boolean) => {
    if (checked) {
      onPreloadSkillsChange(Array.from(new Set([...preloadSkills, skillName])))
      return
    }

    onPreloadSkillsChange(preloadSkills.filter(item => item !== skillName))
  }

  const selectedSkillItems = useMemo(
    () =>
      selectedSkills.map(skillName => {
        const ref = selectedSkillRefs[skillName]
        return (
          allSkills.find(skill => skill.id === ref?.skill_id) ||
          allSkills.find(skill => skill.name === skillName)
        )
      }),
    [allSkills, selectedSkillRefs, selectedSkills]
  )

  return (
    <div className="space-y-5">
      <SimpleSection title={t('settings:team.simple.sections.basic')} sectionId="basic">
        <SimpleConfigGroup>
          <SimpleConfigRow
            label={
              <>
                {t('common:team.name')} <span className="text-red-400">*</span>
              </>
            }
          >
            <div className="flex items-center gap-2">
              <TeamIconPicker value={icon} onChange={setIcon} />
              <Input
                id="teamName"
                aria-label={t('common:team.name')}
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder={t('common:team.name_placeholder')}
                className="bg-base"
              />
            </div>
          </SimpleConfigRow>

          <SimpleConfigRow label={t('common:team.display_name')}>
            <Input
              id="teamDisplayName"
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              placeholder={t('common:team.display_name_placeholder')}
              className="bg-base"
              data-testid="team-display-name-input"
            />
          </SimpleConfigRow>

          <SimpleConfigRow label={t('common:team.description')}>
            <Input
              id="teamDescription"
              value={description}
              onChange={event => setDescription(event.target.value)}
              placeholder={t('common:team.description_placeholder')}
              className="bg-base"
            />
          </SimpleConfigRow>

          <SimpleConfigRow
            label={t('settings:team.quick_phrases.label')}
            description={t('settings:team.quick_phrases.description')}
            align="start"
          >
            <QuickPhraseEditor value={quickPhrases} onChange={onQuickPhrasesChange} />
          </SimpleConfigRow>

          <SimpleConfigRow
            label={t('common:bot.agent_config')}
            description={t('settings:team.simple.core.model_description')}
          >
            <GroupedModelSelect
              models={models}
              selectedModel={selectedModel}
              selectedSpecialKey={selectedModel ? null : '__none__'}
              specialOptions={noModelOption}
              labels={cascadeLabels}
              onSelectModel={model =>
                onModelChange({
                  name: model.name,
                  type: model.type,
                  namespace: model.namespace || 'default',
                })
              }
              onSelectSpecialOption={value => onModelChange(parseModelSelectValue(value))}
              placeholder={t('common:bot.model_select')}
              disabled={loadingModels}
              dataTestId="simple-model-select"
              triggerClassName="h-9 rounded-md bg-base"
              getModelKey={model => `${model.name}:${model.type}:${model.namespace || 'default'}`}
            />
          </SimpleConfigRow>
        </SimpleConfigGroup>
      </SimpleSection>

      <SimpleSection title={t('settings:team.simple.sections.execution')} sectionId="execution">
        <SimpleConfigGroup>
          <SimpleConfigRow
            label={t('common:team.bind_mode')}
            description={t('settings:team.simple.execution.bind_mode_description')}
            align="start"
          >
            <TeamBindModeCards value={bindMode} onChange={setBindMode} />
          </SimpleConfigRow>

          {showRequiresWorkspace && (
            <SimpleConfigRow
              label={t('common:team.requires_workspace')}
              description={t('settings:team.simple.execution.requires_workspace_description')}
            >
              <div className="flex justify-end">
                <Switch
                  id="requiresWorkspace"
                  checked={requiresWorkspace === true}
                  onCheckedChange={checked => setRequiresWorkspace(checked)}
                />
              </div>
            </SimpleConfigRow>
          )}

          <SimpleConfigRow
            label={t('settings:team.simple.executor.title')}
            description={t('settings:team.simple.execution.executor_description')}
            align="start"
          >
            <ExecutorModeSelector
              value={executorMode}
              onChange={setExecutorMode}
              shells={shells}
              customShellName={customShellName}
              onCustomShellChange={setCustomShellName}
              disabledModes={disabledExecutorModes}
              helperText={executorHelperText}
              hideLabel
            />
          </SimpleConfigRow>
        </SimpleConfigGroup>
      </SimpleSection>

      <SimpleSection title={t('settings:team.simple.sections.prompt')} sectionId="prompt">
        <SimpleConfigGroup>
          <div className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs leading-5 text-text-muted">
                {t('settings:team.simple.core.prompt_description')}
              </p>
              {prompt.trim() && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0 self-start sm:self-auto"
                  onClick={() => setPromptFineTuneOpen(true)}
                >
                  <Wand2 className="mr-1 h-3.5 w-3.5" />
                  {t('common:bot.fine_tune_prompt')}
                </Button>
              )}
            </div>
            <Textarea
              value={prompt}
              onChange={event => onPromptChange(event.target.value)}
              placeholder={t('common:bot.prompt_placeholder')}
              className="min-h-[120px] resize-y bg-base text-sm"
              data-testid="simple-prompt-textarea"
            />
          </div>
        </SimpleConfigGroup>
      </SimpleSection>

      <SimpleSection title={t('settings:team.simple.sections.capability')} sectionId="capability">
        <SimpleConfigGroup>
          <SimpleConfigRow
            label={t('common:skills.skills_section')}
            description={t('settings:team.simple.core.skills_description')}
            align="start"
          >
            <div className="space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="min-w-0 flex-1">
                  {loadingSkills ? (
                    <div className="flex h-9 items-center rounded-md border border-border bg-base px-3 text-sm text-text-muted">
                      {t('common:skills.loading_skills')}
                    </div>
                  ) : (
                    <RichSkillSelector
                      skills={availableSkills}
                      selectedSkillNames={selectedSkills}
                      onSelectSkill={skill => {
                        if (!skill || selectedSkills.includes(skill.name)) return
                        onSkillsChange([...selectedSkills, skill.name], {
                          ...selectedSkillRefs,
                          [skill.name]: {
                            skill_id: skill.id,
                            namespace: skill.namespace || 'default',
                            is_public: skill.is_public || false,
                          },
                        })
                      }}
                      placeholder={t('common:skills.select_skill_to_add')}
                    />
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => setSkillManagementModalOpen(true)}
                  data-testid="simple-manage-skills-button"
                >
                  <SettingsIcon className="mr-1 h-3.5 w-3.5" />
                  {t('common:skills.manage_skills_button')}
                </Button>
              </div>
              {selectedSkills.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {selectedSkills.map((skillName, index) => {
                    const skill = selectedSkillItems[index]
                    const skillDisplayName = skill?.displayName || skillName
                    const isPreloaded = preloadSkills.includes(skillName)
                    return (
                      <span
                        key={skillName}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm',
                          supportsPreloadSkills && isPreloaded
                            ? 'bg-primary/10 text-primary'
                            : 'bg-surface text-text-primary'
                        )}
                      >
                        {supportsPreloadSkills && (
                          <Checkbox
                            checked={isPreloaded}
                            onCheckedChange={checked =>
                              togglePreloadSkill(skillName, checked === true)
                            }
                            title={t('common:skills.preload_skills_section')}
                            aria-label={`${skillDisplayName} ${t('common:skills.preload_skills_section')}`}
                            data-testid={`simple-skill-preload-${skillName}`}
                            className="h-3.5 w-3.5"
                          />
                        )}
                        <span>{skillDisplayName}</span>
                        <button
                          type="button"
                          className="text-text-muted hover:text-text-primary"
                          onClick={() => {
                            const nextRefs = { ...selectedSkillRefs }
                            delete nextRefs[skillName]
                            onPreloadSkillsChange(preloadSkills.filter(item => item !== skillName))
                            onSkillsChange(
                              selectedSkills.filter(item => item !== skillName),
                              nextRefs
                            )
                          }}
                          aria-label={t('common:actions.remove')}
                        >
                          <XIcon className="h-3 w-3" />
                        </button>
                      </span>
                    )
                  })}
                </div>
              )}
              {supportsPreloadSkills && selectedSkills.length > 0 && (
                <p className="text-xs leading-5 text-text-muted">
                  {t('common:skills.preload_hint')}
                </p>
              )}
            </div>
          </SimpleConfigRow>

          <SimpleConfigRow
            label={t('common:bot.default_knowledge_bases')}
            description={t('settings:team.simple.core.knowledge_description')}
          >
            <div className="space-y-2">
              <ContextSelector
                open={defaultContextsOpen}
                onOpenChange={setDefaultContextsOpen}
                selectedContexts={defaultContextItems}
                allowedContextTypes={getDefaultContextAllowedTypes()}
                allowedKnowledgeBaseSources={
                  scope === 'group'
                    ? groupName
                      ? ['group', 'organization']
                      : ['organization']
                    : ['personal', 'group', 'organization']
                }
                allowedGroupNamespaces={scope === 'group' && groupName ? [groupName] : undefined}
                onSelect={context =>
                  updateDefaultContextItems(
                    defaultContextItems.some(
                      item => item.type === context.type && item.id === context.id
                    )
                      ? defaultContextItems
                      : [...defaultContextItems, context]
                  )
                }
                onDeselect={id =>
                  updateDefaultContextItems(defaultContextItems.filter(item => item.id !== id))
                }
                onSelectMultiple={contexts => {
                  const existingKeys = new Set(
                    defaultContextItems.map(item => `${item.type}:${item.id}`)
                  )
                  updateDefaultContextItems([
                    ...defaultContextItems,
                    ...contexts.filter(
                      context => !existingKeys.has(`${context.type}:${context.id}`)
                    ),
                  ])
                }}
                onDeselectMultiple={ids =>
                  updateDefaultContextItems(
                    defaultContextItems.filter(item => !ids.includes(item.id))
                  )
                }
              >
                <button
                  type="button"
                  className="flex h-9 w-full items-center justify-between rounded-md border border-border/50 bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="simple-default-context-add-button"
                >
                  <div className="flex items-center gap-2 text-text-muted">
                    <Database className="h-4 w-4 text-primary" />
                    <span>{t('common:bot.default_knowledge_bases_select_to_add')}</span>
                  </div>
                  <Plus className="h-4 w-4 opacity-50" />
                </button>
              </ContextSelector>
              <div className="flex flex-wrap gap-1.5">
                {defaultContextItems.map(context => (
                  <span
                    key={`${context.type}:${context.id}`}
                    className="inline-flex items-center gap-1 rounded-md bg-muted px-2.5 py-1.5 text-sm text-text-primary"
                  >
                    <span className="max-w-[180px] truncate">{context.name}</span>
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 items-center justify-center text-text-muted hover:text-text-primary"
                      data-testid={`simple-default-context-remove-${context.type}-${context.id}`}
                      onClick={() =>
                        updateDefaultContextItems(
                          defaultContextItems.filter(
                            item => item.type !== context.type || item.id !== context.id
                          )
                        )
                      }
                      aria-label={t('common:actions.delete')}
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          </SimpleConfigRow>

          <SimpleConfigRow
            label={t('common:bot.mcp_config')}
            description={t('settings:team.simple.core.mcp_description')}
            align="start"
          >
            <McpConfigSection
              mcpConfig={mcpConfig}
              onMcpConfigChange={onMcpConfigChange}
              agentType={mcpAgentType}
              toast={toast}
              hideHeaderLabel
              compact
            />
          </SimpleConfigRow>
        </SimpleConfigGroup>
      </SimpleSection>

      <SkillManagementModal
        open={skillManagementModalOpen}
        onClose={() => setSkillManagementModalOpen(false)}
        scope={scope}
        groupName={groupName}
        onSkillsChange={onReloadSkills}
      />
      <PromptFineTuneDialog
        open={promptFineTuneOpen}
        onOpenChange={setPromptFineTuneOpen}
        initialPrompt={prompt}
        onSave={onPromptChange}
        modelName={modelName}
      />
    </div>
  )
}
