import type { WebContents } from 'electron'
import {
  acquireDebuggerSession,
  withDebuggerSession,
  type DebuggerTarget,
} from './debugger-session.js'

type MediaTarget = Pick<WebContents, 'isDestroyed'> & DebuggerTarget
type MediaLease = ReturnType<typeof acquireDebuggerSession>

const mediaLeases = new WeakMap<DebuggerTarget['debugger'], MediaLease>()
const pendingUpdates = new WeakMap<DebuggerTarget['debugger'], Promise<void>>()

export function setReducedMotion(target: MediaTarget, preference: string): Promise<void> {
  if (!['reduce', 'no-preference', 'system'].includes(preference)) {
    return Promise.reject(new Error(`Invalid reduced-motion preference: ${preference}`))
  }
  const session = target.debugger
  const previous = pendingUpdates.get(session) ?? Promise.resolve()
  const update = previous.catch(() => undefined).then(() => applyReducedMotion(target, preference))
  pendingUpdates.set(session, update)
  const clearPending = () => {
    if (pendingUpdates.get(session) === update) pendingUpdates.delete(session)
  }
  void update.then(clearPending, clearPending)
  return update
}

async function applyReducedMotion(target: MediaTarget, preference: string): Promise<void> {
  if (target.isDestroyed()) throw new Error('Desktop media target is unavailable')
  const session = target.debugger
  let lease = mediaLeases.get(session)
  if (lease && !lease.isActive()) {
    lease.release()
    mediaLeases.delete(session)
    lease = undefined
  }
  if (preference === 'system' && !lease) {
    if (session.isAttached()) {
      await withDebuggerSession(target, session =>
        session.sendCommand('Emulation.setEmulatedMedia', { features: [] })
      )
    }
    return
  }
  lease ??= acquireDebuggerSession(target)
  mediaLeases.set(session, lease)
  try {
    await lease.session.sendCommand('Emulation.setEmulatedMedia', {
      features:
        preference === 'system' ? [] : [{ name: 'prefers-reduced-motion', value: preference }],
    })
  } catch (error) {
    mediaLeases.delete(session)
    lease.release()
    throw error
  }
  if (preference === 'system') {
    mediaLeases.delete(session)
    lease.release()
  }
}
