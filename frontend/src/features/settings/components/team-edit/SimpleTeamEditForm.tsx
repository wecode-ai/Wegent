// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { HelpCircle } from 'lucide-react'

import type { SkillRefMeta } from '@/apis/bots'
import type { ModelTypeEnum, UnifiedModel } from '@/apis/models'
import type { UnifiedShell } from '@/apis/shells'
import type { UnifiedSkill } from '@/apis/skills'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeBaseDefaultRef, TaskType } from '@/types/api'

import { TeamIconPicker } from '../teams/TeamIconPicker'
import ExecutorModeSelector from './ExecutorModeSelector'
import SimpleBotCoreConfigForm from './SimpleBotCoreConfigForm'
import TeamBindModeCards from './TeamBindModeCards'
import type { SimpleExecutorMode } from './simple-team-edit-utils'

interface SimpleTeamEditFormProps {
  name: string
  setName: (value: string) => void
  displayName: string
  setDisplayName: (value: string) => void
  description: string
  setDescription: (value: string) => void
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
  availableSkills: UnifiedSkill[]
  allSkills: UnifiedSkill[]
  loadingSkills: boolean
  onSkillsChange: (skills: string[], refs: Record<string, SkillRefMeta>) => void
  onReloadSkills: () => void
  defaultKnowledgeBaseRefs: KnowledgeBaseDefaultRef[]
  onDefaultKnowledgeBaseRefsChange: (value: KnowledgeBaseDefaultRef[]) => void
  prompt: string
  onPromptChange: (value: string) => void
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
}

export default function SimpleTeamEditForm({
  name,
  setName,
  displayName,
  setDisplayName,
  description,
  setDescription,
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
  availableSkills,
  allSkills,
  loadingSkills,
  onSkillsChange,
  onReloadSkills,
  defaultKnowledgeBaseRefs,
  onDefaultKnowledgeBaseRefsChange,
  prompt,
  onPromptChange,
  scope,
  groupName,
}: SimpleTeamEditFormProps) {
  const { t } = useTranslation()
  const showRequiresWorkspace = bindMode.includes('code')

  return (
    <div className="space-y-5">
      <section className="space-y-4 rounded-md border border-border bg-surface p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="teamName" className="text-sm font-medium text-text-primary">
              {t('common:team.name')} <span className="text-red-400">*</span>
            </Label>
            <div className="flex items-center gap-2">
              <TeamIconPicker value={icon} onChange={setIcon} />
              <Input
                id="teamName"
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder={t('common:team.name_placeholder')}
                className="bg-base"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="teamDisplayName" className="text-sm font-medium text-text-primary">
              {t('common:team.display_name')}
            </Label>
            <Input
              id="teamDisplayName"
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              placeholder={t('common:team.display_name_placeholder')}
              className="bg-base"
              data-testid="team-display-name-input"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="teamDescription" className="text-sm font-medium text-text-primary">
            {t('common:team.description')}
          </Label>
          <Input
            id="teamDescription"
            value={description}
            onChange={event => setDescription(event.target.value)}
            placeholder={t('common:team.description_placeholder')}
            className="bg-base"
          />
        </div>
      </section>

      <section className="space-y-4 rounded-md border border-border bg-surface p-4">
        <TeamBindModeCards value={bindMode} onChange={setBindMode} />

        {showRequiresWorkspace && (
          <div className="flex items-center justify-between rounded-md border border-border bg-base px-3 py-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="requiresWorkspace" className="text-sm font-medium text-text-primary">
                {t('common:team.requires_workspace')}
              </Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-4 w-4 cursor-help text-text-muted" />
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="text-xs">{t('common:team.requires_workspace_hint')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Switch
              id="requiresWorkspace"
              checked={requiresWorkspace === true}
              onCheckedChange={checked => setRequiresWorkspace(checked)}
            />
          </div>
        )}

        <ExecutorModeSelector
          value={executorMode}
          onChange={setExecutorMode}
          shells={shells}
          customShellName={customShellName}
          onCustomShellChange={setCustomShellName}
          disabledModes={disabledExecutorModes}
          helperText={executorHelperText}
        />
      </section>

      <section className="rounded-md border border-border bg-surface p-4">
        <SimpleBotCoreConfigForm
          modelName={modelName}
          modelType={modelType}
          modelNamespace={modelNamespace}
          models={models}
          loadingModels={loadingModels}
          onModelChange={onModelChange}
          selectedSkills={selectedSkills}
          selectedSkillRefs={selectedSkillRefs}
          availableSkills={availableSkills}
          allSkills={allSkills}
          loadingSkills={loadingSkills}
          onSkillsChange={onSkillsChange}
          onReloadSkills={onReloadSkills}
          defaultKnowledgeBaseRefs={defaultKnowledgeBaseRefs}
          onDefaultKnowledgeBaseRefsChange={onDefaultKnowledgeBaseRefsChange}
          prompt={prompt}
          onPromptChange={onPromptChange}
          scope={scope}
          groupName={groupName}
        />
      </section>
    </div>
  )
}
