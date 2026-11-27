import {
  STAND_IN_DINGTALK_PROVIDER,
  type StandInRole,
  type StandInSourceConnection,
} from '@/api/personalStandIn'
import type { StandInExecutorApi, ConnectionProviderDescriptor } from '@/api/standIn'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { ConnectionScopeRule } from './ConnectionScopeFields'
export type SourceConnection = Pick<
  StandInSourceConnection,
  | 'id'
  | 'name'
  | 'kind'
  | 'profile'
  | 'accountId'
  | 'providerId'
  | 'scope'
  | 'collectionKey'
  | 'configurationSummary'
>

type Connection = SourceConnection
export interface SourceConnectionsInput {
  role: StandInRole
  provider: ConnectionProviderDescriptor
  api: StandInExecutorApi
  deviceId: string
  disabled: boolean
  onChange(role: StandInRole): void
  onReady?(): void
  allResourcesLabel: string
  allMessagesLabel: string
  cliUnavailableLabel?: string
}

export function hasAllDingTalkMessages(rows: StandInSourceConnection[]) {
  const complete = rows.filter(row => row.scope === 'all' && !row.excludedResources?.length)
  return (
    complete.some(row => row.kind === 'group' && row.collectionKey === 'all-messages') &&
    complete.some(row => row.kind === 'direct')
  )
}

