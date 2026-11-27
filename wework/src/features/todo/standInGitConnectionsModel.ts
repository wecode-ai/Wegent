import type { StandInRole, StandInSourceConnection } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { GITHUB_CLI_TARGET, isGithubCliTarget } from '@/api/local/githubCli'
import { isGitlabCliTarget } from '@/api/local/gitlabCli'
import type { LocalConnectorAuthTarget } from '@/api/local/localConnectorAuth'

export const GIT_CONNECTION_PREFIX = '@wegent/dsh-connection-git/'
type Resource = Pick<
  StandInSourceConnection,
  'id' | 'name' | 'profile' | 'kind' | 'providerId' | 'configurationSummary'
>
interface GitInput {
  role: StandInRole
  savedConnections?: readonly StandInSourceConnection[]
  disabled: boolean
  onChange(role: StandInRole): void
}
interface GitState {
  instance: string
  kind: string
  query: string
  items: Resource[]
  cursor?: string
  busy: boolean
  accountStatus: 'checking' | 'ready' | 'signed_out' | 'unavailable'
  accounts: Resource[]
  searchState: 'idle' | 'loading' | 'ready' | 'error'
  error?: { kind: 'instance' } | { kind: 'request'; code: string }
  auth?: LocalConnectorAuthTarget
}

export function instanceOrigin(address: string): string | null {
  try {
    const url = new URL(address)
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !address.includes('?') &&
      !address.includes('#')
      ? url.origin
      : null
  } catch {
    return null
  }
}

