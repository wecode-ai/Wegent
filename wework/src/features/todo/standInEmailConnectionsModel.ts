import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { StandInRole } from '@/api/personalStandIn'
import { getDshExtensionHost } from '@/features/dsh-runtime/dshExtensions'

export const EMAIL_PROVIDER = '@wegent/dsh-connection-runtime/email'
type Server = { host: string; port: number; secure: boolean }
export type EmailAccount = {
  id: string
  email: string
  username: string
  imap: Server
  smtp: Server
}
export const initialEmailForm = {
  id: undefined as string | undefined,
  email: '',
  username: '',
  password: '',
  imap: { host: '', port: 993, secure: true },
  smtp: { host: '', port: 465, secure: true },
}
interface EmailInput {
  role: StandInRole
  local: boolean
  disabled: boolean
  onChange(role: StandInRole): void
  onDirtyChange?(dirty: boolean): void
}
const dirtyOwners = new WeakMap<NonNullable<EmailInput['onDirtyChange']>, object>()

interface EmailState {
  form: typeof initialEmailForm
  baseline: typeof initialEmailForm
  adding: boolean
  busy: boolean
  error: string | null
  saved: 'connected' | 'updated' | null
  removing: EmailAccount | null
  pendingNavigation: (() => void) | null
}
async function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const host = getDshExtensionHost()
  if (!host) throw new Error('email_unavailable')
  return host.backend.scope('wework-connection-runtime').request(method, params) as Promise<T>
}

/** One owner keeps the email editor, verification result and native account catalog together. */
export function createEmailConnectionsModel(initial: EmailInput) {
  let input = initial
  const owner = {}
  let state: EmailState = {
    form: initialEmailForm,
    baseline: initialEmailForm,
    adding: false,
    busy: false,
    error: null,
    saved: null,
    removing: null,
    pendingNavigation: null,
  }
  const accounts = createAsyncResource(
    'email-accounts',
    () => request<EmailAccount[]>('emailAccounts'),
    { refreshOnSubscribe: true }
  )
  const listeners = new Set<() => void>()
  let stopAccounts: (() => void) | undefined
  let reportedDirty: boolean | undefined
  let dirtyCallback: EmailInput['onDirtyChange']
  const dirty = () => state.adding && JSON.stringify(state.form) !== JSON.stringify(state.baseline)
  const read = () => ({
    ...state,
    accounts: input.local ? (accounts.getSnapshot().data ?? []) : [],
    dirty: dirty(),
    error:
      state.error ??
      (input.local && accounts.getSnapshot().status === 'error' ? 'email_unavailable' : null),
  })
  let snapshot = read()
  function releaseDirty() {
    if (dirtyCallback && dirtyOwners.get(dirtyCallback) === owner) {
      dirtyOwners.delete(dirtyCallback)
      dirtyCallback(false)
    }
    dirtyCallback = undefined
    reportedDirty = undefined
  }
  function reportDirty() {
    if (!listeners.size) return
    const next = dirty()
    if (dirtyCallback !== input.onDirtyChange) releaseDirty()
    const callback = input.onDirtyChange
    const ownsCallback = callback ? dirtyOwners.get(callback) === owner : true
    if (next === reportedDirty && dirtyCallback === callback && ownsCallback) return
    dirtyCallback = callback
    if (callback) dirtyOwners.set(callback, owner)
    reportedDirty = next
    dirtyCallback?.(next)
  }
  function publish() {
    snapshot = read()
    listeners.forEach(listener => listener())
    reportDirty()
  }
  function set<K extends keyof EmailState>(
    key: K,
    value: EmailState[K] | ((current: EmailState[K]) => EmailState[K])
  ) {
    const next =
      typeof value === 'function'
        ? (value as (current: EmailState[K]) => EmailState[K])(state[key])
        : value
    if (state[key] === next) return
    state = { ...state, [key]: next }
    publish()
  }
  const rows = () => (input.role.connections ?? []).filter(row => row.providerId === EMAIL_PROVIDER)
  const connect = (account: Pick<EmailAccount, 'id' | 'email'>) => {
    if (!listeners.size || rows().some(row => row.profile === account.id)) return
    input.onChange({
      ...input.role,
      connections: [
        ...(input.role.connections ?? []),
        {
          providerId: EMAIL_PROVIDER,
          profile: account.id,
          id: 'INBOX',
          kind: 'inbox',
          name: account.email,
          policy: { automatic: true, askBeforeAct: true, immediate: input.role.id !== '@primary' },
        },
      ],
    })
  }
  const reload = () => {
    state = { ...state, error: null }
    if (input.local) void accounts.reload()
    else publish()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, next: EmailInput) {
      input = next
      listeners.add(listener)
      if (next.local && !stopAccounts) stopAccounts = accounts.subscribe(publish)
      snapshot = read()
      reportDirty()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          stopAccounts?.()
          stopAccounts = undefined
          releaseDirty()
        })
      }
    },
    set,
    connect,
    reload,
    requestLeave(action: () => void) {
      if (!state.busy) {
        if (dirty()) set('pendingNavigation', () => action)
        else action()
      }
    },
    async save() {
      if (!listeners.size || state.busy || input.disabled || !input.local) return
      const form = state.form
      state = { ...state, busy: true, error: null, saved: null }
      publish()
      try {
        const account = await request<{ id: string }>('saveEmailAccount', {
          ...form,
          username: form.username.trim() || form.email.trim(),
        })
        if (!listeners.size) return
        const updated = Boolean(form.id || rows().some(row => row.profile === account.id))
        if (!form.id) connect({ id: account.id, email: form.email.trim() })
        state = {
          ...state,
          baseline: initialEmailForm,
          form: initialEmailForm,
          adding: false,
          saved: updated ? 'updated' : 'connected',
        }
        void accounts.reload()
      } catch (cause) {
        if (!listeners.size) return
        const message = cause instanceof Error ? cause.message : ''
        state = {
          ...state,
          error:
            [
              'email_smtp_failed',
              'email_connection_failed',
              'email_transport_failed',
              'email_auth_failed',
              'email_invalid_configuration',
            ].find(code => message.includes(code)) ?? 'email_unavailable',
        }
      } finally {
        state = { ...state, busy: false }
        publish()
      }
    },
    async removeAccount() {
      const removing = state.removing
      if (!listeners.size || !removing || state.busy || input.disabled || !input.local) return
      state = { ...state, busy: true, error: null }
      publish()
      try {
        await request('removeEmailAccount', { id: removing.id })
        if (!listeners.size) return
        input.onChange({
          ...input.role,
          connections: (input.role.connections ?? []).filter(
            row => row.providerId !== EMAIL_PROVIDER || row.profile !== removing.id
          ),
        })
        state = {
          ...state,
          removing: null,
          saved: null,
          ...(state.form.id === removing.id
            ? { baseline: initialEmailForm, form: initialEmailForm, adding: false }
            : {}),
        }
        void accounts.reload()
      } catch {
        if (listeners.size) state = { ...state, error: 'email_unavailable' }
      } finally {
        state = { ...state, busy: false }
        publish()
      }
    },
  }
}
