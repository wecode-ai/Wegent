import { ArrowUp, Mic } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SkillRef, UnifiedModel, UnifiedSkill } from '@/types/api'
import { AddContextMenu } from './AddContextMenu'
import { ModelSelector } from './ModelSelector'
import { SkillSelector } from './SkillSelector'

interface ComposerToolbarProps {
  canSend: boolean
  models: UnifiedModel[]
  skills: UnifiedSkill[]
  selectedModel: UnifiedModel | null
  selectedSkills: SkillRef[]
  optionsLocked: boolean
  onSelectModel: (model: UnifiedModel | null) => void
  onToggleSkill: (skill: SkillRef) => void
  onFileSelect: (files: File | File[]) => void
}

export function ComposerToolbar({
  canSend,
  models,
  skills,
  selectedModel,
  selectedSkills,
  optionsLocked,
  onSelectModel,
  onToggleSkill,
  onFileSelect,
}: ComposerToolbarProps) {
  const { t } = useTranslation('common')

  return (
    <div className="mt-auto flex min-h-9 items-center justify-between gap-4">
      <div className="-ml-2 flex min-w-0 items-center gap-2">
        <AddContextMenu disabled={false} onFileSelect={onFileSelect} />
        <SkillSelector
          skills={skills}
          selectedSkills={selectedSkills}
          disabled={optionsLocked}
          onToggleSkill={onToggleSkill}
        />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ModelSelector
          models={models}
          selectedModel={selectedModel}
          disabled={optionsLocked}
          onSelectModel={onSelectModel}
        />
        <button
          type="button"
          data-testid="voice-input-button"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full p-0 text-text-secondary hover:bg-muted"
          aria-label={t('workbench.voice_input', '语音输入')}
        >
          <Mic className="h-5 w-5" />
        </button>
        <button
          type="submit"
          data-testid="send-message-button"
          disabled={!canSend}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a] p-0 text-white disabled:cursor-not-allowed disabled:bg-[#d9d9d9]"
          aria-label={t('workbench.send_message', '发送消息')}
        >
          <ArrowUp className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}