/** An explicitly searched source owns discovery, selection and native authorization targets. */
export function createGitConnectionsModel(
  api: StandInExecutorApi,
  deviceId: string,
  providerId: string,
  initial: GitInput
) {
  const platform = providerId.slice(GIT_CONNECTION_PREFIX.length)
  const configuredInstances = new Set(
    (initial.role.connections ?? [])
      .filter(row => row.providerId === providerId)
      .map(row => instanceOrigin(profileInstance(row.profile)))
      .filter(value => value !== null)
  )
  const hasPersonalScope = initial.role.connections?.some(
    row => row.providerId === providerId && row.kind === 'personal'
  )
  const hasRepositoryScope = initial.role.connections?.some(
    row => row.providerId === providerId && row.kind === 'repository'
  )
  let input = initial
  const removedDraftRows = new Map<string, StandInSourceConnection>()
  let sequence = 0
  let accountSequence = 0
  let state: GitState = {
    instance:
      (configuredInstances.size === 1 ? [...configuredInstances][0] : null) ??
      `https://${platform}.com`,
    kind: hasRepositoryScope && !hasPersonalScope ? 'repository' : 'personal',
    query: '',
    items: [],
    busy: false,
    accountStatus: 'checking',
    accounts: [],
    searchState: 'idle',
  }
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<GitState>) => {
    state = { ...state, ...patch }
    listeners.forEach(listener => listener())
  }
  const current = (request: number) => listeners.size > 0 && sequence === request
  const report = (cause: unknown) => {
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
    publish({ error: { kind: 'request', code: String(code) } })
  }
  const resetSearch = () => {
    sequence += 1
    publish({
      items: [],
      cursor: undefined,
      error: undefined,
      searchState: 'idle',
      busy: false,
      auth: undefined,
    })
  }
  const readResources = (address: string, kind: string, query: string, page?: string) =>
    api.searchConnectionResources(
      deviceId,
      providerId,
      kind,
      JSON.stringify({ instance: address, search: query }),
      page
    )
  const checkAccount = async () => {
    const address = instanceOrigin(state.instance)
    const request = ++accountSequence
    resetSearch()
    if (!address) {
      publish({ accountStatus: 'unavailable', accounts: [] })
      return
    }
    publish({ accountStatus: 'checking', accounts: [] })
    const isCurrentAccount = () =>
      listeners.size > 0 &&
      request === accountSequence &&
      instanceOrigin(state.instance) === address
    try {
      const { items, availability } = await readResources(address, 'personal', '')
      if (!isCurrentAccount()) return
      const accounts = items.filter(
        row =>
          row.providerId === providerId &&
          row.kind === 'personal' &&
          profileInstance(row.profile) === address
      )
      if (availability?.status === 'auth_required') {
        publish({ accountStatus: 'signed_out' })
      } else if ((!availability || availability.status === 'ready') && accounts.length) {
        publish({ accountStatus: 'ready', accounts })
      } else {
        publish({ accountStatus: 'unavailable' })
        if (availability) report(availability)
      }
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
      if (!isCurrentAccount()) return
      publish({ accountStatus: code === 'connector_auth_required' ? 'signed_out' : 'unavailable' })
      if (code !== 'connector_auth_required') report(cause)
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void, next: GitInput) {
      input = next
      listeners.add(listener)
      if (listeners.size === 1 && accountSequence === 0 && !input.disabled) {
        queueMicrotask(() => {
          if (listeners.size && accountSequence === 0 && !input.disabled) void checkAccount()
        })
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          sequence += 1
          publish({
            busy: false,
            ...(state.searchState === 'loading' ? { searchState: 'idle' as const } : {}),
          })
        })
      }
    },
    resetSearch,
    checkAccount,
    setInstance(instance: string) {
      accountSequence += 1
      resetSearch()
      publish({ instance, accountStatus: 'unavailable', accounts: [] })
    },
    set<K extends keyof GitState>(
      key: K,
      value: GitState[K] | ((current: GitState[K]) => GitState[K])
    ) {
      const next =
        typeof value === 'function'
          ? (value as (current: GitState[K]) => GitState[K])(state[key])
          : value
      publish({ [key]: next })
    },
    clearAuth() {
      publish({ auth: undefined, error: undefined, searchState: 'idle' })
    },
    async search(page?: string) {
      if (!listeners.size || input.disabled) return
      const { instance, kind, query } = state
      const address = instanceOrigin(instance)
      if (!address) {
        publish({ searchState: 'error', error: { kind: 'instance' } })
        return
      }
      const request = ++sequence
      publish({ busy: true, searchState: 'loading', error: undefined })
      try {
        const result = await readResources(address, kind, query, page)
        if (!current(request)) return
        const availability = result.availability
        if (availability && availability.status !== 'ready') {
          publish({ searchState: 'error', items: [], cursor: undefined })
          if (availability.status !== 'auth_required') {
            report(availability)
            return
          }
          publish({
            accountStatus: 'signed_out',
            accounts: [],
            error: { kind: 'request', code: 'connector_auth_required' },
          })
          const target = availability.authTarget
          if (target && platform === 'github' && isGithubCliTarget(target))
            publish({ auth: GITHUB_CLI_TARGET })
          else if (
            target &&
            platform === 'gitlab' &&
            isGitlabCliTarget(target) &&
            instanceOrigin(target.instance!) === address
          ) {
            const native = (await api.gitConnection(deviceId, {
              channel: 'authTarget',
              instance: address,
            })) as unknown as LocalConnectorAuthTarget
            if (!current(request)) return
            if (
              !isGitlabCliTarget(native) ||
              native.pluginKey !== target.pluginKey ||
              native.connectorSlug !== target.connectorSlug ||
              instanceOrigin(native.instance!) !== address
            )
              throw new Error('Invalid authorization target')
            publish({ auth: native })
          }
          return
        }
        const profiles = new Set(state.accounts.map(account => account.profile))
        const items = result.items.filter(
          row => row.providerId === providerId && row.kind === kind && profiles.has(row.profile)
        )
        publish({
          items: page ? [...state.items, ...items] : items,
          cursor: result.hasMore ? result.nextCursor : undefined,
          searchState: 'ready',
        })
      } catch (cause) {
        if (current(request)) {
          publish({ searchState: 'error' })
          report(cause)
        }
      } finally {
        if (current(request)) publish({ busy: false })
      }
    },
    async login() {
      if (!listeners.size || input.disabled || state.busy) return
      if (platform === 'github') {
        publish({ auth: GITHUB_CLI_TARGET })
        return
      }
      const address = instanceOrigin(state.instance)
      if (!address) {
        publish({ error: { kind: 'instance' } })
        return
      }
      const request = ++sequence
      publish({ busy: true, error: undefined })
      try {
        const target = (await api.gitConnection(deviceId, {
          channel: 'authTarget',
          instance: address,
        })) as unknown as LocalConnectorAuthTarget
        if (!current(request)) return
        if (!isGitlabCliTarget(target) || instanceOrigin(target.instance!) !== address)
          throw new Error('Invalid authorization target')
        publish({ auth: target })
      } catch (cause) {
        if (current(request)) report(cause)
      } finally {
        if (current(request)) publish({ busy: false })
      }
    },
    changeScope(remove: readonly Resource[], add: readonly Resource[] = []) {
      if (!listeners.size || input.disabled || state.busy) return
      const authorized = state.accountStatus === 'ready' ? state.accounts : []
      const available = new Set(
        [...authorized, ...(authorized.length ? state.items : [])].map(resourceKey)
      )
      const removed = new Set(remove.map(resourceKey))
      const connections = (input.role.connections ?? []).filter(row => {
        const key = resourceKey(row)
        if (row.providerId !== providerId || !removed.has(key)) return true
        removedDraftRows.set(key, row)
        return false
      })
      const saved = new Map(
        input.savedConnections
          ?.filter(row => row.providerId === providerId)
          .map(row => [resourceKey(row), row])
      )
      const existing = new Set(
        connections.filter(row => row.providerId === providerId).map(resourceKey)
      )
      for (const item of add) {
        const key = resourceKey(item)
        if (item.providerId === providerId && available.has(key) && !existing.has(key)) {
          const previous = removedDraftRows.get(key) ?? saved.get(key)
          connections.push(
            previous ?? {
              ...item,
              transport: 'cli',
              policy: {
                automatic: true,
                askBeforeAct: true,
                immediate: input.role.id !== '@primary',
              },
            }
          )
          existing.add(key)
        }
      }
      if (
        connections.length === (input.role.connections?.length ?? 0) &&
        connections.every((row, index) => row === input.role.connections?.[index])
      )
        return
      const next = { ...input.role, connections }
      input = { ...input, role: next }
      input.onChange(next)
    },
  }
}

export function resourceKey(resource: Resource) {
  return JSON.stringify([resource.profile, resource.kind, resource.id])
}

export function profileInstance(profile: string): string {
  try {
    const value: unknown = JSON.parse(profile)
    return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : ''
  } catch {
    return ''
  }
}
