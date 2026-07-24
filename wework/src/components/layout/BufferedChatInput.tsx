import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { ChatInput, type ChatInputProps, type ChatSubmitOptions } from '@/components/chat/ChatInput'

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
  const scopeKey = props.projectChat?.scopeKey
  const [draftState, setDraftState] = useState(() => ({
    scopeKey,
    sourceValue: value,
    draft: value,
  }))
  const draft =
    draftState.scopeKey === scopeKey && draftState.sourceValue === value ? draftState.draft : value
  const draftRef = useRef(draft)
  const appliedInsertionIdRef = useRef<number | null>(null)

  useEffect(() => {
    draftRef.current = value
    return () => {
      const pendingDraft = draftRef.current
      if (pendingDraft !== value) {
        onChange(pendingDraft)
      }
    }
  }, [onChange, scopeKey, value])

  useEffect(() => {
    if (!insertion || appliedInsertionIdRef.current === insertion.id) return
    appliedInsertionIdRef.current = insertion.id
    setDraftState(current => {
      const currentDraft =
        current.scopeKey === scopeKey && current.sourceValue === value ? current.draft : value
      const nextDraft = currentDraft ? `${currentDraft}\n${insertion.text}` : insertion.text
      draftRef.current = nextDraft
      return {
        scopeKey,
        sourceValue: value,
        draft: nextDraft,
      }
    })
  }, [insertion, scopeKey, value])
  const setDraft = useCallback(
    (nextDraft: string) => {
      draftRef.current = nextDraft
      setDraftState({ scopeKey, sourceValue: value, draft: nextDraft })
      onChange(nextDraft)
    },
    [onChange, scopeKey, value]
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
        draftRef.current = ''
        setDraftState({ scopeKey, sourceValue: '', draft: '' })
      }
    },
    [draft, onSubmit, scopeKey]
  )

  return <ChatInput {...props} value={draft} onChange={setDraft} onSubmit={handleSubmit} />
})