interface State {
  kind: string
  query: string
  results: Connection[]
  nextCursor: string | undefined
  busy: boolean
  error: { message: string; code?: unknown } | null
  searched: boolean
  authOpen: boolean
}
/** Discovery and explicit selection share one provider/device/role authority. */
export function createSourceConnectionsModel(initial: SourceConnectionsInput) {
  let input = initial
  let state: State = {
    kind: initial.provider.resourceKinds[0] ?? '',
    query: '',
    results: [],
    nextCursor: undefined,
    busy: false,
    error: null,
    searched: false,
    authOpen: false,
  }
  let searchSequence = 0
  let authorizationRequired = initial.provider.availability.status === 'auth_required'
  const listeners = new Set<() => void>()
  const publish = () => listeners.forEach(listener => listener())
  const set = <K extends keyof State>(
    key: K,
    value: State[K] | ((current: State[K]) => State[K])
  ) => {
    const next =
      typeof value === 'function' ? (value as (current: State[K]) => State[K])(state[key]) : value
    if (next === state[key]) return
    state = { ...state, [key]: next }
    publish()
  }
  const setResults = (
    value: State['results'] | ((current: State['results']) => State['results'])
  ) => set('results', value)
  const setNextCursor = (
    value: State['nextCursor'] | ((current: State['nextCursor']) => State['nextCursor'])
  ) => set('nextCursor', value)
  const setBusy = (value: State['busy'] | ((current: State['busy']) => State['busy'])) =>
    set('busy', value)
  const setError = (value: State['error'] | ((current: State['error']) => State['error'])) =>
    set('error', value)
  const setSearched = (
    value: State['searched'] | ((current: State['searched']) => State['searched'])
  ) => set('searched', value)
  const setAuthOpen = (
    value: State['authOpen'] | ((current: State['authOpen']) => State['authOpen'])
  ) => set('authOpen', value)
  const isCurrent = (sequence: number) => listeners.size > 0 && sequence === searchSequence
  const invalidateSearch = () => {
    searchSequence += 1
    setBusy(false)
  }
  const resetSearch = () => {
    invalidateSearch()
    set('query', '')
    setResults([])
    setNextCursor(undefined)
    setSearched(false)
    setError(null)
  }
  const failSearch = (sequence: number, cause: unknown) => {
    if (!isCurrent(sequence)) return
    const code =
      cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined
    setError({
      message:
        code === 'connection_cli_request_unavailable' && input.cliUnavailableLabel
          ? input.cliUnavailableLabel
          : getStandInErrorMessage(cause),
      code,
    })
  }
  const search = async (cursor?: string) => {
    if (!listeners.size || state.busy || !state.query.trim()) return
    const sequence = ++searchSequence
    setBusy(true)
    setError(null)
    setSearched(false)
    try {
      const request = [
        input.deviceId,
        input.provider.id,
        state.kind,
        state.query.trim(),
        cursor,
      ] as const
      const result = await input.api.searchConnectionResources(...request)
      if (!isCurrent(sequence)) return
      const items = result.items
      setResults(previous => {
        const merged = new Map<string, Connection>()
        for (const row of cursor ? [...previous, ...items] : items) {
          const key = identity(row)
          if (!merged.has(key)) merged.set(key, row)
        }
        return [...merged.values()]
      })
      setNextCursor(result.hasMore ? result.nextCursor : undefined)
      setSearched(true)
    } catch (cause) {
      failSearch(sequence, cause)
    } finally {
      if (isCurrent(sequence)) setBusy(false)
    }
  }
  const identity = (row: Connection) => JSON.stringify([row.profile, row.kind, row.id])
  const update = (connections: StandInSourceConnection[]) => {
    let ordered = connections
    if (input.provider.id === STAND_IN_DINGTALK_PROVIDER && initial.role.connections?.length) {
      const key = (row: StandInSourceConnection) =>
        JSON.stringify([row.providerId, row.profile, row.kind, row.id])
      const pending = new Map(connections.map(row => [key(row), row]))
      ordered = initial.role.connections.flatMap(saved => {
        const id = key(saved)
        const row = pending.get(id)
        pending.delete(id)
        return row ? [row] : []
      })
      ordered.push(...pending.values())
    }
    const previous = input.role.connections ?? []
    if (
      ordered.length === previous.length &&
      ordered.every((row, index) => row === previous[index])
    )
      return
    const role = { ...input.role, connections: ordered }
    input = { ...input, role }
    input.onChange(role)
  }
  const matches = (row: StandInSourceConnection, item: Connection) =>
    row.providerId === input.provider.id && identity(row) === identity(item)
  const covers = (row: StandInSourceConnection, item: Connection) =>
    row.providerId === input.provider.id &&
    row.scope === 'all' &&
    row.profile === item.profile &&
    row.kind === item.kind
  const select = (item: Connection, checked: boolean) => {
    if (!listeners.size || state.busy || input.disabled) return
    const connections = input.role.connections ?? []
    const exact = connections.find(row => matches(row, item))
    const all = connections.find(row => covers(row, item))
    if (all && item.scope !== 'all') {
      if (input.provider.id !== STAND_IN_DINGTALK_PROVIDER) return
      const excluded = all.excludedResources ?? []
      update(
        connections
          .filter(row => checked || row !== exact)
          .map(row =>
            row === all
              ? {
                  ...row,
                  excludedResources: checked
                    ? excluded.filter(value => value.id !== item.id)
                    : [
                        ...excluded.filter(value => value.id !== item.id),
                        { id: item.id, name: item.name },
                      ],
                }
              : row
          )
      )
      return
    }
    if (Boolean(exact) === checked) return
    update(
      checked
        ? [
            ...connections,
            {
              ...item,
              providerId: input.provider.id,
              policy: {
                automatic: true,
                askBeforeAct: true,
                immediate: input.role.id !== '@primary',
              },
            },
          ]
        : connections.filter(row => !matches(row, item))
    )
  }
  const selectAll = async (resourceKind: string, checked: boolean) => {
    if (!listeners.size || state.busy || input.disabled) return
    if (!checked) {
      update(
        (input.role.connections ?? []).filter(
          row =>
            row.providerId !== input.provider.id ||
            row.kind !== resourceKind ||
            row.scope !== 'all' ||
            (input.provider.availability.profile &&
              row.profile !== input.provider.availability.profile)
        )
      )
      return
    }
    const addAllScope = (item: Connection) => {
      const connections = input.role.connections ?? []
      if (connections.some(row => matches(row, item) && row.collectionKey === item.collectionKey))
        return
      update([
        ...connections.filter(
          row =>
            row.providerId !== input.provider.id ||
            row.profile !== item.profile ||
            row.kind !== resourceKind
        ),
        {
          ...item,
          name: input.provider.allResourceLabels?.[resourceKind] ?? input.allResourcesLabel,
          policy: { automatic: true, askBeforeAct: true, immediate: input.role.id !== '@primary' },
        },
      ])
    }
    const sequence = ++searchSequence
    setBusy(true)
    setError(null)
    try {
      const result = await input.api.searchConnectionResources(
        input.deviceId,
        input.provider.id,
        resourceKind,
        '',
        undefined,
        'all'
      )
      if (!isCurrent(sequence)) return
      const item = result.items[0]
      if (
        result.items.length !== 1 ||
        item?.scope !== 'all' ||
        item.id !== '*' ||
        item.kind !== resourceKind ||
        !item.profile ||
        item.providerId !== input.provider.id ||
        (input.provider.availability.profile &&
          item.profile !== input.provider.availability.profile)
      ) {
        throw Object.assign(new Error('Invalid all-resource selection'), {
          code: 'connection_response_invalid',
        })
      }
      addAllScope(item)
    } catch (cause) {
      failSearch(sequence, cause)
    } finally {
      if (isCurrent(sequence)) setBusy(false)
    }
  }

  const dingTalkAccount = () => {
    const { profile, status } = input.provider.availability
    return listeners.size &&
      !input.disabled &&
      profile &&
      status === 'ready' &&
      input.provider.id === STAND_IN_DINGTALK_PROVIDER
      ? profile
      : undefined
  }
  const dingTalkWildcard = (profile: string, kind: string): StandInSourceConnection => ({
    providerId: input.provider.id,
    profile,
    kind,
    id: '*',
    scope: 'all',
    name: input.provider.allResourceLabels?.[kind] ?? input.allResourcesLabel,
    policy: { automatic: true, askBeforeAct: true, immediate: input.role.id !== '@primary' },
  })
  const changeDingTalkRule = (kind: string, rule: ConnectionScopeRule) => {
    const profile = dingTalkAccount()
    if (!profile) return
    resetSearch()
    const current = input.role.connections ?? []
    const matchesKind = (row: StandInSourceConnection) =>
      row.providerId === input.provider.id && row.profile === profile && row.kind === kind
    const old = current.find(row => matchesKind(row) && row.scope === 'all')
    const outsideKind = current.filter(row => !matchesKind(row))
    if (rule === 'off') update(outsideKind)
    if (rule === 'include') update(current.filter(row => !matchesKind(row) || row.scope !== 'all'))
    if (rule === 'all' || rule === 'exclude') {
      const wildcard = { ...(old ?? dingTalkWildcard(profile, kind)) }
      if (rule === 'all') delete wildcard.excludedResources
      update([...outsideKind, wildcard])
    }
  }
  const setAllDingTalkMessages = () => {
    const profile = dingTalkAccount()
    if (!profile) return
    resetSearch()
    const current = input.role.connections ?? []
    const isAccount = (row: StandInSourceConnection) =>
      row.providerId === input.provider.id && row.profile === profile
    const account = current.filter(isAccount)
    const replaceAccount = (next: StandInSourceConnection[]) => {
      update([...current.filter(row => !isAccount(row)), ...next])
    }
    if (hasAllDingTalkMessages(account)) return
    const all = ['group', 'direct'].map(kind => {
      const previous = account.find(row => row.kind === kind && row.scope === 'all')
      const item: StandInSourceConnection = {
        ...(previous ?? dingTalkWildcard(profile, kind)),
        name:
          kind === 'group'
            ? input.allMessagesLabel
            : (input.provider.allResourceLabels?.direct ?? input.allResourcesLabel),
      }
      delete item.excludedResources
      delete item.delegated
      if (kind === 'group') {
        item.collectionKey = 'all-messages'
        delete item.configurationSummary
      }
      return item
    })
    replaceAccount(all)
  }

  return {
    getSnapshot: () => state,
    set,
    search,
    select,
    selectAll,
    setAllDingTalkMessages,
    changeDingTalkRule,
    resetSearch,
    replaceProviderRows(next: StandInSourceConnection[]) {
      if (!listeners.size || input.disabled) return
      update([
        ...(input.role.connections ?? []).filter(row => row.providerId !== input.provider.id),
        ...next,
      ])
    },
    identity,
    invalidateSearch,
    authorized() {
      if (!listeners.size) return
      invalidateSearch()
      setAuthOpen(false)
      setError(null)
      input.onReady?.()
    },
    subscribe(listener: () => void, next: SourceConnectionsInput) {
      input = next
      listeners.add(listener)
      const nextAuthorizationRequired = next.provider.availability.status === 'auth_required'
      const lostAuthorization = nextAuthorizationRequired && !authorizationRequired
      authorizationRequired = nextAuthorizationRequired
      if (lostAuthorization) invalidateSearch()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (!listeners.size) invalidateSearch()
        })
      }
    },
  }
}
