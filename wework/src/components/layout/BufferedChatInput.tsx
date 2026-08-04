import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  ChatInput,
  type ChatInputHandle,
  type ChatInputProps,
  type ChatSubmitOptions,
} from '@/components/chat/ChatInput'

export interface BufferedChatInputInsertion {
  id: number
  text: string
}

interface BufferedChatInputProps extends ChatInputProps {
  insertion?: BufferedChatInputInsertion | null
}

const DRAFT_FLUSH_DELAY_MS = 300

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
  const flushTimeoutRef = useRef<number | null>(null)
  const composerRef = useRef<ChatInputHandle>(null)

  const cancelPendingFlush = useCallback(() => {
    if (flushTimeoutRef.current !== null) {
      window.clearTimeout(flushTimeoutRef.current)
      flushTimeoutRef.current = null
    }
  }, [])

  const flushDraft = useCallback(
    (nextDraft: string) => {
      cancelPendingFlush()
      onChange(nextDraft)
    },
    [cancelPendingFlush, onChange]
  )

  const scheduleDraftFlush = useCallback(
    (nextDraft: string) => {
      cancelPendingFlush()
      flushTimeoutRef.current = window.setTimeout(() => {
        flushTimeoutRef.current = null
        onChange(nextDraft)
      }, DRAFT_FLUSH_DELAY_MS)
    },
    [cancelPendingFlush, onChange]
  )

  // Sync external value changes into composer and local state.
  useEffect(() => {
    const shouldSetComposer = value !== draftRef.current
    draftRef.current = value
    setDraftState({ scopeKey, sourceValue: value, draft: value })
    if (shouldSetComposer) {
      composerRef.current?.setValue(value, value.length)
    }
  }, [scopeKey, value])

  // Flush pending draft when value changes or on unmount.
  useEffect(() => {
    return () => {
      const pendingDraft = draftRef.current
      if (pendingDraft !== value) {
        cancelPendingFlush()
        onChange(pendingDraft)
      }
    }
  }, [cancelPendingFlush, onChange, value])

  useEffect(() => {
    if (!insertion || appliedInsertionIdRef.current === insertion.id) return
    appliedInsertionIdRef.current = insertion.id
    const currentDraft = draftRef.current
    const nextDraft = currentDraft ? `${currentDraft}\n${insertion.text}` : insertion.text
    draftRef.current = nextDraft
    setDraftState({ scopeKey, sourceValue: value, draft: nextDraft })
    composerRef.current?.setValue(nextDraft, nextDraft.length)
    scheduleDraftFlush(nextDraft)
  }, [insertion, scheduleDraftFlush, scopeKey, value])

  const setDraft = useCallback(
    (nextDraft: string) => {
      draftRef.current = nextDraft
      scheduleDraftFlush(nextDraft)
    },
    [scheduleDraftFlush]
  )

  const handleBlur = useCallback(() => {
    window.requestAnimationFrame(() => flushDraft(draftRef.current))
  }, [flushDraft])

  const handleCompositionEnd = useCallback(() => {
    window.requestAnimationFrame(() => flushDraft(draftRef.current))
  }, [flushDraft])

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
        cancelPendingFlush()
        setDraftState({ scopeKey, sourceValue: '', draft: '' })
        composerRef.current?.setValue('', 0)
        onChange('')
      }
    },
    [cancelPendingFlush, onChange, onSubmit, scopeKey]
  )

  return (
    <ChatInput
      {...props}
      ref={composerRef}
      value={draft}
      onChange={setDraft}
      onBlur={handleBlur}
      onCompositionEnd={handleCompositionEnd}
      onSubmit={handleSubmit}
    />
  )
})
