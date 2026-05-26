import { ArrowUp, Mic, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled: boolean
  placeholder?: string
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
}: ChatInputProps) {
  const { t } = useTranslation('common')
  const canSend = value.trim().length > 0 && !disabled
  const inputPlaceholder = placeholder ?? t('workbench.input_placeholder', '尽管问')

  return (
    <form
      className="flex min-h-[64px] w-full items-center gap-3 rounded-[28px] border border-border bg-base px-4 shadow-[0_12px_40px_rgba(0,0,0,0.08)]"
      onSubmit={event => {
        event.preventDefault()
        if (canSend) onSubmit()
      }}
    >
      <button
        type="button"
        data-testid="add-context-button"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full p-0 text-text-secondary hover:bg-muted"
        aria-label={t('workbench.add_context', '添加上下文')}
      >
        <Plus className="h-6 w-6" />
      </button>
      <input
        data-testid="chat-message-input"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={inputPlaceholder}
        className="min-w-0 flex-1 bg-transparent text-base text-text-primary outline-none placeholder:text-text-muted"
      />
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
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#242424] p-0 text-white disabled:bg-[#9a9a9a]"
        aria-label={t('workbench.send_message', '发送消息')}
      >
        <ArrowUp className="h-5 w-5" />
      </button>
    </form>
  )
}
