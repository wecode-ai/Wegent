export const POPOUT_WINDOW_SIZES = {
  composer: { width: 470, height: 112 },
  menu: { width: 470, height: 420 },
  conversation: { width: 760, height: 640 },
} as const

export type PopoutWindowMode = keyof typeof POPOUT_WINDOW_SIZES

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export function popoutWindowBounds(
  current: Bounds,
  workArea: Bounds,
  previousMode: PopoutWindowMode,
  mode: PopoutWindowMode
): Bounds {
  const desired = POPOUT_WINDOW_SIZES[mode]
  const width = Math.min(desired.width, workArea.width)
  const height = Math.min(desired.height, workArea.height)
  const keepComposerBottom = previousMode !== 'conversation' && mode !== 'conversation'
  const preferredX = Math.round(current.x + (current.width - width) / 2)
  const preferredY = Math.round(
    current.y + (keepComposerBottom ? current.height - height : (current.height - height) / 2)
  )

  return {
    x: Math.max(workArea.x, Math.min(preferredX, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(preferredY, workArea.y + workArea.height - height)),
    width,
    height,
  }
}
