import { memo, useCallback, useEffect, useRef, useState, startTransition } from 'react'
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

  const syncDraftToState = useCallback(
    (nextDraft: string) => {
      startTransition(() => {
        setDraftState({ scopeKey, sourceValue: value, draft: nextDraft })
      })
      onChange(nextDraft)
    },
    [onChange, scopeKey, value]
  )

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
    const currentDraft =
      draftState.scopeKey === scopeKey && draftState.sourceValue === value
        ? draftState.draft
        : value
    const nextDraft = currentDraft ? `${currentDraft}\n${insertion.text}` : insertion.text
    draftRef.current = nextDraft
    syncDraftToState(nextDraft)
  }, [
    draftState.scopeKey,
    draftState.sourceValue,
    draftState.draft,
    insertion,
    scopeKey,
    syncDraftToState,
    value,
  ])

  const setDraft = useCallback((nextDraft: string) => {
    draftRef.current = nextDraft
    // During active typing we intentionally do NOT sync to React state.
    // ProseMirror already displays the text internally; syncing every
    // keystroke forces the whole Workbench tree to re-render and causes
    // input lag. The draft is flushed on blur, compositionend, or submit.
  }, [])

  const handleBlur = useCallback(() => {
    window.requestAnimationFrame(() => syncDraftToState(draftRef.current))
  }, [syncDraftToState])

  const handleCompositionEnd = useCallback(() => {
    window.requestAnimationFrame(() => syncDraftToState(draftRef.current))
  }, [syncDraftToState])

  const handleSubmit = useCallback(
    (valueOverride?: string, options?: ChatSubmitOptions) => {
      const submittedDraft = valueOverride ?? draftRef.current
      if (options === undefined) {
        void onSubmit(submittedDraft)
      } else {
        void onSubmit(submittedDraft, options)
      }
      if (submittedDraft.trim()) {
        draftRef.current = ''
        startTransition(() => {
          setDraftState({ scopeKey, sourceValue: '', draft: '' })
        })
        onChange('')
      }
    },
    [onChange, onSubmit, scopeKey]
  )

  return (
    <ChatInput
      {...props}
      value={draft}
      onChange={setDraft}
      onBlur={handleBlur}
      onCompositionEnd={handleCompositionEnd}
      onSubmit={handleSubmit}
    />
  )
})
