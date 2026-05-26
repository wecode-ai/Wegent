import { ComposerTextarea } from './ComposerTextarea'
import { DesktopComposerToolbar } from './DesktopComposerToolbar'
import { ProjectWorkBar } from './ProjectWorkBar'
import { useAutoResizeTextarea } from './useAutoResizeTextarea'

interface DesktopChatComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled: boolean
  placeholder: string
}

export function DesktopChatComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
}: DesktopChatComposerProps) {
  const textareaRef = useAutoResizeTextarea(value, 168)
  const canSend = value.trim().length > 0 && !disabled

  return (
    <div className="w-full rounded-[28px] bg-surface shadow-[0_16px_44px_rgba(0,0,0,0.08)]">
      <form
        className="flex min-h-[152px] w-full flex-col rounded-[28px] border border-border bg-base px-6 pb-4 pt-5"
        onSubmit={event => {
          event.preventDefault()
          if (canSend) onSubmit()
        }}
      >
        <ComposerTextarea
          textareaRef={textareaRef}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          canSend={canSend}
          placeholder={placeholder}
          rows={3}
          className="max-h-[168px] min-h-[72px] w-full resize-none overflow-y-auto bg-transparent text-base leading-6 text-text-primary outline-none placeholder:text-text-muted"
        />
        <DesktopComposerToolbar canSend={canSend} />
      </form>
      <ProjectWorkBar />
    </div>
  )
}
