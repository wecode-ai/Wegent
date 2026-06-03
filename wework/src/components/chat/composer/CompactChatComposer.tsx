import { ArrowUp, Camera, Image, Maximize2, Mic, Minimize2, Plus } from 'lucide-react'
import type { ChangeEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Attachment, LocalDeviceSkill } from '@/types/api'
import { AttachmentBadges } from './AttachmentBadges'
import { ComposerTextarea } from './ComposerTextarea'
import { useAutoResizeTextarea } from './useAutoResizeTextarea'

interface CompactChatComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled: boolean
  placeholder: string
  attachments?: Attachment[]
  uploadingFiles?: Map<string, { file: File; progress: number }>
  attachmentErrors?: Map<string, string>
  onImageSelect?: (files: File | File[]) => void
  onRemoveAttachment?: (attachmentId: number) => void
  onListLocalSkills?: () => Promise<LocalDeviceSkill[]>
}

export function CompactChatComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  attachments = [],
  uploadingFiles = new Map(),
  attachmentErrors = new Map(),
  onImageSelect,
  onRemoveAttachment = () => {},
  onListLocalSkills,
}: CompactChatComposerProps) {
  const { t } = useTranslation('common')
  const imageInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useAutoResizeTextarea(value, 128)
  const [contextSheetOpen, setContextSheetOpen] = useState(false)
  const [fullscreenInputOpen, setFullscreenInputOpen] = useState(false)
  const [canExpandInput, setCanExpandInput] = useState(false)
  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled
  const hasText = value.trim().length > 0
  const explicitLineCount = value.split('\n').length

  const handleImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (files && files.length > 0) {
      onImageSelect?.(Array.from(files))
    }
    event.target.value = ''
    setContextSheetOpen(false)
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
        onRemoveAttachment={onRemoveAttachment}
      />
      <input
        ref={imageInputRef}
        type="file"
        multiple
        accept="image/*"
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
            hasText ? 'pr-14' : 'pr-[92px]',
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
            className="scrollbar-none max-h-32 min-h-6 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-[14px] text-base leading-6 text-text-primary outline-none placeholder:text-text-muted"
            skillMenuClassName="left-[-1rem] right-[-3.5rem]"
            onListLocalSkills={onListLocalSkills}
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
          {!hasText && (
            <button
              type="button"
              data-testid="voice-input-button"
              className="absolute bottom-1.5 right-12 flex h-10 w-10 items-center justify-center rounded-full p-0 text-text-secondary hover:bg-muted"
              aria-label={t('workbench.voice_input', '语音输入')}
            >
              <Mic className="h-5 w-5" />
            </button>
          )}
          <button
            type="submit"
            data-testid="send-message-button"
            disabled={!canSend}
            className="absolute bottom-1 right-1 flex h-11 w-11 items-center justify-center rounded-[22px] bg-primary p-0 text-primary-contrast disabled:bg-muted disabled:text-text-muted"
            aria-label={t('workbench.send_message', '发送消息')}
          >
            <ArrowUp className="h-5 w-5" />
          </button>
        </div>
      </form>
      {contextSheetOpen && (
        <div
          data-testid="mobile-context-sheet-backdrop"
          className="fixed inset-0 z-50 bg-black/20"
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
              <span>{t('workbench.upload_image', '上传图片')}</span>
            </button>
          </div>
        </div>
      )}
      {fullscreenInputOpen && (
        <div
          data-testid="fullscreen-input-sheet"
          className="fixed inset-0 z-50 flex h-dvh flex-col bg-background px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-text-primary"
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
              placeholder={placeholder}
              className="h-full w-full resize-none rounded-2xl border border-border bg-surface px-4 pb-4 pt-14 text-base leading-7 text-text-primary outline-none placeholder:text-text-muted"
            />
          </div>
        </div>
      )}
    </div>
  )
}
