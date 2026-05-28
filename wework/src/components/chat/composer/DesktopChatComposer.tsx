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
  const textareaRef = useAutoResizeTextarea(value, 144)
  const canSend = value.trim().length > 0 && !disabled

  return (
    <div className="w-full rounded-[26px] bg-surface shadow-[0_14px_42px_rgba(0,0,0,0.055)]">
      <form
        className="flex min-h-[100px] w-full flex-col rounded-[26px] border border-border bg-base px-5 pb-3 pt-4"
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
          rows={2}
          className="max-h-[120px] min-h-10 w-full resize-none overflow-y-auto bg-transparent text-[15px] leading-5 text-text-primary outline-none placeholder:text-text-muted"
        />
        <DesktopComposerToolbar canSend={canSend} />
      </form>
      <ProjectWorkBar />
    </div>
  )
}
