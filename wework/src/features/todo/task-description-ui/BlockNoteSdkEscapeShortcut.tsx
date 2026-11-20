import { useBlockNoteSdkPopups } from './blockNoteSdkPopupPresence'
import { useBlockNoteEditor } from '@blocknote/react'
import { useShortcut } from '@ui-sdk/react/shortcuts'

export function BlockNoteSdkEscapeShortcut() {
  const editor = useBlockNoteEditor()
  const popups = useBlockNoteSdkPopups()
  useShortcut('Escape', () => editor.blur(), {
    allowInInput: true,
    layer: () => editor.domElement,
    when: () => editor.isFocused() && popups.size === 0,
  })
  return null
}
