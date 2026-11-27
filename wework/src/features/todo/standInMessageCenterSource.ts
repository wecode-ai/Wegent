import type {
  MessageCenterCommand,
  MessageCenterScope,
  MessageCenterSnapshot,
  StandInMessageCenterApi,
} from '@/api/standInMessageCenter'

export const unavailableMessageCenterSnapshot: MessageCenterSnapshot = {
  identity: null,
  deviceName: '',
  updatedAt: null,
  status: 'unavailable',
  records: [],
  sources: [],
  policyVersion: null,
  capabilities: [],
}

function scopedSnapshot(snapshot: MessageCenterSnapshot): MessageCenterSnapshot {
  if (snapshot.identity?.id.trim()) return snapshot
  const { status } = snapshot
  return {
    ...unavailableMessageCenterSnapshot,
    deviceName: snapshot.deviceName,
    status:
      status === 'disconnected' || status === 'offline' || status === 'component_unavailable'
        ? status
        : 'unavailable',
    capabilities: snapshot.capabilities.filter(capability => capability === 'refresh'),
  }
}

type CenterState = {
  snapshot: MessageCenterSnapshot | null
  loading: boolean
  error: boolean
  busy: boolean
  actionError: boolean
}

const initialState: CenterState = {
  snapshot: null,
  loading: true,
  error: false,
  busy: false,
  actionError: false,
}

export function createStandInMessageCenterSource(
  api: StandInMessageCenterApi,
  scope: MessageCenterScope
) {
  let state = initialState
  const listeners = new Set<() => void>()
  let release: (() => void) | undefined
  let revision = 0
  let pending: symbol | undefined

  const publish = (patch: Partial<CenterState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  const read = async (change: 'identity' | 'facts') => {
    if (!listeners.size) return
    const requested = ++revision
    if (change === 'identity') {
      pending = undefined
      publish(initialState)
    } else if (state.error) {
      publish({ error: false, loading: true })
    }
    try {
      const snapshot = scopedSnapshot(await api.read(scope))
      if (requested !== revision) return
      const identityChanged = state.snapshot?.identity?.id !== snapshot.identity?.id
      if (identityChanged) pending = undefined
      publish({
        snapshot,
        loading: false,
        error: false,
        ...(identityChanged ? { busy: false, actionError: false } : {}),
      })
    } catch {
      if (requested === revision) publish({ snapshot: null, loading: false, error: true })
    }
  }

  const connect = () => {
    if (!listeners.size || release) return
    const previous = revision
    let connected = true
    try {
      const unsubscribe = api.subscribeInvalidation(scope, (change, identityId) => {
        if (!connected) return
        const sameIdentity = identityId && identityId === state.snapshot?.identity?.id
        void read(sameIdentity ? 'facts' : change)
      })
      release = () => {
        connected = false
        unsubscribe()
      }
      if (revision === previous) void read('identity')
    } catch {
      connected = false
      ++revision
      publish({ snapshot: null, loading: false, error: true })
    }
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    if (listeners.size === 1) connect()
    return () => {
      listeners.delete(listener)
      if (listeners.size) return
      ++revision
      pending = undefined
      state = initialState
      release?.()
      release = undefined
    }
  }

  const apply = async (command: MessageCenterCommand): Promise<boolean> => {
    const snapshot = state.snapshot
    if (
      pending ||
      !snapshot?.identity ||
      snapshot.policyVersion === null ||
      !snapshot.capabilities.includes(command.type)
    ) {
      return false
    }
    const expected = {
      identityId: snapshot.identity.id,
      policyVersion: snapshot.policyVersion,
    }
    const started = ++revision
    const owner = Symbol()
    pending = owner
    publish({ busy: true, actionError: false })
    try {
      const result = await api.apply(scope, expected, command)
      if (pending !== owner) return false
      if (result.identity?.id !== expected.identityId) {
        void read('identity')
        return false
      }
      if (started === revision) publish({ snapshot: scopedSnapshot(result) })
      else void read('facts')
      return true
    } catch {
      if (pending === owner) {
        publish({ actionError: true })
        void read('facts')
      }
      return false
    } finally {
      if (pending === owner) {
        pending = undefined
        publish({ busy: false })
      }
    }
  }

  return {
    subscribe,
    getSnapshot: () => state,
    getServerSnapshot: () => initialState,
    refresh: () => {
      if (release) void read('facts')
      else connect()
    },
    apply,
  }
}
