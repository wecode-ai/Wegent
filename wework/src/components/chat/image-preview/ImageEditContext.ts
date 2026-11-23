import {
  createContext,
  createElement,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { ImageComment, ImageEdit } from './imageEdit'

export interface SavedImageMarkup {
  attachmentId: number
  file: File
  comments: ImageComment[]
}

const activeImageEditors = new Map<string, ImageEditActions>()
const imageEditorListeners = new Set<() => void>()

function subscribeImageEditors(listener: () => void) {
  imageEditorListeners.add(listener)
  return () => imageEditorListeners.delete(listener)
}

function publishImageEditors() {
  for (const listener of imageEditorListeners) listener()
}

function registerImageEditor(actions: ImageEditActions) {
  if (!actions.scope || activeImageEditors.get(actions.scope) === actions) return
  activeImageEditors.set(actions.scope, actions)
  publishImageEditors()
}

function unregisterImageEditor(actions: ImageEditActions) {
  if (!actions.scope || activeImageEditors.get(actions.scope) !== actions) return
  activeImageEditors.delete(actions.scope)
  publishImageEditors()
}

export function useScopedImageEditor(scope?: string): ImageEditActions | null {
  return useSyncExternalStore(
    subscribeImageEditors,
    () => (scope ? (activeImageEditors.get(scope) ?? null) : null),
    () => null
  )
}

export interface ImageEditActions {
  scope?: string
  saveMarkup?(
    attachmentId: number,
    loadFile: () => Promise<File>,
    edit: Extract<ImageEdit, { kind: 'markup' }>,
    signal: AbortSignal
  ): Promise<SavedImageMarkup | null>
  submit(
    source: {
      name: string
      mimeType: string
      loadFile(): Promise<File>
      draftAttachmentId?: number
    },
    edit: ImageEdit
  ): Promise<boolean>
}

export const ImageEditContext = createContext<ImageEditActions | null>(null)

export function ImageEditProvider({
  actions,
  children,
}: {
  actions: ImageEditActions | null
  children: ReactNode
}) {
  const register = useCallback(
    (element: HTMLElement | null) => {
      if (!actions) return
      if (element) registerImageEditor(actions)
      else unregisterImageEditor(actions)
    },
    [actions]
  )
  return createElement(
    ImageEditContext.Provider,
    { value: actions },
    createElement('span', { hidden: true, 'aria-hidden': true, ref: register }),
    children
  )
}
