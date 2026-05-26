import { useTranslation } from 'react-i18next'
import { CompactChatComposer } from './composer/CompactChatComposer'
import { DesktopChatComposer } from './composer/DesktopChatComposer'

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  disabled: boolean
  placeholder?: string
  variant?: 'compact' | 'desktop'
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  variant = 'compact',
}: ChatInputProps) {
  const { t } = useTranslation('common')
  const inputPlaceholder = placeholder ?? t('workbench.input_placeholder', '尽管问')

  const composerProps = { value, onChange, onSubmit, disabled, placeholder: inputPlaceholder }

  if (variant === 'desktop') {
    return <DesktopChatComposer {...composerProps} />
  }

  return <CompactChatComposer {...composerProps} />
}
