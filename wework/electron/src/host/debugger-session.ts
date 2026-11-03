import type { WebContents } from 'electron'

export type DebuggerSession = Pick<
  WebContents['debugger'],
  'attach' | 'detach' | 'isAttached' | 'sendCommand'
> & {
  on(event: 'detach', listener: () => void): unknown
  off(event: 'detach', listener: () => void): unknown
}

export interface DebuggerTarget {
  debugger: DebuggerSession
}

export interface DebuggerLease {
  session: DebuggerSession
  isActive(): boolean
  release(): void
}

interface SessionState {
  references: number
  owned: boolean
  invalidate: () => void
}

const sessions = new WeakMap<DebuggerSession, SessionState>()

function createSessionState(session: DebuggerSession): SessionState {
  const owned = !session.isAttached()
  if (owned) session.attach('1.3')
  const state: SessionState = {
    references: 0,
    owned,
    invalidate: () => {
      if (sessions.get(session) === state) sessions.delete(session)
      session.off('detach', state.invalidate)
    },
  }
  sessions.set(session, state)
  session.on('detach', state.invalidate)
  return state
}

export function acquireDebuggerSession(target: DebuggerTarget): DebuggerLease {
  const session = target.debugger
  let state = sessions.get(session)
  if (state && !session.isAttached()) {
    state.invalidate()
    state = undefined
  }
  const current = state ?? createSessionState(session)
  current.references += 1
  let released = false
  return {
    session,
    isActive: () => !released && sessions.get(session) === current && session.isAttached(),
    release: () => {
      if (released) return
      released = true
      current.references -= 1
      if (current.references || sessions.get(session) !== current) return
      current.invalidate()
      if (current.owned && session.isAttached()) session.detach()
    },
  }
}

export async function withDebuggerSession<T>(
  target: DebuggerTarget,
  operation: (session: DebuggerSession) => Promise<T>
): Promise<T> {
  const lease = acquireDebuggerSession(target)
  try {
    return await operation(lease.session)
  } finally {
    lease.release()
  }
}
