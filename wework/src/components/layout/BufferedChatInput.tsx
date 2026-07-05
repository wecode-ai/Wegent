import { useCallback, useState } from 'react'
import { ChatInput, type ChatInputProps } from '@/components/chat/ChatInput'

export function BufferedChatInput({ value, onSubmit, ...props }: ChatInputProps) {
  const [draftState, setDraftState] = useState(() => ({
    sourceValue: value,
    draft: value,
  }))
  const draft = draftState.sourceValue === value ? draftState.draft : value
  const setDraft = useCallback(
    (nextDraft: string) => {
      setDraftState({ sourceValue: value, draft: nextDraft })
    },
    [value]
  )

  const handleSubmit = useCallback(
    (valueOverride?: string) => {
      const submittedDraft = valueOverride ?? draft
      void onSubmit(submittedDraft)
      if (submittedDraft.trim()) {
        setDraftState({ sourceValue: value, draft: '' })
      }
    },
    [draft, onSubmit, value]
  )

  return <ChatInput {...props} value={draft} onChange={setDraft} onSubmit={handleSubmit} />
}
