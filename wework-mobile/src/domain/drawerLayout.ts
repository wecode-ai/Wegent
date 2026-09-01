export const DRAWER_HEADER_HEIGHT = 64
export const DRAWER_HEADER_BUTTON_SIZE = 48
export const DRAWER_EDGE_INSET = 8

const headerButtonInset = (DRAWER_HEADER_HEIGHT - DRAWER_HEADER_BUTTON_SIZE) / 2

export function drawerTopPadding(safeAreaTop: number): number {
  return Math.max(safeAreaTop - headerButtonInset, DRAWER_EDGE_INSET)
}

export function drawerBottomOffset(safeAreaBottom: number, keyboardVisible: boolean): number {
  if (keyboardVisible) return DRAWER_EDGE_INSET
  return Math.max(safeAreaBottom - DRAWER_EDGE_INSET, DRAWER_EDGE_INSET)
}
