import type { WebContents } from 'electron'

type MediaTarget = Pick<WebContents, 'isDestroyed'> & {
  debugger: Pick<WebContents['debugger'], 'attach' | 'detach' | 'isAttached' | 'sendCommand'>
}

const ownedSessions = new WeakSet<MediaTarget>()

export async function setReducedMotion(target: MediaTarget, preference: string): Promise<void> {
  if (!['reduce', 'no-preference', 'system'].includes(preference)) {
    throw new Error(`Invalid reduced-motion preference: ${preference}`)
  }
  if (target.isDestroyed()) throw new Error('Desktop media target is unavailable')
  const session = target.debugger
  if (!session.isAttached()) {
    if (preference === 'system') return
    session.attach('1.3')
    ownedSessions.add(target)
  }
  try {
    await session.sendCommand('Emulation.setEmulatedMedia', {
      features:
        preference === 'system' ? [] : [{ name: 'prefers-reduced-motion', value: preference }],
    })
  } catch (error) {
    if (ownedSessions.delete(target) && session.isAttached()) session.detach()
    throw error
  }
  if (preference === 'system' && ownedSessions.delete(target) && session.isAttached()) {
    session.detach()
  }
}
