import { useCallback, useImperativeHandle, useMemo, useState, type RefObject } from 'react'
import { useDOMEvent, useEditorFocusRequest } from '@wegent/collaboration/dom-events'
import type { WeworkComposerCommandApi } from '../../../../dsh/app-wework/client'
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
  const bindComposer = useCallback((controller: WeworkComposerCommandApi | null) => {
    const composer = getDshExtensionHost()?.composer
    if (!controller || !composer || typeof composer.bind !== 'function') return
    return composer.bind(controller)
  }, [])
  useImperativeHandle(
    bindComposer,
    () => ({
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
    }),
    [commitEditorValue, editorRef, valueRef]
  )

  useDOMEvent('window', OPEN_COMPOSER_SLASH_MENU_EVENT, () => {
    const editor = editorRef.current
    if (!editor) return
    const snapshot = editor.getSnapshot()
    const before = snapshot.value.slice(0, snapshot.selectionStart)
    const after = snapshot.value.slice(snapshot.selectionEnd)
    const spacer = before && !/\s$/.test(before) ? ' ' : ''
    const inserted = spacer + '/'
    commitEditorValue(before + inserted + after, before.length + inserted.length)
    editor.focus()
    textareaRef.current?.focus()
  })

  const [trialFocus, setTrialFocus] = useState<{ expectedValue: string } | null>(null)
  const [newChatFocus, setNewChatFocus] = useState<object | null>(null)
  const focusTarget = useMemo(
    () => ({
      get current() {
        const editor = editorRef.current
        if (!editor) return null
        return {
          get element() {
            return editor.element
          },
          focus() {
            editor.setValue(valueRef.current, valueRef.current.length)
            editor.focus()
          },
        }
      },
    }),
    [editorRef, valueRef]
  )
  const focusTrialComposer = useCallback(() => {
    const editor = focusTarget.current
    if (!editor) return
    editor.focus()
    closeAutocompleteMenu()
  }, [closeAutocompleteMenu, focusTarget])
  const finishTrialFocus = useCallback(() => {
    setTrialFocus(null)
    closeAutocompleteMenu()
  }, [closeAutocompleteMenu])
  const finishNewChatFocus = useCallback(() => {
    setNewChatFocus(null)
    closeAutocompleteMenu()
  }, [closeAutocompleteMenu])
  useEditorFocusRequest(focusTarget, trialFocus, {
    enabled: trialFocus !== null && trialFocus.expectedValue === value,
    onFocused: finishTrialFocus,
  })
  useEditorFocusRequest(focusTarget, newChatFocus, {
    enabled: newChatFocus !== null,
    animationFrame: true,
    onFocused: finishNewChatFocus,
  })
  useDOMEvent<CustomEvent<{ expectedValue?: string }>>(
    'window',
    FOCUS_PLUGIN_TRIAL_COMPOSER_EVENT,
    event => {
      const expectedValue = event.detail?.expectedValue
      if (expectedValue && expectedValue !== valueRef.current) {
        setTrialFocus({ expectedValue })
        return
      }
      setTrialFocus(null)
      focusTrialComposer()
    }
  )
  useDOMEvent('window', WORKBENCH_NEW_CHAT_FOCUS_EVENT, () => setNewChatFocus({}))
}
