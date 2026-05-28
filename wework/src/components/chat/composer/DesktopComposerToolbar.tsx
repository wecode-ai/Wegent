import { ArrowUp, Mic } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DesktopContextMenu } from './DesktopContextMenu'
import { DesktopModeSelector } from './DesktopModeSelector'
import { DesktopModelSelector } from './DesktopModelSelector'

interface DesktopComposerToolbarProps {
  canSend: boolean
}

export function DesktopComposerToolbar({ canSend }: DesktopComposerToolbarProps) {
  const { t } = useTranslation('common')

  return (
    <div className="mt-auto flex min-h-10 items-center justify-between gap-4">
      <div className="-ml-2 flex min-w-0 items-center gap-2">
        <DesktopContextMenu />
        <DesktopModeSelector />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <DesktopModelSelector />
        <button
          type="button"
          data-testid="voice-input-button"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full p-0 text-text-secondary hover:bg-muted"
          aria-label={t('workbench.voice_input', '语音输入')}
        >
          <Mic className="h-[18px] w-[18px]" />
        </button>
        <button
          type="submit"
          data-testid="send-message-button"
          disabled={!canSend}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#8f8f8f] p-0 text-white disabled:bg-[#b5b5b5]"
          aria-label={t('workbench.send_message', '发送消息')}
        >
          <ArrowUp className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>
  )
}
