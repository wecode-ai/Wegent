import assert from 'node:assert/strict'

export async function waitForUnreadBadge(
  control,
  count,
  timeoutMs,
  trayCount = count,
  expectedTaskId = null
) {
  const { platform } = JSON.parse(await control.command('getNativeWindowState', 'body'))
  const deadline = Date.now() + timeoutMs
  let latest
  const expectedTrayId = expectedTaskId ? `task:${expectedTaskId}` : null
  while (Date.now() < deadline) {
    latest = JSON.parse(await control.command('getTraySnapshot', 'body'))
    const unreadHeading = latest.menu.findIndex(item => item.id === 'heading:unread')
    const unreadItems = []
    if (unreadHeading >= 0) {
      for (const item of latest.menu.slice(unreadHeading + 1)) {
        if (item.type === 'separator') break
        if (item.id?.startsWith('task:')) unreadItems.push(item)
      }
    }
    const expectedBadge = platform === 'darwin' ? (count > 0 ? String(count) : '') : null
    if (
      unreadItems.length === trayCount &&
      (!expectedTrayId ||
        unreadItems.some(
          item => item.id === expectedTrayId || item.id?.endsWith(`:${expectedTaskId}`)
        )) &&
      latest.dockBadge === expectedBadge
    ) {
      const snapshot = JSON.parse(await control.command('snapshot', 'body'))
      const hasBellBadge = snapshot.testIds.includes('wework-notifications-unread')
      if (count === 0 && !hasBellBadge) return
      if (count > 0 && hasBellBadge) {
        const bellCount = await control.command(
          'getText',
          '[data-testid="wework-notifications-unread"]'
        )
        if (bellCount === String(count)) return
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(
    `Expected ${count} unread notifications, ${trayCount} unread tray tasks and matching Dock badge: ${JSON.stringify(latest)}`
  )
}
