import type { StandInRole, StandInSourceConnection } from '@/api/personalStandIn'
import type { StandInExecutorApi, ConnectionProviderDescriptor } from '@/api/standIn'
import {
  isDingTalkDelegationSource,
  matchesDingTalkAccount,
} from '@/features/collaboration-exp/stand-in/dingtalkDelegation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
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
  cliUnavailableLabel?: string
  delegatedDingTalk?: boolean
}
interface State {
  adding: boolean
  excluding: Connection | null
  newPolicy: { automatic: boolean; askBeforeAct: boolean; immediate: boolean }
  kind: string
  scope: 'selected' | 'all'
  selection: Connection[]
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
    adding: false,
    excluding: null,
    newPolicy: { automatic: true, askBeforeAct: true, immediate: initial.role.id !== '@primary' },
    kind: initial.provider.resourceKinds[0] ?? '',
    scope: !initial.delegatedDingTalk && initial.provider.allResourceKinds?.length ? 'all' : 'selected',
    selection: [],
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
  const setAdding = (value: State['adding'] | ((current: State['adding']) => State['adding'])) =>
    set('adding', value)
  const setExcluding = (
    value: State['excluding'] | ((current: State['excluding']) => State['excluding'])
  ) => set('excluding', value)
  const setSelection = (
    value: State['selection'] | ((current: State['selection']) => State['selection'])
  ) => set('selection', value)
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
  const rows = () =>
    (input.role.connections ?? []).filter(row => row.providerId === input.provider.id)
  const isCurrent = (sequence: number) => listeners.size > 0 && sequence === searchSequence
  const invalidateSearch = () => {
    searchSequence += 1
    setBusy(false)
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
      const result = await input.api.searchConnectionResources(
        input.deviceId,
        input.provider.id,
        state.kind,
        state.query.trim(),
        cursor
      )
      if (!isCurrent(sequence)) return
      const items = result.items
        .filter(row =>
          input.delegatedDingTalk
            ? isDingTalkDelegationSource(row) && matchesDingTalkAccount(input.provider.availability, row)
            : !state.excluding ||
              (row.profile === state.excluding.profile && row.kind === state.excluding.kind)
        )
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
  const identity = (row: Connection) =>
    JSON.stringify([
      row.profile,
      ...(input.delegatedDingTalk ? [row.accountId] : []),
      row.kind,
      row.id,
    ])
  const closeExclusionEditor = () => {
    invalidateSearch()
    setExcluding(null)
    setSelection([])
    setResults([])
    setNextCursor(undefined)
    setSearched(false)
    setError(null)
  }
  const isConnected = (row: Connection) => {
    const excluding = state.excluding
    return excluding
      ? rows()
          .find(value => identity(value) === identity(excluding))
          ?.excludedResources?.some(value => value.id === row.id) === true
      : rows().some(
          value =>
            identity(value) === identity(row) &&
            (!input.delegatedDingTalk || isDingTalkDelegationSource(value))
        )
  }
  const add = (items: Connection[]) => {
    if (!listeners.size) return
    const current = input
    if (current.delegatedDingTalk) {
      const selected = items.filter(
        row =>
          isDingTalkDelegationSource(row) && matchesDingTalkAccount(current.provider.availability, row)
      )
      if (!selected.length) return
      const retained = (current.role.connections ?? []).filter(
        row =>
          row.providerId !== current.provider.id ||
          (isDingTalkDelegationSource(row) &&
            matchesDingTalkAccount(current.provider.availability, row))
      )
      current.onChange({
        ...current.role,
        connections: [
          ...retained,
          ...selected
            .filter(row => !retained.some(value => identity(value) === identity(row)))
            .map(row => ({
              ...row,
              policy: { automatic: true, askBeforeAct: false, immediate: true },
            })),
        ],
      })
      setSelection([])
      setAdding(false)
      return
    }
    const excluding = state.excluding
    if (excluding) {
      if (
        !current.role.connections?.some(
          row =>
            row.providerId === input.provider.id &&
            row.scope === 'all' &&
            identity(row) === identity(excluding)
        )
      ) {
        closeExclusionEditor()
        return
      }
      current.onChange({
        ...current.role,
        connections: current.role.connections?.map(row => {
          if (row.providerId !== input.provider.id || identity(row) !== identity(excluding))
            return row
          const excludedResources = [...(row.excludedResources ?? [])]
          for (const item of items) {
            if (
              item.profile === row.profile &&
              item.kind === row.kind &&
              !excludedResources.some(value => value.id === item.id)
            )
              excludedResources.push({ id: item.id, name: item.name })
          }
          return { ...row, excludedResources }
        }),
      })
      closeExclusionEditor()
      return
    }
    let connections = [...(current.role.connections ?? [])]
    if (items.length && items.every(item => item.scope !== 'all')) {
      const covered = new Set(items.map(item => JSON.stringify([item.profile, item.kind])))
      connections = connections.filter(
        row =>
          row.providerId !== input.provider.id ||
          row.scope !== 'all' ||
          !covered.has(JSON.stringify([row.profile, row.kind]))
      )
    }
    for (const item of items) {
      const same = (row: StandInSourceConnection) =>
        row.providerId === input.provider.id &&
        row.profile === item.profile &&
        row.kind === item.kind
      if (item.scope === 'all') connections = connections.filter(row => !same(row))
      if (connections.some(row => same(row) && (row.id === item.id || row.scope === 'all')))
        continue
      connections.push({
        ...item,
        providerId: input.provider.id,
        policy: { ...state.newPolicy },
      })
    }
    current.onChange({ ...current.role, connections })
    setSelection([])
    setAdding(false)
  }
  const addAll = async () => {
    if (!listeners.size || state.busy || input.disabled || input.delegatedDingTalk) return
    const sequence = ++searchSequence
    setBusy(true)
    setError(null)
    try {
      const kinds = input.provider.allResourceKinds ?? []
      const pages = await Promise.all(
        kinds.map(resourceKind =>
          input.api.searchConnectionResources(
            input.deviceId,
            input.provider.id,
            resourceKind,
            '',
            undefined,
            'all'
          )
        )
      )
      if (!isCurrent(sequence)) return
      const items = pages.map((page, index) => {
        const item = page.items[0]
        if (
          page.items.length !== 1 ||
          item?.scope !== 'all' ||
          item.id !== '*' ||
          item.kind !== kinds[index] ||
          !item.profile ||
          item.providerId !== input.provider.id
        )
          throw Object.assign(new Error('Invalid all-resource selection'), {
            code: 'connection_response_invalid',
          })
        return {
          ...item,
          name: input.provider.allResourceLabels?.[item.kind] ?? input.allResourcesLabel,
        }
      })
      if (!items.length || new Set(items.map(item => item.profile)).size !== 1)
        throw Object.assign(new Error('Connection account changed'), {
          code: 'connection_response_invalid',
        })
      add(items)
    } catch (cause) {
      failSearch(sequence, cause)
    } finally {
      if (isCurrent(sequence)) setBusy(false)
    }
  }

  return {
    getSnapshot: () => state,
    set,
    search,
    add,
    addAll,
    closeExclusionEditor,
    isConnected,
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
