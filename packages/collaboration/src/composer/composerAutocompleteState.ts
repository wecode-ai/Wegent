import type { RefObject } from 'react'
import type { ComposerEditorHandle } from './ComposerProseMirrorEditor'
import type { ComposerTextTrigger } from './composerAutocomplete'

export interface ActiveComposerMenu {
  kind: ComposerTextTrigger['kind']
  trigger: ComposerTextTrigger
  symbol?: string
}
interface AutocompleteSnapshot {
  editorValue: string
  activeMenu: ActiveComposerMenu | null
  selectedIndex: number
  modelMenuOpen: boolean
  modelQuery: string
  modelSelectedIndex: number
  cloudProjectsOpen: boolean
}

/** Owns actual picker selection and explicit restore/focus commands for one editor. */
export function createComposerAutocompleteState(initialValue: string) {
  let snapshot: AutocompleteSnapshot = {
    editorValue: initialValue,
    activeMenu: null,
    selectedIndex: 0,
    modelMenuOpen: false,
    modelQuery: '',
    modelSelectedIndex: 0,
    cloudProjectsOpen: false,
  }
  const listeners = new Set<() => void>()
  let restoredValue: string | null = initialValue
  let focusExpiresAt = 0
  const update = (patch: Partial<AutocompleteSnapshot>) => {
    if (
      Object.entries(patch).every(
        ([key, value]) => snapshot[key as keyof AutocompleteSnapshot] === value
      )
    )
      return
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const close = () => update({ activeMenu: null, selectedIndex: 0 })
  return {
    getSnapshot: () => snapshot,
    getMentionQuery: () =>
      snapshot.activeMenu?.kind === 'mention' ? snapshot.activeMenu.trigger.query : '',
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setEditorValue: (editorValue: string) => update({ editorValue }),
    setActiveMenu(activeMenu: ActiveComposerMenu | null) {
      const current = snapshot.activeMenu
      if (
        current?.kind === activeMenu?.kind &&
        current?.trigger.kind === activeMenu?.trigger.kind &&
        current?.trigger.start === activeMenu?.trigger.start &&
        current?.trigger.query === activeMenu?.trigger.query &&
        current?.symbol === activeMenu?.symbol
      )
        return
      update({ activeMenu })
    },
    setSelectedIndex: (index: number | ((current: number) => number)) =>
      update({
        selectedIndex: typeof index === 'function' ? index(snapshot.selectedIndex) : index,
      }),
    setModelMenuOpen: (modelMenuOpen: boolean) => update({ modelMenuOpen }),
    setModelQuery: (modelQuery: string) => update({ modelQuery }),
    setModelSelectedIndex: (modelSelectedIndex: number) => update({ modelSelectedIndex }),
    setCloudProjectsOpen: (cloudProjectsOpen: boolean) => update({ cloudProjectsOpen }),
    close,
    isRestored: (value: string) => restoredValue === value,
    clearRestoredValue: () => {
      restoredValue = null
    },
    restoreValue(value: string) {
      restoredValue = value
      close()
    },
    requestFocus: () => {
      focusExpiresAt = Date.now() + 2_000
    },
    shouldFocusWhenReady: () => focusExpiresAt >= Date.now(),
  }
}
export type ComposerAutocompleteState = ReturnType<typeof createComposerAutocompleteState>

/** Bind compatibility reads to the widget and acknowledge snapshots without editing its document. */
export function createComposerEditorValuePort(
  editorRef: RefObject<ComposerEditorHandle | null>,
  state: ComposerAutocompleteState
) {
  return {
    get current() {
      const editor = editorRef.current
      return editor?.element ? editor.getSnapshot().value : state.getSnapshot().editorValue
    },
    set current(snapshotValue: string) {
      const editor = editorRef.current
      state.setEditorValue(editor?.element ? editor.getSnapshot().value : snapshotValue)
    },
  }
}
