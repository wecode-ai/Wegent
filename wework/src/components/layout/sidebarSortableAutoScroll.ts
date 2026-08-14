export function getSidebarAutoScrollConfiguration(externalDragEnabled: boolean) {
  return externalDragEnabled
    ? { enabled: false, layoutShiftCompensation: false }
    : { enabled: true }
}
