import { forwardRef } from 'react'
import {
  ComposerProseMirrorEditor as SharedComposerProseMirrorEditor,
  type ComposerEditorHandle,
  type ComposerProseMirrorEditorProps,
} from '@wegent/collaboration/composer'
import { getDesktopComposerEditorServices } from './desktopComposerServices'

export type { ComposerEditorHandle, ComposerEditorSnapshot } from '@wegent/collaboration/composer'

export const ComposerProseMirrorEditor = forwardRef<
  ComposerEditorHandle,
  Omit<ComposerProseMirrorEditorProps, 'services'>
>(function ComposerProseMirrorEditor(props, ref) {
  return (
    <SharedComposerProseMirrorEditor
      {...props}
      ref={ref}
      services={getDesktopComposerEditorServices()}
    />
  )
})
