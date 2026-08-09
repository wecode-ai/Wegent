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
  onDraftEdit?: () => void
}

const DRAFT_FLUSH_DELAY_MS = 300

export const BufferedChatInput = memo(function BufferedChatInput({
  value,
  onChange,
  onSubmit,
  insertion,
  onDraftEdit,
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
  const committedValueRef = useRef(value)
  const pendingChangeRef = useRef(onChange)
  const programmaticUpdateDepthRef = useRef(0)

  const setComposerValue = useCallback((nextValue: string, cursor: number) => {
    programmaticUpdateDepthRef.current += 1
    composerRef.current?.setValue(nextValue, cursor)
    queueMicrotask(() => {
      programmaticUpdateDepthRef.current = Math.max(0, programmaticUpdateDepthRef.current - 1)
    })
  }, [])

  const cancelPendingFlush = useCallback(() => {
    if (flushTimeoutRef.current !== null) {
      window.clearTimeout(flushTimeoutRef.current)
      flushTimeoutRef.current = null
    }
  }, [])

  const flushDraft = useCallback(
    (nextDraft: string) => {
      cancelPendingFlush()
      pendingChangeRef.current = onChange
      onChange(nextDraft)
    },
    [cancelPendingFlush, onChange]
  )

  const scheduleDraftFlush = useCallback(
    (nextDraft: string) => {
      cancelPendingFlush()
      pendingChangeRef.current = onChange
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
    committedValueRef.current = value
    setDraftState({ scopeKey, sourceValue: value, draft: value })
    if (shouldSetComposer) {
      setComposerValue(value, value.length)
    }
  }, [scopeKey, setComposerValue, value])

  // Flush a pending draft whenever it would be discarded (scope switch or unmount).
  useEffect(() => {
    return () => {
      const pendingDraft = draftRef.current
      if (pendingDraft !== committedValueRef.current) {
        cancelPendingFlush()
        pendingChangeRef.current(pendingDraft)
      }
    }
  }, [cancelPendingFlush, scopeKey])

  useEffect(() => {
    if (!insertion || appliedInsertionIdRef.current === insertion.id) return
    appliedInsertionIdRef.current = insertion.id
    const currentDraft = draftRef.current
    const nextDraft = currentDraft ? `${currentDraft}\n${insertion.text}` : insertion.text
    draftRef.current = nextDraft
    setDraftState({ scopeKey, sourceValue: value, draft: nextDraft })
    setComposerValue(nextDraft, nextDraft.length)
    scheduleDraftFlush(nextDraft)
  }, [insertion, scheduleDraftFlush, scopeKey, setComposerValue, value])

  const setDraft = useCallback(
    (nextDraft: string) => {
      draftRef.current = nextDraft
      if (programmaticUpdateDepthRef.current === 0) {
        onDraftEdit?.()
      }
      scheduleDraftFlush(nextDraft)
    },
    [onDraftEdit, scheduleDraftFlush]
  )

  // Flush after the next frame so the editor state settles first.
  const flushDraftNextFrame = useCallback(() => {
    window.requestAnimationFrame(() => flushDraft(draftRef.current))
  }, [flushDraft])

  const handleSubmit = useCallback(
    (valueOverride?: string, options?: ChatSubmitOptions) => {
      const submittedDraft = valueOverride ?? draftRef.current
      const submission =
        options === undefined ? onSubmit(submittedDraft) : onSubmit(submittedDraft, options)
      if (submittedDraft.trim()) {
        draftRef.current = ''
        cancelPendingFlush()
        setDraftState({ scopeKey, sourceValue: '', draft: '' })
        setComposerValue('', 0)
        onChange('')
      }
      void Promise.resolve(submission).then(accepted => {
        if (accepted !== false || !submittedDraft.trim()) return
        if (draftRef.current) return
        draftRef.current = submittedDraft
        cancelPendingFlush()
        setDraftState({ scopeKey, sourceValue: submittedDraft, draft: submittedDraft })
        setComposerValue(submittedDraft, submittedDraft.length)
        onChange(submittedDraft)
      })
    },
    [cancelPendingFlush, onChange, onSubmit, scopeKey, setComposerValue]
  )

  return (
    <ChatInput
      {...props}
      ref={composerRef}
      value={draft}
      onChange={setDraft}
      onBlur={flushDraftNextFrame}
      onCompositionEnd={flushDraftNextFrame}
      onSubmit={handleSubmit}
    />
  )
})
