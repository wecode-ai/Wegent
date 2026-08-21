import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ChatInput,
  type ChatInputHandle,
  type ChatInputProps,
  type ChatSubmitOptions,
} from '@/components/chat/ChatInput'
import { recordComposerDiagnostic } from '@/components/chat/composer/composerDiagnostics'
import {
  consumeWorkbenchComposerFocusRequest,
  WORKBENCH_COMPOSER_FOCUS_EVENT,
  type WorkbenchComposerFocusDetail,
} from '@/lib/workbenchComposerFocus'

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
  onCompositionStart: onParentCompositionStart,
  onCompositionEnd: onParentCompositionEnd,
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
  const flushFrameRef = useRef<number | null>(null)
  const composerRef = useRef<ChatInputHandle>(null)
  const committedValueRef = useRef(value)
  const pendingChangeRef = useRef(onChange)
  const programmaticUpdateDepthRef = useRef(0)
  const draftEditVersionRef = useRef(0)
  const isComposingRef = useRef(false)
  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey

  useLayoutEffect(() => {
    const focusComposer = () => {
      composerRef.current?.focus()
    }
    const focusRequestedComposer = (event: Event) => {
      const detail = (event as CustomEvent<WorkbenchComposerFocusDetail>).detail
      if (props.disabled || !scopeKey || detail?.scopeKey !== scopeKey) return
      consumeWorkbenchComposerFocusRequest(scopeKey)
      focusComposer()
    }
    window.addEventListener(WORKBENCH_COMPOSER_FOCUS_EVENT, focusRequestedComposer)
    if (!props.disabled && scopeKey && consumeWorkbenchComposerFocusRequest(scopeKey)) {
      focusComposer()
    }
    return () => {
      window.removeEventListener(WORKBENCH_COMPOSER_FOCUS_EVENT, focusRequestedComposer)
    }
  }, [props.disabled, scopeKey])

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

  const cancelPendingFlushFrame = useCallback(() => {
    if (flushFrameRef.current !== null) {
      window.cancelAnimationFrame(flushFrameRef.current)
      flushFrameRef.current = null
    }
  }, [])

  const flushDraft = useCallback(
    (nextDraft: string, reason: string) => {
      cancelPendingFlush()
      pendingChangeRef.current = onChange
      recordComposerDiagnostic('draft-flush', {
        reason,
        draftLength: nextDraft.length,
      })
      onChange(nextDraft)
    },
    [cancelPendingFlush, onChange]
  )

  const scheduleDraftFlush = useCallback(
    (nextDraft: string, reason = 'debounce') => {
      cancelPendingFlush()
      pendingChangeRef.current = onChange
      flushTimeoutRef.current = window.setTimeout(() => {
        flushTimeoutRef.current = null
        recordComposerDiagnostic('draft-flush', {
          reason,
          draftLength: nextDraft.length,
        })
        onChange(nextDraft)
      }, DRAFT_FLUSH_DELAY_MS)
    },
    [cancelPendingFlush, onChange]
  )

  // Sync external value changes into composer and local state.
  useEffect(() => {
    const shouldSetComposer = value !== draftRef.current
    recordComposerDiagnostic('draft-external-sync', {
      sourceValueLength: value.length,
      draftLength: draftRef.current.length,
      shouldSetComposer,
    })
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
      cancelPendingFlush()
      cancelPendingFlushFrame()
      const pendingDraft = draftRef.current
      if (pendingDraft !== committedValueRef.current) {
        pendingChangeRef.current(pendingDraft)
      }
    }
  }, [cancelPendingFlush, cancelPendingFlushFrame, scopeKey])

  useEffect(() => {
    if (!insertion || appliedInsertionIdRef.current === insertion.id) return
    appliedInsertionIdRef.current = insertion.id
    draftEditVersionRef.current += 1
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
        draftEditVersionRef.current += 1
        onDraftEdit?.()
      }
      if (isComposingRef.current) {
        cancelPendingFlush()
        return
      }
      scheduleDraftFlush(nextDraft)
    },
    [cancelPendingFlush, onDraftEdit, scheduleDraftFlush]
  )

  // Flush after the next frame so the editor state settles first.
  const flushDraftNextFrame = useCallback(
    (reason: string) => {
      cancelPendingFlushFrame()
      recordComposerDiagnostic('draft-flush-request', {
        reason,
        draftLength: draftRef.current.length,
      })
      flushFrameRef.current = window.requestAnimationFrame(() => {
        flushFrameRef.current = null
        if (isComposingRef.current) return
        flushDraft(draftRef.current, reason)
      })
    },
    [cancelPendingFlushFrame, flushDraft]
  )
  const handleBlur = useCallback(() => flushDraftNextFrame('blur'), [flushDraftNextFrame])
  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true
    cancelPendingFlushFrame()
    cancelPendingFlush()
    onParentCompositionStart?.()
  }, [cancelPendingFlush, cancelPendingFlushFrame, onParentCompositionStart])
  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false
    cancelPendingFlushFrame()
    scheduleDraftFlush(draftRef.current, 'composition-end-debounce')
    onParentCompositionEnd?.()
  }, [cancelPendingFlushFrame, onParentCompositionEnd, scheduleDraftFlush])

  const handleSubmit = useCallback(
    (valueOverride?: string, options?: ChatSubmitOptions) => {
      const submittedDraft = valueOverride ?? draftRef.current
      const submittedDraftEditVersion = draftEditVersionRef.current
      const submittedScopeKey = scopeKey
      const submission =
        options === undefined ? onSubmit(submittedDraft) : onSubmit(submittedDraft, options)
      if (submittedDraft.trim()) {
        draftRef.current = ''
        cancelPendingFlush()
        setDraftState({ scopeKey, sourceValue: '', draft: '' })
        setComposerValue('', 0)
        onChange('')
      }
      const restoreSubmittedDraft = () => {
        if (!submittedDraft.trim()) return
        if (scopeKeyRef.current !== submittedScopeKey) return
        if (draftEditVersionRef.current !== submittedDraftEditVersion) return
        if (draftRef.current) return
        draftRef.current = submittedDraft
        cancelPendingFlush()
        setDraftState({ scopeKey, sourceValue: submittedDraft, draft: submittedDraft })
        setComposerValue(submittedDraft, submittedDraft.length)
        onChange(submittedDraft)
      }
      void Promise.resolve(submission).then(accepted => {
        if (accepted !== false) return
        restoreSubmittedDraft()
      }, restoreSubmittedDraft)
    },
    [cancelPendingFlush, onChange, onSubmit, scopeKey, setComposerValue]
  )

  return (
    <ChatInput
      {...props}
      ref={composerRef}
      value={draft}
      onChange={setDraft}
      onBlur={handleBlur}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onSubmit={handleSubmit}
    />
  )
})
