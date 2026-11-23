import type { KeyboardEvent, PointerEvent } from 'react'
import {
  clearEmbeddedBrowserAnnotations,
  readEmbeddedBrowserAnnotationState,
  startEmbeddedBrowserAnnotation,
  stopEmbeddedBrowserAnnotation,
} from '@/lib/embedded-browser'
import type { BrowserAnnotationState } from '@/types/browser-annotation'
import { browserAnnotationStateToContexts } from '@/lib/browser-annotation-context'
import type { BrowserSessionModel } from './workspaceBrowserSessionTypes'
import {
  type AnnotationEntry,
  logBrowserAnnotation,
  getFallbackBrowserTitle,
} from './workspaceBrowserSessionTypes'
export function createBrowserAnnotations(model: BrowserSessionModel) {
  const exitAnnotationMode = (): void => {
    if (!model.observed) return
    logBrowserAnnotation('exit annotation mode', {
      label: model.options.label,
      currentUrl: model.state.currentUrl,
      pendingCommentContextCount: model.pendingCommentContextCount,
      nativeBrowserOpen: model.runtime.nativeBrowserOpen,
    })
    model.set('annotationMode', false)
    model.set('originalViewHeld', false)
    void stopEmbeddedBrowserAnnotation(model.options.label).catch(error => {
      console.error('Failed to stop embedded browser annotation:', error)
    })
  }
  const applyAnnotationState = (state: BrowserAnnotationState): boolean => {
    if (!model.observed) return false
    if (state.label !== model.options.label) return false
    const incomingRuntimeRevision = state.runtimeRevision ?? 0
    const incomingPageSessionId = state.scope?.pageSessionId ?? null
    const currentVersion = model.runtime.annotationStateVersion
    const staleRuntime = incomingRuntimeRevision < currentVersion.runtimeRevision
    const staleRevision =
      incomingRuntimeRevision === currentVersion.runtimeRevision &&
      state.revision < currentVersion.revision
    const stalePageSession =
      incomingRuntimeRevision === currentVersion.runtimeRevision &&
      currentVersion.pageSessionId !== null &&
      incomingPageSessionId !== currentVersion.pageSessionId
    if (staleRuntime || staleRevision || stalePageSession) return false
    model.runtime.annotationStateVersion = {
      pageSessionId: incomingPageSessionId,
      revision: state.revision,
      runtimeRevision: incomingRuntimeRevision,
    }
    const activeMode = state.mode !== 'off'
    model.set('annotationMode', activeMode)
    model.set('annotations', state.comments)
    model.set('annotationRevision', state.revision)
    model.set('annotationRuntimeRevision', incomingRuntimeRevision)
    model.set('annotationOriginalView', state.originalView)
    if (!state.scope) return true
    const scope = { ...state.scope, browserTabId: model.options.browserTabId }
    const normalizedState = { ...state, scope }
    const contexts = browserAnnotationStateToContexts(
      normalizedState,
      model.activePageUrl ? getFallbackBrowserTitle(model.activePageUrl) : null
    )
    if (model.options.onReplaceBrowserCodeComments) {
      model.options.onReplaceBrowserCodeComments(scope, contexts)
    } else {
      contexts.forEach(context => model.options.onAddCodeComment?.(context))
    }
    return true
  }
  const enterAnnotationMode = async (request: AnnotationEntry = {}): Promise<void> => {
    const mode = request.mode ?? 'batch'
    logBrowserAnnotation('enter annotation mode requested', {
      label: model.options.label,
      active: model.options.active,
      currentUrl: model.state.currentUrl,
      mode,
      embeddedBrowserAvailable: model.embeddedBrowserAvailable,
      nativeBrowserOpen: model.runtime.nativeBrowserOpen,
    })
    if (
      model.internalExtensionPage ||
      !model.embeddedBrowserAvailable ||
      !model.runtime.nativeBrowserOpen ||
      !model.state.currentUrl
    ) {
      logBrowserAnnotation('enter annotation mode skipped', {
        label: model.options.label,
        active: model.options.active,
        currentUrl: model.state.currentUrl,
        embeddedBrowserAvailable: model.embeddedBrowserAvailable,
        nativeBrowserOpen: model.runtime.nativeBrowserOpen,
      })
      return
    }
    try {
      await startEmbeddedBrowserAnnotation(mode, model.options.label, request.point)
      const state = await readEmbeddedBrowserAnnotationState(model.options.label)
      if (!model.observed) return
      if (!model.actions.applyAnnotationState(state)) return
      model.set('annotationMode', true)
      logBrowserAnnotation('enter annotation mode succeeded', {
        label: model.options.label,
        currentUrl: model.state.currentUrl,
      })
    } catch (error) {
      console.error('Failed to enter embedded browser annotation mode:', error)
      logBrowserAnnotation('enter annotation mode failed', {
        label: model.options.label,
        currentUrl: model.state.currentUrl,
        error: error instanceof Error ? error.message : String(error),
      })
      model.set('status', 'error')
      model.set('error', model.options.t('workbench.browser_annotation_failed'))
    }
  }
  const holdOriginalView = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.nativeEvent.isTrusted) {
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId)
      } catch {
        // The native pointer may already have been released.
      }
    }
    model.set('originalViewHeld', true)
  }
  const releaseOriginalView = (event: PointerEvent<HTMLButtonElement>): void => {
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // The pointer may already have been released by the native host.
    }
    model.set('originalViewHeld', false)
  }
  const cancelOriginalView = (event: PointerEvent<HTMLButtonElement>): void => {
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // The pointer may already have been released by the native host.
    }
    model.set('originalViewHeld', false)
  }
  const blurOriginalView = (): void => {
    model.set('originalViewHeld', false)
  }
  const handleOriginalViewKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if ((event.key !== ' ' && event.key !== 'Enter') || event.repeat) return
    event.preventDefault()
    model.set('originalViewHeld', true)
  }
  const handleOriginalViewKeyUp = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    model.set('originalViewHeld', false)
  }
  const consumeAnnotationCommand = () => {
    if (
      !model.options.browserAnnotationCommand ||
      model.options.browserAnnotationCommand.sequence <= model.runtime.lastAnnotationCommandSequence
    ) {
      return
    }
    model.runtime.lastAnnotationCommandSequence = model.options.browserAnnotationCommand.sequence
    void clearEmbeddedBrowserAnnotations(model.options.label)
      .then(() => readEmbeddedBrowserAnnotationState(model.options.label))
      .then(state => {
        if (!model.actions.applyAnnotationState(state)) return
        if (state.scope) {
          model.options.onRemoveBrowserCodeComments?.({
            ...state.scope,
            browserTabId: model.options.browserTabId,
          })
        }
      })
      .catch(error => {
        console.error('Failed to execute browser annotation cleanup command:', error)
      })
      .finally(model.actions.exitAnnotationMode)
  }
  return {
    exitAnnotationMode,
    applyAnnotationState,
    enterAnnotationMode,
    holdOriginalView,
    releaseOriginalView,
    cancelOriginalView,
    blurOriginalView,
    handleOriginalViewKeyDown,
    handleOriginalViewKeyUp,
    consumeAnnotationCommand,
  }
}
