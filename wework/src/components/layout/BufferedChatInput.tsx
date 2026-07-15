import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { ChatInput, type ChatInputProps, type ChatSubmitOptions } from '@/components/chat/ChatInput'
import { parseComposerMentions } from '@/components/chat/composer/composerMentions'

export interface BufferedChatInputInsertion {
  id: number
  text: string
}

interface BufferedChatInputProps extends ChatInputProps {
  insertion?: BufferedChatInputInsertion | null
}

export const BufferedChatInput = memo(function BufferedChatInput({
  value,
  onChange,
  onSubmit,
  insertion,
  ...props
}: BufferedChatInputProps) {
  const [draftState, setDraftState] = useState(() => ({
    sourceValue: value,
    draft: value,
  }))
  const draft = draftState.sourceValue === value ? draftState.draft : value
  const appliedInsertionIdRef = useRef<number | null>(null)

  useEffect(() => {
    if (!insertion || appliedInsertionIdRef.current === insertion.id) return
    appliedInsertionIdRef.current = insertion.id
    setDraftState(current => {
      const currentDraft = current.sourceValue === value ? current.draft : value
      return {
        sourceValue: value,
        draft: currentDraft ? `${currentDraft}\n${insertion.text}` : insertion.text,
      }
    })
  }, [insertion, value])
  const setDraft = useCallback(
    (nextDraft: string) => {
      setDraftState({ sourceValue: value, draft: nextDraft })
      if (parseComposerMentions(nextDraft).length > 0) {
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
})
