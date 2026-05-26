import { ArrowUp, ChevronDown, Mic, Plus, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DesktopModelSelector } from './DesktopModelSelector'

interface DesktopComposerToolbarProps {
  canSend: boolean
}

export function DesktopComposerToolbar({ canSend }: DesktopComposerToolbarProps) {
  const { t } = useTranslation('common')

  return (
    <div className="mt-auto flex min-h-11 items-center justify-between gap-4">
      <div className="-ml-3 flex min-w-0 items-center gap-2">
        <button
          type="button"
          data-testid="add-context-button"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full p-0 text-text-secondary hover:bg-muted"
          aria-label={t('workbench.add_context', '添加上下文')}
        >
          <Plus className="h-6 w-6" />
        </button>
        <button
          type="button"
          data-testid="custom-mode-button"
          className="flex h-11 min-w-[44px] items-center gap-2 rounded-full px-2 text-sm font-medium text-text-secondary hover:bg-muted"
          aria-label={t('workbench.custom_mode', '自定义')}
        >
          <Settings className="h-5 w-5" />
          <span>{t('workbench.custom_mode', '自定义')}</span>
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <DesktopModelSelector />
        <button
          type="button"
          data-testid="voice-input-button"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full p-0 text-text-secondary hover:bg-muted"
          aria-label={t('workbench.voice_input', '语音输入')}
        >
          <Mic className="h-5 w-5" />
        </button>
        <button
          type="submit"
          data-testid="send-message-button"
          disabled={!canSend}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#8f8f8f] p-0 text-white disabled:bg-[#b5b5b5]"
          aria-label={t('workbench.send_message', '发送消息')}
        >
          <ArrowUp className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}
