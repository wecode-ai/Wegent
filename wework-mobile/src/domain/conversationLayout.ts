const MIN_COMPOSER_BOTTOM_SPACING = 8

export function composerBottomSpacing(safeAreaBottom: number, keyboardVisible: boolean): number {
  return keyboardVisible
    ? MIN_COMPOSER_BOTTOM_SPACING
    : Math.max(safeAreaBottom, MIN_COMPOSER_BOTTOM_SPACING)
}
