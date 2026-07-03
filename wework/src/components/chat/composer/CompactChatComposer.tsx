import {
  ArrowUp,
  Camera,
  ClipboardList,
  Image,
  Maximize2,
  Minimize2,
  Plus,
  Square,
  Target,
} from 'lucide-react'
import type { ChangeEvent, ClipboardEventHandler } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { Attachment, LocalDeviceSkill, ModelOptions, UnifiedModel } from '@/types/api'
import type { CodeCommentContext } from '@/types/workspace-files'
import { AttachmentBadges } from './AttachmentBadges'
import { ComposerTextarea } from './ComposerTextarea'
import { ComposerModePill, GoalDraftPill } from './GoalDraftPill'
import { createLongPastedTextAttachment } from './pastedTextAttachment'
import { useAutoResizeTextarea } from './useAutoResizeTextarea'

interface CompactChatComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled: boolean
  disabledReason?: string
  placeholder: string
  attachments?: Attachment[]
  codeComments?: CodeCommentContext[]
  uploadingFiles?: Map<string, { file: File; progress: number }>
  attachmentErrors?: Map<string, string>
  onFileSelect?: (files: File | File[]) => void
  planModeActive?: boolean
  onSetPlanMode?: () => void
  onClearPlanMode?: () => void
  onSetGoal?: () => void
  goalDraftActive?: boolean
  onCancelGoalDraft?: () => void
  onRemoveAttachment?: (attachmentId: number) => void
  onClearCodeComments?: () => void
  onListLocalSkills?: () => Promise<LocalDeviceSkill[]>
  models?: UnifiedModel[]
  selectedModel?: UnifiedModel | null
  selectedModelOptions?: ModelOptions
  onSelectModel?: (model: UnifiedModel | null) => void
  onBlockedModelSelect?: (model: UnifiedModel, message?: string) => void
  isModelSelectionReady?: boolean
  isStreaming?: boolean
  onPause?: () => void
}

