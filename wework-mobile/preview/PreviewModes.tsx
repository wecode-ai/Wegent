import { useLayoutEffect, useRef } from 'react'
import { canSwitchPreviewMode, type PreviewEvent, type PreviewState } from './protocol'
import { mountPreviewModes, previewModeStyles } from './modeControls'

export function PreviewModes({
  state,
  post,
}: {
  state: PreviewState
  post: (event: PreviewEvent) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const visible = canSwitchPreviewMode(state)
  useLayoutEffect(() => {
    if (host.current)
      mountPreviewModes(
        host.current,
        state.mode,
        state.theme,
        mode => post({ type: 'mode', mode }),
        previewModeStyles
      )
  }, [state.mode, state.theme, post, visible])
  return visible ? <div ref={host} className="preview-modes" /> : null
}
