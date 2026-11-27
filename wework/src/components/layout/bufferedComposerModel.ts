import type { ChatInputHandle, ChatSubmitOptions } from '@/components/chat/ChatInput'
import { recordComposerDiagnostic } from '@/components/chat/composer/composerDiagnostics'
import { subscribeMainWindowFocus } from '@/desktop/windowFocus'
import { focusEditorTarget } from '@wegent/collaboration/dom-events'
export const BUFFERED_COMPOSER_FOCUS_GUARD = {
  activeScope: {
    selector: '[data-active-workbench-pane]',
    matches: '[data-active-workbench-pane="true"]',
  },
  guardModalFocus: true,
}
export const BUFFERED_COMPOSER_AUTO_FOCUS_GUARD = {
  ...BUFFERED_COMPOSER_FOCUS_GUARD,
  onlyFromBodyOrTarget: true,
}
export interface BufferedComposerInput {
  value: string
  scopeKey?: string
  replaceDraftKey?: number
  insertion?: { id: number; text: string } | null
  onChange(value: string): unknown
  onSubmit(value: string, options?: ChatSubmitOptions): unknown
  onDraftEdit?(value: string): void
  onParentCompositionStart?(): void
  onParentCompositionEnd?(): void
  clearOnSubmit: boolean
  autoFocus?: boolean
  disabled?: boolean
}
const DRAFT_FLUSH_DELAY_MS = 300
export function createBufferedComposerModel(initial: BufferedComposerInput) {
  let {
    value,
    scopeKey,
    replaceDraftKey,
    insertion,
    onChange,
    onSubmit,
    onDraftEdit,
    onParentCompositionStart,
    onParentCompositionEnd,
    clearOnSubmit,
  } = initial
  let input = initial
  const listeners = new Set<() => void>()
  const composerRef = { current: null as ChatInputHandle | null }
  const draftRef = { current: value }
  let draftState = { scopeKey, sourceValue: value, draft: value }
  let snapshot = { draft: value, revision: 0 }
  const notify = () => {
    snapshot = { draft: draftRef.current, revision: snapshot.revision + 1 }
    listeners.forEach(listener => listener())
  }
  const setDraftState = (next: typeof draftState) => {
    const changed =
      next.scopeKey !== draftState.scopeKey ||
      next.sourceValue !== draftState.sourceValue ||
      next.draft !== draftState.draft
    draftState = next
    if (changed) notify()
  }
  let synchronousRevision = 0
  const setSynchronousPublicationRevision = (revision: number) => {
    synchronousRevision = revision
    notify()
  }
  const publishedDraftsRef = {
    current: new Map<
      string | undefined,
      Array<{ revision: number; value: string; appliedSynchronously: boolean }>
    >(),
  }
  const lastPublishedDraftRef = { current: { scopeKey, value } }
  const lastReplaceDraftKeyRef = { current: replaceDraftKey }
  const appliedInsertionIdRef = { current: null as number | null }
  const flushTimeoutRef = { current: null as number | null }
  const flushFrameRef = { current: null as number | null }
  const committedValueRef = { current: value }
  const committedScopeKeyRef = { current: scopeKey }
  const publishedDraftRevisionRef = { current: 0 }
  const pendingChangeRef = { current: onChange }
  const programmaticUpdateDepthRef = { current: 0 }
  const draftEditVersionRef = { current: 0 }
  const isComposingRef = { current: false }
  const scopeKeyRef = { current: scopeKey }
  const setComposerValue = (nextValue: string, cursor: number) => {
    programmaticUpdateDepthRef.current += 1
    composerRef.current?.setValue(nextValue, cursor)
    queueMicrotask(() => {
      programmaticUpdateDepthRef.current = Math.max(0, programmaticUpdateDepthRef.current - 1)
    })
  }
  const cancelPendingFlush = () => {
    if (flushTimeoutRef.current !== null) {
      window.clearTimeout(flushTimeoutRef.current)
      flushTimeoutRef.current = null
    }
  }
  const cancelPendingFlushFrame = () => {
    if (flushFrameRef.current !== null) {
      window.cancelAnimationFrame(flushFrameRef.current)
      flushFrameRef.current = null
    }
  }
  const publishDraft = (nextDraft: string, force = false) => {
    const publications = publishedDraftsRef.current.get(scopeKey) ?? []
    const lastPublished = lastPublishedDraftRef.current
    const alreadyCommitted =
      committedScopeKeyRef.current === scopeKey && committedValueRef.current === nextDraft
    // A late acknowledgement can require publishing the latest draft again.
    if (
      !force &&
      lastPublished.scopeKey === scopeKey &&
      lastPublished.value === nextDraft &&
      (alreadyCommitted || publications.at(-1)?.value === nextDraft)
    ) {
      return
    }
    lastPublishedDraftRef.current = { scopeKey, value: nextDraft }
    publishedDraftRevisionRef.current += 1
    const publication = {
      revision: publishedDraftRevisionRef.current,
      value: nextDraft,
      appliedSynchronously: false,
    }
    publications.push(publication)
    publishedDraftsRef.current.set(scopeKey, publications)
    const receipt = onChange(nextDraft)
    if (
      typeof receipt === 'object' &&
      receipt !== null &&
      'appliedSynchronously' in receipt &&
      receipt.appliedSynchronously === true
    ) {
      publication.appliedSynchronously = true
      // React may batch a return to the current value without changing the prop.
      setSynchronousPublicationRevision(publication.revision)
    }
  }
  const flushDraft = (nextDraft: string, reason: string) => {
    cancelPendingFlush()
    pendingChangeRef.current = onChange
    recordComposerDiagnostic('draft-flush', {
      reason,
      draftLength: nextDraft.length,
    })
    publishDraft(nextDraft)
  }
  const scheduleDraftFlush = (nextDraft: string, reason = 'debounce') => {
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
  }
  const setDraft = (nextDraft: string) => {
    draftRef.current = nextDraft
    if (programmaticUpdateDepthRef.current === 0) {
      draftEditVersionRef.current += 1
      onDraftEdit?.(nextDraft)
    }
    if (isComposingRef.current) {
      cancelPendingFlush()
      return
    }
    scheduleDraftFlush(nextDraft)
  }
  const flushDraftNextFrame = (reason: string) => {
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
  }
  const handleBlur = () => flushDraftNextFrame('blur')
  const handleCompositionStart = () => {
    isComposingRef.current = true
    cancelPendingFlushFrame()
    cancelPendingFlush()
    onParentCompositionStart?.()
  }
  const handleCompositionEnd = () => {
    isComposingRef.current = false
    cancelPendingFlushFrame()
    scheduleDraftFlush(draftRef.current, 'composition-end-debounce')
    onParentCompositionEnd?.()
  }
  const handleSubmit = (valueOverride?: string, options?: ChatSubmitOptions) => {
    const submittedDraft = valueOverride ?? draftRef.current
    const submittedDraftEditVersion = draftEditVersionRef.current
    const submittedScopeKey = scopeKey
    if (!clearOnSubmit) {
      cancelPendingFlushFrame()
      flushDraft(submittedDraft, 'submit')
    }
    const submission =
      options === undefined ? onSubmit(submittedDraft) : onSubmit(submittedDraft, options)
    if (clearOnSubmit && submittedDraft.trim()) {
      draftRef.current = ''
      cancelPendingFlush()
      // Keep the local draft tied to the owner's value until it acknowledges the edit.
      setDraftState({ ...draftState, draft: '' })
      setComposerValue('', 0)
      // The parent may already hold an empty value from before the local edit.
      publishDraft('', true)
    }
    const restoreSubmittedDraft = () => {
      if (!submittedDraft.trim()) return
      if (scopeKeyRef.current !== submittedScopeKey) return
      if (draftEditVersionRef.current !== submittedDraftEditVersion) return
      if (draftRef.current) return
      draftRef.current = submittedDraft
      cancelPendingFlush()
      setDraftState({ ...draftState, draft: submittedDraft })
      setComposerValue(submittedDraft, submittedDraft.length)
      publishDraft(submittedDraft)
    }
    void Promise.resolve(submission).then(accepted => {
      if (accepted !== false) return
      restoreSubmittedDraft()
    }, restoreSubmittedDraft)
  }
  const reconcileExternal = () => {
    const publications = publishedDraftsRef.current.get(scopeKey) ?? []
    const replacingDraft = lastReplaceDraftKeyRef.current !== replaceDraftKey
    const changingScope = committedScopeKeyRef.current !== scopeKey
    if (replacingDraft || changingScope) draftEditVersionRef.current += 1
    lastReplaceDraftKeyRef.current = replaceDraftKey
    committedScopeKeyRef.current = scopeKey
    const acknowledgedPublicationIndex = publications.findLastIndex(
      publication => publication.value === value
    )
    const acknowledgesPublishedDraft =
      !replacingDraft && !changingScope && acknowledgedPublicationIndex >= 0
    const shouldSetComposer =
      replacingDraft || (!acknowledgesPublishedDraft && value !== draftRef.current)
    recordComposerDiagnostic('draft-external-sync', {
      scopeKey: scopeKey ?? null,
      sourceValueLength: value.length,
      draftLength: draftRef.current.length,
      acknowledgesPublishedDraft,
      acknowledgedPublicationRevision: acknowledgesPublishedDraft
        ? publications[acknowledgedPublicationIndex]?.revision
        : null,
      shouldSetComposer,
    })
    committedValueRef.current = value
    // Restoring a draft must still ignore acknowledgements already in flight.
    if (replacingDraft) {
      cancelPendingFlush()
      cancelPendingFlushFrame()
      const pendingPublications = publications.filter(
        publication => !publication.appliedSynchronously
      )
      if (pendingPublications.length > 0) {
        publishedDraftsRef.current.set(scopeKey, pendingPublications)
      } else {
        publishedDraftsRef.current.delete(scopeKey)
      }
    } else if (acknowledgedPublicationIndex >= 0) {
      // Synchronous writes before this acknowledgement were superseded or batched.
      // Keep deferred publications, which can still arrive out of order.
      for (let index = acknowledgedPublicationIndex; index >= 0; index -= 1) {
        if (index === acknowledgedPublicationIndex || publications[index]!.appliedSynchronously) {
          publications.splice(index, 1)
        }
      }
      if (publications.length === 0) publishedDraftsRef.current.delete(scopeKey)
    } else {
      publishedDraftsRef.current.delete(scopeKey)
    }
    if (!acknowledgesPublishedDraft) {
      draftRef.current = value
      lastPublishedDraftRef.current = { scopeKey, value }
    }
    setDraftState({ scopeKey, sourceValue: value, draft: draftRef.current })
    if (shouldSetComposer) {
      setComposerValue(value, value.length)
    }
  }
  const applyInsertion = () => {
    if (!insertion || appliedInsertionIdRef.current === insertion.id) return
    appliedInsertionIdRef.current = insertion.id
    draftEditVersionRef.current += 1
    const currentDraft = draftRef.current
    const nextDraft = currentDraft ? `${currentDraft}\n${insertion.text}` : insertion.text
    draftRef.current = nextDraft
    onDraftEdit?.(nextDraft)
    setDraftState({ scopeKey, sourceValue: value, draft: nextDraft })
    setComposerValue(nextDraft, nextDraft.length)
    scheduleDraftFlush(nextDraft)
  }
  const flushDiscarded = () => {
    cancelPendingFlush()
    cancelPendingFlushFrame()
    if (draftRef.current !== committedValueRef.current) pendingChangeRef.current(draftRef.current)
  }
  let committedExternal:
    | { value: string; scopeKey?: string; replaceDraftKey?: number; revision: number }
    | undefined
  const commit = (next: BufferedComposerInput) => {
    if (next.scopeKey !== scopeKey) flushDiscarded()
    input = next
    ;({
      value,
      scopeKey,
      replaceDraftKey,
      insertion,
      onChange,
      onSubmit,
      onDraftEdit,
      onParentCompositionStart,
      onParentCompositionEnd,
      clearOnSubmit,
    } = next)
    scopeKeyRef.current = scopeKey
    const previous = committedExternal
    if (
      !previous ||
      previous.value !== value ||
      previous.scopeKey !== scopeKey ||
      previous.replaceDraftKey !== replaceDraftKey ||
      (previous.revision !== synchronousRevision &&
        publishedDraftsRef.current.get(scopeKey)?.some(publication => publication.value === value))
    ) {
      committedExternal = { value, scopeKey, replaceDraftKey, revision: synchronousRevision }
      reconcileExternal()
    }
    applyInsertion()
    observeWindowFocus()
  }
  let stopFocus: (() => void) | undefined
  let focusFrame: number | undefined
  function observeWindowFocus() {
    if (!listeners.size || !input.autoFocus || input.disabled) {
      stopFocus?.()
      stopFocus = undefined
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame)
      focusFrame = undefined
      return
    }
    if (stopFocus) return
    stopFocus = subscribeMainWindowFocus(focused => {
      if (!focused || !input.autoFocus || input.disabled) return
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame)
      focusFrame = window.requestAnimationFrame(() => {
        focusFrame = undefined
        if (!input.autoFocus || input.disabled) return
        focusEditorTarget(composerRef.current, BUFFERED_COMPOSER_AUTO_FOCUS_GUARD)
      })
    })
  }
  return {
    target: composerRef,
    getSnapshot: () => snapshot,
    getDraft: () => draftRef.current,
    preview(next: BufferedComposerInput) {
      const acknowledges = publishedDraftsRef.current
        .get(next.scopeKey)
        ?.some(publication => publication.value === next.value)
      return draftState.scopeKey === next.scopeKey &&
        lastReplaceDraftKeyRef.current === next.replaceDraftKey &&
        (draftState.sourceValue === next.value || acknowledges)
        ? draftRef.current
        : next.value
    },
    bind(target: ChatInputHandle | null, next: BufferedComposerInput, revision: number) {
      composerRef.current = target
      if (target && revision === snapshot.revision) commit(next)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      observeWindowFocus()
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        stopFocus?.()
        stopFocus = undefined
        if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame)
        focusFrame = undefined
        flushDiscarded()
      }
    },
    setDraft,
    handleBlur,
    handleCompositionStart,
    handleCompositionEnd,
    handleSubmit,
  }
}