export function CompactChatComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  disabledReason,
  placeholder,
  attachments = [],
  codeComments = [],
  uploadingFiles = new Map(),
  attachmentErrors = new Map(),
  onFileSelect,
  planModeActive = false,
  onSetPlanMode,
  onClearPlanMode,
  onSetGoal,
  goalDraftActive = false,
  onCancelGoalDraft,
  onRemoveAttachment = () => {},
  onClearCodeComments,
  onListLocalSkills,
  models = [],
  selectedModel,
  selectedModelOptions = {},
  onSelectModel,
  onBlockedModelSelect,
  isModelSelectionReady = true,
  isStreaming = false,
  onPause,
}: CompactChatComposerProps) {
  const { t } = useTranslation('common')
  const imageInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useAutoResizeTextarea(value, 128)
  const [contextSheetOpen, setContextSheetOpen] = useState(false)
  const [fullscreenInputOpen, setFullscreenInputOpen] = useState(false)
  const [canExpandInput, setCanExpandInput] = useState(false)
  const canSend =
    (value.trim().length > 0 || attachments.length > 0 || codeComments.length > 0) && !disabled
  const explicitLineCount = value.split('\n').length

  const handleImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (files && files.length > 0) {
      onFileSelect?.(Array.from(files))
    }
    event.target.value = ''
    setContextSheetOpen(false)
  }

  const handleSetGoal = () => {
    setContextSheetOpen(false)
    onSetGoal?.()
  }

  const handleSetPlanMode = () => {
    setContextSheetOpen(false)
    onSetPlanMode?.()
  }

  const handlePasteFiles: ClipboardEventHandler<HTMLTextAreaElement> = event => {
    const files = Array.from(event.clipboardData.files)
    if (files.length > 0) {
      event.preventDefault()
      onFileSelect?.(files)
      return
    }

    if (!onFileSelect) return
    const textAttachment = createLongPastedTextAttachment(event.clipboardData.getData('text/plain'))
    if (!textAttachment) return

    event.preventDefault()
    onFileSelect([textAttachment])
  }

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      setCanExpandInput(explicitLineCount > 4)
      return
    }

    setCanExpandInput(explicitLineCount > 4 || textarea.scrollHeight > 124)
  }, [explicitLineCount, textareaRef, value])

  return (
    <div className="w-full">
      <AttachmentBadges
        attachments={attachments}
        uploadingFiles={uploadingFiles}
        errors={attachmentErrors}
        codeComments={codeComments}
        onRemoveAttachment={onRemoveAttachment}
        onClearCodeComments={onClearCodeComments}
      />
      <input
        ref={imageInputRef}
        type="file"
        multiple
        className="hidden"
        data-testid="mobile-image-file-input"
        onChange={handleImageChange}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        data-testid="mobile-camera-file-input"
        onChange={handleImageChange}
      />
      {disabledReason && (
        <div
          data-testid="composer-disabled-reason"
          className="mb-2 rounded-xl bg-muted px-3 py-2 text-xs text-text-secondary"
        >
          {disabledReason}
        </div>
      )}
      {goalDraftActive ? (
        <GoalDraftPill onCancel={onCancelGoalDraft} className="mb-2" />
      ) : planModeActive ? (
        <ComposerModePill
          label={t('workbench.plan_mode', '计划模式')}
          testId="plan-mode-pill"
          cancelTestId="cancel-plan-mode-button"
          cancelLabel={t('workbench.disable_plan_mode', '关闭计划模式')}
          onCancel={onClearPlanMode}
          className="mb-2"
          title={t('workbench.collaboration_mode', '运行模式')}
        />
      ) : null}
      <form
        className="flex w-full items-end gap-2"
        onSubmit={event => {
          event.preventDefault()
          if (canSend) onSubmit()
        }}
      >
        <button
          type="button"
          data-testid="add-context-button"
          onClick={() => !disabled && setContextSheetOpen(true)}
          disabled={disabled}
          className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[26px] border border-border bg-background p-0 text-text-secondary shadow-[0_8px_28px_rgba(0,0,0,0.08)] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          aria-expanded={contextSheetOpen}
          aria-label={t('workbench.add_context', '添加上下文')}
        >
          <Plus className="h-6 w-6" />
        </button>
        <div
          data-testid="compact-input-pill"
          className={[
            'relative flex min-h-[52px] min-w-0 flex-1 items-end rounded-[26px] border border-border bg-background pl-4 shadow-[0_12px_40px_rgba(0,0,0,0.08)]',
            'z-chrome',
            'pr-14',
          ].join(' ')}
        >
          <ComposerTextarea
            textareaRef={textareaRef}
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            canSend={canSend}
            placeholder={placeholder}
            rows={1}
            onPasteFiles={files => onFileSelect?.(files)}
            className="scrollbar-none max-h-32 min-h-6 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-[14px] text-sm leading-5 text-text-primary outline-none placeholder:text-text-muted"
            skillMenuClassName="left-[-1rem] right-[-3.5rem]"
            onListLocalSkills={onListLocalSkills}
            models={models}
            selectedModel={selectedModel}
            selectedModelOptions={selectedModelOptions}
            planModeActive={planModeActive}
            onSetPlanMode={onSetPlanMode}
            onSetGoal={onSetGoal}
            onSelectModel={onSelectModel}
            onBlockedModelSelect={onBlockedModelSelect}
            isModelSelectionReady={isModelSelectionReady}
          />
          {canExpandInput && (
            <button
              type="button"
              data-testid="expand-input-button"
              onClick={() => setFullscreenInputOpen(true)}
              className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full text-text-secondary hover:bg-muted"
              aria-label={t('workbench.expand_input', '展开输入框')}
            >
              <Maximize2 className="h-4 w-4" />
            </button>
          )}
          {isStreaming ? (
            <button
              type="button"
              data-testid="pause-response-button"
              onClick={onPause}
              className="absolute bottom-1 right-1 flex h-11 w-11 items-center justify-center rounded-[22px] bg-[#242424] p-0 text-white hover:bg-[#333]"
              aria-label={t('workbench.pause_response', '暂停回复')}
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              data-testid="send-message-button"
              disabled={!canSend}
              className="absolute bottom-1 right-1 flex h-11 w-11 items-center justify-center rounded-[22px] bg-[#242424] p-0 text-white disabled:bg-[#9a9a9a]"
              aria-label={t('workbench.send_message', '发送消息')}
            >
              <ArrowUp className="h-5 w-5" />
            </button>
          )}
        </div>
      </form>
      {contextSheetOpen && (
        <div
          data-testid="mobile-context-sheet-backdrop"
          className="fixed inset-0 z-modal bg-black/20"
          onClick={() => setContextSheetOpen(false)}
        >
          <div
            data-testid="mobile-context-sheet"
            className="absolute bottom-0 left-0 right-0 rounded-t-[28px] border border-white/10 bg-background px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 shadow-[0_-20px_60px_rgba(0,0,0,0.18)]"
            onClick={event => event.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-border" />
            <button
              type="button"
              data-testid="mobile-take-photo-button"
              onClick={() => cameraInputRef.current?.click()}
              className="flex h-14 w-full items-center gap-4 rounded-2xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
            >
              <Camera className="h-6 w-6 shrink-0 text-text-secondary" />
              <span>{t('workbench.take_photo', '拍照')}</span>
            </button>
            <button
              type="button"
              data-testid="mobile-upload-image-button"
              onClick={() => imageInputRef.current?.click()}
              className="flex h-14 w-full items-center gap-4 rounded-2xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
            >
              <Image className="h-6 w-6 shrink-0 text-text-secondary" />
              <span>{t('workbench.upload_image', '上传文件')}</span>
            </button>
            {onSetPlanMode && !planModeActive && (
              <button
                type="button"
                data-testid="mobile-set-plan-mode-button"
                onClick={handleSetPlanMode}
                className="flex h-14 w-full items-center gap-4 rounded-2xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
              >
                <ClipboardList className="h-6 w-6 shrink-0 text-text-secondary" />
                <span>{t('workbench.plan_mode', '计划模式')}</span>
              </button>
            )}
            {onSetGoal && (
              <button
                type="button"
                data-testid="mobile-set-goal-button"
                onClick={handleSetGoal}
                className="flex h-14 w-full items-center gap-4 rounded-2xl px-4 text-left text-base font-semibold text-text-primary hover:bg-muted"
              >
                <Target className="h-6 w-6 shrink-0 text-primary" />
                <span>{t('workbench.pursue_goal', '追求目标')}</span>
              </button>
            )}
          </div>
        </div>
      )}
      {fullscreenInputOpen && (
        <div
          data-testid="fullscreen-input-sheet"
          className="fixed inset-0 z-modal flex h-dvh flex-col bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
        >
          <div className="relative min-h-0 flex-1">
            <button
              type="button"
              data-testid="collapse-input-button"
              onClick={() => setFullscreenInputOpen(false)}
              className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-background/90 text-text-secondary shadow-sm hover:bg-muted"
              aria-label={t('workbench.collapse_input', '折叠输入框')}
            >
              <Minimize2 className="h-5 w-5" />
            </button>
            <textarea
              data-testid="fullscreen-message-input"
              value={value}
              onChange={event => onChange(event.target.value)}
              onPaste={handlePasteFiles}
              placeholder={placeholder}
              className="h-full w-full resize-none rounded-2xl border border-border bg-background px-4 pb-4 pt-14 text-base leading-7 text-text-primary outline-none placeholder:text-text-muted"
            />
          </div>
        </div>
      )}
    </div>
  )
}
