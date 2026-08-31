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
  hasWorkbenchComposerFocusRequest,
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
  const draftRef = useRef(draftState.draft)
  const draft =
    draftState.scopeKey === scopeKey && draftState.sourceValue === value ? draftRef.current : value
  const appliedInsertionIdRef = useRef<number | null>(null)
  const flushTimeoutRef = useRef<number | null>(null)
  const flushFrameRef = useRef<number | null>(null)
  const composerRef = useRef<ChatInputHandle>(null)
  const focusConsumerIdRef = useRef(Symbol('workbench-composer-focus'))
  const committedValueRef = useRef(value)
  const publishedDraftRevisionRef = useRef(0)
  const publishedDraftsRef = useRef(
    new Map<string | undefined, Array<{ revision: number; value: string }>>()
  )
  const pendingChangeRef = useRef(onChange)
  const programmaticUpdateDepthRef = useRef(0)
  const draftEditVersionRef = useRef(0)
  const isComposingRef = useRef(false)
  const scopeKeyRef = useRef(scopeKey)
  scopeKeyRef.current = scopeKey

  useLayoutEffect(() => {
    const focusComposer = () => {
      const composer = composerRef.current
      if (!composer) return false
      const element = composer.element
      const pane = element?.closest<HTMLElement>('[data-active-workbench-pane]')
      if (pane?.dataset.activeWorkbenchPane !== 'true') return false
      if (element?.closest('[hidden], [aria-hidden="true"]')) return false
      composer.focus()
      return true
    }
    const focusRequestedComposer = (event: Event) => {
      const detail = (event as CustomEvent<WorkbenchComposerFocusDetail>).detail
      if (props.disabled || !scopeKey || detail?.scopeKey !== scopeKey) return
      if (!hasWorkbenchComposerFocusRequest(scopeKey, focusConsumerIdRef.current)) return
      if (!focusComposer()) return
      consumeWorkbenchComposerFocusRequest(scopeKey, focusConsumerIdRef.current)
    }
    window.addEventListener(WORKBENCH_COMPOSER_FOCUS_EVENT, focusRequestedComposer)
    if (
      !props.disabled &&
      scopeKey &&
      hasWorkbenchComposerFocusRequest(scopeKey, focusConsumerIdRef.current) &&
      focusComposer()
    ) {
      consumeWorkbenchComposerFocusRequest(scopeKey, focusConsumerIdRef.current)
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

  const publishDraft = useCallback(
    (nextDraft: string) => {
      publishedDraftRevisionRef.current += 1
      const publications = publishedDraftsRef.current.get(scopeKey) ?? []
      publications.push({ revision: publishedDraftRevisionRef.current, value: nextDraft })
      publishedDraftsRef.current.set(scopeKey, publications)
      onChange(nextDraft)
    },
    [onChange, scopeKey]
  )

  const flushDraft = useCallback(
    (nextDraft: string, reason: string) => {
      cancelPendingFlush()
      pendingChangeRef.current = onChange
      recordComposerDiagnostic('draft-flush', {
        reason,
        draftLength: nextDraft.length,
      })
      publishDraft(nextDraft)
    },
    [cancelPendingFlush, onChange, publishDraft]
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
        publishDraft(nextDraft)
      }, DRAFT_FLUSH_DELAY_MS)
    },
    [cancelPendingFlush, onChange, publishDraft]
  )

  // Sync external value changes into composer and local state.
  useEffect(() => {
    const publications = publishedDraftsRef.current.get(scopeKey) ?? []
    const acknowledgedPublicationIndex = publications.findLastIndex(
      publication => publication.value === value
    )
    const acknowledgesPublishedDraft = acknowledgedPublicationIndex >= 0
    const shouldSetComposer = !acknowledgesPublishedDraft && value !== draftRef.current
    recordComposerDiagnostic('draft-external-sync', {
      sourceValueLength: value.length,
      draftLength: draftRef.current.length,
      acknowledgesPublishedDraft,
      acknowledgedPublicationRevision: acknowledgesPublishedDraft
        ? publications[acknowledgedPublicationIndex]?.revision
        : null,
      shouldSetComposer,
    })
    committedValueRef.current = value
    if (acknowledgesPublishedDraft) {
      publications.splice(0, acknowledgedPublicationIndex + 1)
      if (publications.length === 0) publishedDraftsRef.current.delete(scopeKey)
      setDraftState({ scopeKey, sourceValue: value, draft: draftRef.current })
    } else {
      publishedDraftsRef.current.delete(scopeKey)
      draftRef.current = value
      setDraftState({ scopeKey, sourceValue: value, draft: value })
    }
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
        publishDraft('')
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
        publishDraft(submittedDraft)
      }
      void Promise.resolve(submission).then(accepted => {
        if (accepted !== false) return
        restoreSubmittedDraft()
      }, restoreSubmittedDraft)
    },
    [cancelPendingFlush, onSubmit, publishDraft, scopeKey, setComposerValue]
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
