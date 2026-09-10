import type { Dock } from 'electron'

export function syncDockBadge(
  dock: Pick<Dock, 'getBadge' | 'setBadge'> | undefined,
  unreadCount: number,
  idleBadge = ''
): void {
  if (!dock) return
  const badge = unreadCount > 0 ? String(unreadCount) : idleBadge
  if (dock.getBadge() !== badge) dock.setBadge(badge)
}
