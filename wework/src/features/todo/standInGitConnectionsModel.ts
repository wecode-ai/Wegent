import type { StandInRole, StandInSourceConnection } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { GITHUB_CLI_TARGET, isGithubCliTarget } from '@/api/local/githubCli'
import { isGitlabCliTarget } from '@/api/local/gitlabCli'
import type { LocalConnectorAuthTarget } from '@/api/local/localConnectorAuth'

export const GIT_CONNECTION_PREFIX = '@wegent/dsh-connection-git/'
type Resource = Pick<StandInSourceConnection, 'id' | 'name' | 'profile' | 'kind' | 'providerId'>
interface GitInput {
  role: StandInRole
  disabled: boolean
  onChange(role: StandInRole): void
}
interface GitState {
  instance: string
  kind: string
  query: string
  items: Resource[]
  selection: Resource[]
  cursor?: string
  busy: boolean
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
  let input = initial
  let sequence = 0
  let state: GitState = {
    instance: `https://${platform}.com`,
    kind: 'personal',
    query: '',
    items: [],
    selection: [],
    busy: false,
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
      selection: [],
      cursor: undefined,
      error: undefined,
      searchState: 'idle',
      busy: false,
      auth: undefined,
    })
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void, next: GitInput) {
      input = next
      listeners.add(listener)
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
        const result = await api.searchConnectionResources(
          deviceId,
          providerId,
          kind,
          JSON.stringify({ instance: address, search: query }),
          page
        )
        if (!current(request)) return
        const availability = result.availability
        if (availability && availability.status !== 'ready') {
          publish({ searchState: 'error', items: [], selection: [], cursor: undefined })
          if (availability.status !== 'auth_required') {
            report(availability)
            return
          }
          publish({ error: { kind: 'request', code: 'connector_auth_required' } })
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
        publish({
          items: page ? [...state.items, ...result.items] : result.items,
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
    add() {
      if (!listeners.size || input.disabled || state.busy) return
      sequence += 1
      publish({ busy: true, error: undefined })
      try {
        for (const item of state.selection) {
          if (
            (input.role.connections ?? []).some(
              row =>
                row.providerId === item.providerId &&
                row.profile === item.profile &&
                row.kind === item.kind &&
                row.id === item.id
            )
          )
            continue
          const connection: StandInSourceConnection = {
            ...item,
            transport: 'cli',
            policy: {
              automatic: true,
              askBeforeAct: true,
              immediate: input.role.id !== '@primary',
            },
          }
          const updated = {
            ...input.role,
            connections: [...(input.role.connections ?? []), connection],
          }
          input = { ...input, role: updated }
          input.onChange(updated)
        }
        publish({ selection: [] })
      } catch (cause) {
        report(cause)
      } finally {
        publish({ busy: false })
      }
    },
  }
}
