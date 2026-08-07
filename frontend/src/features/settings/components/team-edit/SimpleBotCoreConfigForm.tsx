// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import { SettingsIcon, Wand2, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  GroupedModelSelect,
  type ModelCascadeLabels,
  type SpecialModelOption,
} from '@/components/model-select/ModelCascadeSelect'
import { Textarea } from '@/components/ui/textarea'
import type { SkillRefMeta } from '@/apis/bots'
import type { ModelTypeEnum, UnifiedModel } from '@/apis/models'
import type { UnifiedSkill } from '@/apis/skills'
import PromptFineTuneDialog from '@/features/prompt-tune/components/PromptFineTuneDialog'
import { AgentDefaultKnowledgeScopeSelector } from '@/features/settings/components/knowledge/AgentDefaultKnowledgeScopeSelector'
import SkillManagementModal from '@/features/settings/components/skills/SkillManagementModal'
import { RichSkillSelector } from '@/features/settings/components/skills/RichSkillSelector'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeBaseDefaultRef } from '@/types/api'
import type { ExternalKnowledgeRef } from '@/types/context'
import { SimpleConfigGroup, SimpleConfigRow } from './SimpleConfigLayout'
import { parseModelSelectValue, toModelSelectValue } from './model-select-utils'

interface SimpleBotCoreConfigFormProps {
  modelName: string
  modelType?: ModelTypeEnum
  modelNamespace?: string
  models: UnifiedModel[]
  loadingModels: boolean
  onModelChange: (value: { name: string; type?: ModelTypeEnum; namespace?: string }) => void
  selectedSkills: string[]
  selectedSkillRefs: Record<string, SkillRefMeta>
  availableSkills: UnifiedSkill[]
  allSkills: UnifiedSkill[]
  loadingSkills: boolean
  onSkillsChange: (skills: string[], refs: Record<string, SkillRefMeta>) => void
  onReloadSkills: () => void
  defaultKnowledgeBaseRefs: KnowledgeBaseDefaultRef[]
  onDefaultKnowledgeBaseRefsChange: (value: KnowledgeBaseDefaultRef[]) => void
  defaultExternalKnowledgeRefs: ExternalKnowledgeRef[]
  onDefaultExternalKnowledgeRefsChange: (value: ExternalKnowledgeRef[]) => void
  prompt: string
  onPromptChange: (value: string) => void
  scope?: 'personal' | 'group' | 'all' | 'public'
  groupName?: string
}

export default function SimpleBotCoreConfigForm({
  modelName,
  modelType,
  modelNamespace,
  models,
  loadingModels,
  onModelChange,
  selectedSkills,
  selectedSkillRefs,
  availableSkills,
  allSkills,
  loadingSkills,
  onSkillsChange,
  onReloadSkills,
  defaultKnowledgeBaseRefs,
  onDefaultKnowledgeBaseRefsChange,
  defaultExternalKnowledgeRefs,
  onDefaultExternalKnowledgeRefsChange,
  prompt,
  onPromptChange,
  scope,
  groupName,
}: SimpleBotCoreConfigFormProps) {
  const { t } = useTranslation()
  const [skillManagementModalOpen, setSkillManagementModalOpen] = useState(false)
  const [promptFineTuneOpen, setPromptFineTuneOpen] = useState(false)

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
    <section className="space-y-4">
      <SimpleConfigGroup>
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
                  return (
                    <span
                      key={skillName}
                      className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-1 text-sm"
                    >
                      {skill?.displayName || skillName}
                      <button
                        type="button"
                        className="text-text-muted hover:text-text-primary"
                        onClick={() => {
                          const nextRefs = { ...selectedSkillRefs }
                          delete nextRefs[skillName]
                          onSkillsChange(
                            selectedSkills.filter(name => name !== skillName),
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
          </div>
        </SimpleConfigRow>

        <SimpleConfigRow
          label={t('settings:team.simple.core.default_knowledge_scope.label')}
          description={t('settings:team.simple.core.default_knowledge_scope.description')}
        >
          <AgentDefaultKnowledgeScopeSelector
            defaultKnowledgeBaseRefs={defaultKnowledgeBaseRefs}
            onDefaultKnowledgeBaseRefsChange={onDefaultKnowledgeBaseRefsChange}
            defaultExternalKnowledgeRefs={defaultExternalKnowledgeRefs}
            onDefaultExternalKnowledgeRefsChange={onDefaultExternalKnowledgeRefsChange}
            allowedSources={
              scope === 'public' ? ['organization'] : ['personal', 'group', 'organization']
            }
            allowExternalKnowledge={scope !== 'public'}
          />
        </SimpleConfigRow>
      </SimpleConfigGroup>

      <SimpleConfigGroup>
        <SimpleConfigRow
          label={t('common:bot.prompt')}
          description={t('settings:team.simple.core.prompt_description')}
          align="start"
        >
          <div className="space-y-2">
            <div className="flex justify-end">
              {prompt.trim() && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
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
        </SimpleConfigRow>
      </SimpleConfigGroup>

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
    </section>
  )
}
