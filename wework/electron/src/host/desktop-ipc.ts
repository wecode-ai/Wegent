import { HostCapabilityError } from './capability-router.js'

interface Sender {
  sender: { id: number; isDestroyed(): boolean; mainFrame: unknown }
  senderFrame: { url: string } | null
}

/** A registered top-level application frame establishes identity; request headers never do. */
export function assertDesktopIpcSender(event: Sender, origins: ReadonlyMap<number, string>): void {
  const expected = origins.get(event.sender.id)
  if (
    !expected ||
    event.sender.isDestroyed() ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame
  )
    throw denied()
  try {
    const actual = new URL(event.senderFrame.url)
    const trusted = new URL(expected)
    if (
      actual.origin !== trusted.origin ||
      actual.protocol !== trusted.protocol ||
      actual.username ||
      actual.password
    )
      throw denied()
  } catch {
    throw denied()
  }
}

function denied(): HostCapabilityError {
  return new HostCapabilityError(
    'capability_denied',
    'This operation requires a trusted application window'
  )
}
