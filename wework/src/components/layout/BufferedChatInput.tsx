import { useCallback, useState } from 'react'
import { ChatInput, type ChatInputProps, type ChatSubmitOptions } from '@/components/chat/ChatInput'

export function BufferedChatInput({ value, onChange, onSubmit, ...props }: ChatInputProps) {
  const [draftState, setDraftState] = useState(() => ({
    sourceValue: value,
    draft: value,
  }))
  const draft = draftState.sourceValue === value ? draftState.draft : value
  const setDraft = useCallback(
    (nextDraft: string) => {
      setDraftState({ sourceValue: value, draft: nextDraft })
      if (value.includes('skill://') || value.includes('plugin://')) {
        onChange(nextDraft)
      }
    },
    [onChange, value]
  )

  const handleSubmit = useCallback(
    (valueOverride?: string, options?: ChatSubmitOptions) => {
      const submittedDraft = valueOverride ?? draft
      if (options === undefined) {
        void onSubmit(submittedDraft)
      } else {
        void onSubmit(submittedDraft, options)
      }
      if (submittedDraft.trim()) {
        setDraftState({ sourceValue: value, draft: '' })
      }
    },
    [draft, onSubmit, value]
  )

  return <ChatInput {...props} value={draft} onChange={setDraft} onSubmit={handleSubmit} />
}
