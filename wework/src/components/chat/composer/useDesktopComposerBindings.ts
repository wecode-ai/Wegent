import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { getDshExtensionHost } from '@/features/dsh-runtime/dshExtensions'
import { FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT } from '@/features/plugins/pluginTrial'
import { WORKBENCH_NEW_CHAT_FOCUS_EVENT } from '@/lib/workbenchComposerFocus'
import { OPEN_COMPOSER_SLASH_MENU_EVENT } from './composerEvents'
import type { ComposerEditorHandle } from './ComposerProseMirrorEditor'
export function useDesktopComposerBindings({
  value,
  valueRef,
  editorRef,
  textareaRef,
  commitEditorValue,
  closeAutocompleteMenu,
}: {
  value: string
  valueRef: RefObject<string>
  editorRef: RefObject<ComposerEditorHandle | null>
  textareaRef: RefObject<HTMLElement | null>
  commitEditorValue(value: string, cursor: number): void
  closeAutocompleteMenu(): void
}) {
  useEffect(() => {
    const composer = getDshExtensionHost()?.composer
    if (!composer || typeof composer.bind !== 'function') return
    return composer.bind({
      focus: () => editorRef.current?.focus(),
      getValue: () => editorRef.current?.getSnapshot().value ?? valueRef.current,
      insertText: text => {
        const editor = editorRef.current
        if (!editor) return
        const current = editor.getSnapshot()
        const inserted =
          current.value.slice(0, current.selectionStart) +
          text +
          current.value.slice(current.selectionEnd)
        commitEditorValue(inserted, current.selectionStart + text.length)
        editor.focus()
      },
      setValue: (nextValue, selectionOffset = nextValue.length) => {
        commitEditorValue(nextValue, selectionOffset)
        editorRef.current?.focus()
      },
    })
  }, [commitEditorValue, editorRef, valueRef])

  useEffect(() => {
    const openSlashMenu = () => {
      const editor = editorRef.current
      if (!editor) return
      const snapshot = editor.getSnapshot()
      const before = snapshot.value.slice(0, snapshot.selectionStart)
      const after = snapshot.value.slice(snapshot.selectionEnd)
      const spacer = before && !/\s$/.test(before) ? ' ' : ''
      const inserted = `${spacer}/`
      commitEditorValue(`${before}${inserted}${after}`, before.length + inserted.length)
      editor.focus()
      textareaRef.current?.focus()
    }
    window.addEventListener(OPEN_COMPOSER_SLASH_MENU_EVENT, openSlashMenu)
    return () => window.removeEventListener(OPEN_COMPOSER_SLASH_MENU_EVENT, openSlashMenu)
  }, [commitEditorValue, editorRef, textareaRef])

  const pendingTrialFocusExpectedRef = useRef<string | null>(null)

  const focusTrialComposer = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.setValue(valueRef.current, valueRef.current.length)
    editor.focus()
    closeAutocompleteMenu()
  }, [closeAutocompleteMenu, editorRef, valueRef])

  useEffect(() => {
    const handleFocusRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ expectedValue?: string }>).detail
      const expectedValue = detail?.expectedValue
      if (expectedValue && expectedValue !== valueRef.current) {
        pendingTrialFocusExpectedRef.current = expectedValue
        return
      }
      pendingTrialFocusExpectedRef.current = null
      focusTrialComposer()
    }

    window.addEventListener(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, handleFocusRequest)
    return () => {
      window.removeEventListener(FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT, handleFocusRequest)
    }
  }, [focusTrialComposer, valueRef])

  useEffect(() => {
    const expectedValue = pendingTrialFocusExpectedRef.current
    if (!expectedValue || expectedValue !== value) return
    pendingTrialFocusExpectedRef.current = null
    focusTrialComposer()
  }, [focusTrialComposer, value])

  useEffect(() => {
    let focusFrame: number | null = null
    const handleNewChatFocusRequest = () => {
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame)
      focusFrame = window.requestAnimationFrame(() => {
        focusFrame = null
        const editor = editorRef.current
        if (!editor) return
        editor.setValue(valueRef.current, valueRef.current.length)
        editor.focus()
        closeAutocompleteMenu()
      })
    }

    window.addEventListener(WORKBENCH_NEW_CHAT_FOCUS_EVENT, handleNewChatFocusRequest)
    return () => {
      window.removeEventListener(WORKBENCH_NEW_CHAT_FOCUS_EVENT, handleNewChatFocusRequest)
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame)
    }
  }, [closeAutocompleteMenu, editorRef, valueRef])
}
