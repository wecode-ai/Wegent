export const controlTrigger =
  'inline-flex min-h-11 min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-left text-sm text-text-primary outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 disabled:cursor-not-allowed disabled:opacity-40 md:min-h-9'
export const controlPopupLayout =
  'max-h-[min(360px,var(--available-height))] max-w-[calc(100vw-1rem)] overflow-y-auto p-1'
export const controlPopupSurface =
  'z-system-popover rounded-xl border border-border bg-popover text-text-primary shadow-lg outline-none'
export const controlPopup = `${controlPopupLayout} ${controlPopupSurface}`
export const controlMenuOption =
  'min-h-11 rounded-lg text-sm font-normal outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-focus/40 hover:bg-muted data-[highlighted]:bg-muted data-[selected]:font-medium data-[checked]:font-medium data-[destructive]:text-destructive data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 md:min-h-8'
export const controlOption =
  'flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-text-primary outline-none hover:bg-muted data-[highlighted]:bg-muted data-[selected]:font-medium data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 md:min-h-8'
export const controlInput =
  'min-h-11 min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none placeholder:text-text-secondary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 disabled:cursor-not-allowed disabled:opacity-40 md:min-h-9'

export type ControlDensity = 'default' | 'compact' | 'dense'
export type ControlAppearance = 'outline' | 'plain'

export const controlFieldDensity: Record<ControlDensity, string> = {
  default: 'min-h-11 md:min-h-9',
  compact: 'min-h-11 px-2.5 md:min-h-8',
  dense: 'min-h-11 px-2 md:min-h-7',
}

export const controlFieldAppearance: Record<ControlAppearance, string> = {
  outline: 'border border-border bg-background',
  plain: 'border-0 bg-transparent px-0 shadow-none',
}

export const controlActionDensity: Record<ControlDensity, string> = {
  default: 'h-11 min-h-11 md:h-9 md:min-h-9',
  compact: 'h-11 min-h-11 md:h-8 md:min-h-8',
  dense: 'h-11 min-h-11 md:h-7 md:min-h-7',
}
export const controlIconActionDensity: Record<ControlDensity, string> = {
  default: controlActionDensity.default + ' w-11 min-w-11 p-0 md:w-9 md:min-w-9',
  compact: controlActionDensity.compact + ' w-11 min-w-11 p-0 md:w-8 md:min-w-8',
  dense: controlActionDensity.dense + ' w-11 min-w-11 p-0 md:w-7 md:min-w-7',
}
export const controlMenuTriggerDensity: Record<ControlDensity, string> = {
  default: controlActionDensity.default + ' min-w-11 md:min-w-9',
  compact: controlActionDensity.compact + ' min-w-11 md:min-w-8',
  dense: controlActionDensity.dense + ' min-w-11 md:min-w-7',
}
export const composerActionDensity = controlActionDensity.dense
export const composerIconActionDensity = controlIconActionDensity.dense
