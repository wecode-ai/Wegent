import { linkedChangeRequestTarget, observedChangeRequest } from '@/api/changeRequests'
import type { TaskChangeRequestSnapshot, TaskChangeRequestTarget } from '@/api/changeRequests'
import { outputAsRecord, parseGitRemote, type DeviceCommandApi } from '@/api/environment'
import { observationErrorCode, observationFailureState } from './resourceObservation'

interface Activation {
  consumerKey: string
  generation: string
  started: boolean
  observerId?: string
  observationId?: string
  source?: string
  pending?: Promise<TaskChangeRequestSnapshot | null>
}

export function changeRequestObserverKey(target: TaskChangeRequestTarget): string {
  const scope = target.changeRequestUrl ?? [target.remoteUrl, target.branch]
  return JSON.stringify([target.deviceId, scope])
}

function lookupFailure(error: string) {
  return error === 'git_cli_missing'
    ? 'unavailable'
    : observationFailureState(error) === 'auth_required'
      ? 'unauthenticated'
      : 'error'
}

function selection(target: TaskChangeRequestTarget) {
  const exact = target.changeRequestUrl
    ? linkedChangeRequestTarget(target.deviceId, target.changeRequestUrl)
    : null
  if (target.changeRequestUrl && exact?.changeRequestUrl !== target.changeRequestUrl) return null
  const remote = parseGitRemote(target.remoteUrl)
  if (!remote) return null
  const url = exact?.changeRequestUrl ? new URL(exact.changeRequestUrl) : null
  const platform = url
    ? url.pathname.includes('/-/merge_requests/')
      ? 'gitlab'
      : 'github'
    : remote.host.includes('github')
      ? 'github'
      : remote.host.includes('gitlab')
        ? 'gitlab'
        : null
  if (!platform || (!url && !target.branch.trim())) return null
  const instance = url?.origin ?? `https://${remote.host}`
  const repository = exact ? new URL(exact.remoteUrl).pathname.slice(1) : remote.repoPath
  const number = url ? Number(url.pathname.split('/').at(-1)) : undefined
  const scope = number
    ? { monitoredObjects: [{ entityKind: 'change_request', number }] }
    : { branch: target.branch }
  return {
    platform,
    instance,
    repository,
    number,
    discovery: {
      providerId: `@wegent/dsh-connection-git/${platform}`,
      kind: 'repository',
      query: JSON.stringify({ instance, repository, ...scope }),
    },
  } as const
}

/** Visible resource consumers own leases, never conversation event receipts. */
export class ChangeRequestUiObserver {
  private readonly api: DeviceCommandApi
  private readonly activations = new Map<string, Activation>()
  private desired = new Set<string>()

  constructor(api: DeviceCommandApi) {
    this.api = api
  }

  synchronize(
    targets: TaskChangeRequestTarget[],
    canRelease: (deviceId: string) => boolean = () => true
  ): void {
    this.desired = new Set(targets.filter(selection).map(changeRequestObserverKey))
    for (const [key, activation] of this.activations) {
      if (this.desired.has(key)) continue
      this.activations.delete(key)
      const [deviceId] = JSON.parse(key) as [string, string]
      // An older Runtime cannot release a new lease; its existing TTL expires it.
      if (canRelease(deviceId)) void this.stop(deviceId, activation)
    }
  }

  has(target: TaskChangeRequestTarget): boolean {
    return this.activations.has(changeRequestObserverKey(target))
  }

  async read(
    target: TaskChangeRequestTarget,
    force: boolean
  ): Promise<TaskChangeRequestSnapshot | null> {
    const key = changeRequestObserverKey(target)
    const selected = selection(target)
    if (!selected || !this.desired.has(key)) return null
    let activation = this.activations.get(key)
    if (!activation) {
      activation = {
        consumerKey: `change-request-ui:${crypto.randomUUID()}`,
        generation: crypto.randomUUID(),
        started: false,
      }
      this.activations.set(key, activation)
    }
    if (activation.pending) {
      const pending = await activation.pending
      if (this.activations.get(key) !== activation || !this.desired.has(key)) return null
      if (!force) return pending ? { ...pending, target } : null
      if (this.activations.get(key) !== activation) return null
    }
    const current = activation
    current.pending = this.collect(target, current, selected, force).finally(() => {
      current.pending = undefined
    })
    const result = await current.pending
    return this.activations.get(key) === current && this.desired.has(key) ? result : null
  }

  private async stop(deviceId: string, activation: Activation): Promise<void> {
    try {
      await this.api.executeCommand(deviceId, {
        command_key: 'connection_observer_stop',
        args: [JSON.stringify(this.address(activation))],
      })
    } catch {
      // The server-side lease expires without renewal if the route is unavailable.
      console.warn('[Wework change requests] Observation release was not acknowledged')
    }
  }

  private address(activation: Activation) {
    return { consumerKey: activation.consumerKey, generation: activation.generation }
  }

  private async collect(
    target: TaskChangeRequestTarget,
    activation: Activation,
    selected: NonNullable<ReturnType<typeof selection>>,
    force: boolean
  ): Promise<TaskChangeRequestSnapshot> {
    try {
      if (!activation.started) {
        const output = await this.command(target, activation, 'start', selected.discovery)
        const snapshot = this.project(target, activation, selected, output)
        activation.started = true
        if (!force) return snapshot
        if (this.activations.get(changeRequestObserverKey(target)) !== activation) return snapshot
      }
      const output = await this.command(target, activation, force ? 'refresh' : 'renew')
      return this.project(target, activation, selected, output)
    } catch (failure) {
      const error = observationErrorCode(failure)
      if (/observation_observer_lease_lost/.test(error)) {
        activation.started = false
        activation.generation = crypto.randomUUID()
        activation.observerId = undefined
        activation.observationId = undefined
        activation.source = undefined
      }
      return {
        target,
        provider: selected.platform,
        lookupState: lookupFailure(error),
        changeRequest: null,
        fetchedAt: new Date(0).toISOString(),
        stale: true,
        error,
        observation: {
          state: observationFailureState(error),
          transport: 'connection',
          stale: true,
          lastSuccessAt: null,
          error,
        },
      }
    }
  }

  private async command(
    target: TaskChangeRequestTarget,
    activation: Activation,
    operation: 'start' | 'renew' | 'refresh',
    discovery?: NonNullable<ReturnType<typeof selection>>['discovery']
  ) {
    const result = await this.api.executeCommand(target.deviceId, {
      command_key: `connection_observer_${operation}`,
      args: [JSON.stringify({ ...this.address(activation), ...(discovery ? { discovery } : {}) })],
    })
    if (!result.success)
      throw new Error(result.error || result.stderr || 'connection_observation_failed')
    const output = outputAsRecord(result.stdout)
    if (!output) throw new Error('connection_observation_invalid_response')
    return output
  }

  private project(
    target: TaskChangeRequestTarget,
    activation: Activation,
    selected: NonNullable<ReturnType<typeof selection>>,
    output: Record<string, unknown>
  ): TaskChangeRequestSnapshot {
    const observer = outputAsRecord(output.observer)
    const observation = outputAsRecord(output.observation)
    const source = outputAsRecord(observer?.source)
    const objects = source?.monitoredObjects
    let profile: unknown
    try {
      profile = typeof source?.profile === 'string' ? JSON.parse(source.profile) : null
    } catch {
      throw new Error('connection_observation_invalid_response')
    }
    if (
      !observer ||
      !observation ||
      !source ||
      typeof observer.id !== 'string' ||
      observer.consumerKey !== activation.consumerKey ||
      observer.generation !== activation.generation ||
      observer.stopped !== false ||
      typeof observation.id !== 'string' ||
      observer.observationId !== observation.id ||
      (activation.observerId && activation.observerId !== observer.id) ||
      (activation.observationId && activation.observationId !== observation.id) ||
      source.providerId !== selected.discovery.providerId ||
      source.kind !== 'repository' ||
      source.name !== selected.repository ||
      typeof source.id !== 'string' ||
      !source.id ||
      typeof source.profile !== 'string' ||
      !source.profile ||
      !Array.isArray(profile) ||
      profile.length !== 2 ||
      profile[0] !== selected.instance ||
      typeof profile[1] !== 'string' ||
      !profile[1] ||
      JSON.stringify(observation.source) !== JSON.stringify(source) ||
      (activation.source && activation.source !== JSON.stringify(source)) ||
      (selected.number
        ? !Array.isArray(objects) ||
          !objects.some(
            object => object?.entityKind === 'change_request' && object.number === selected.number
          )
        : source.branch !== target.branch)
    )
      throw new Error('connection_observation_invalid_response')
    activation.observerId = observer.id
    activation.observationId = observation.id
    activation.source = JSON.stringify(source)
    const state = Array.isArray(observation.resourceStates)
      ? observation.resourceStates.find(
          state =>
            state?.kind === 'change_request' &&
            state.provider === selected.platform &&
            typeof state.topicId === 'string' &&
            (!target.changeRequestUrl || state.topicId === target.changeRequestUrl) &&
            typeof state.observedAt === 'string' &&
            Number.isFinite(Date.parse(state.observedAt))
        )
      : undefined
    const projected = state
      ? observedChangeRequest(selected.platform, state.data, state.topicId)
      : null
    const changeRequest =
      projected && (selected.number || projected.headBranch === target.branch) ? projected : null
    const error =
      typeof observation.errorCode === 'string'
        ? observation.errorCode
        : typeof state?.errorCode === 'string'
          ? state.errorCode
          : null
    const lastSuccess =
      typeof observation.lastCollectedAt === 'number' &&
      Number.isFinite(observation.lastCollectedAt)
        ? observation.lastCollectedAt
        : null
    return {
      target,
      changeRequest,
      provider: selected.platform,
      lookupState: changeRequest
        ? 'found'
        : error
          ? lookupFailure(error)
          : lastSuccess && !selected.number
            ? 'not_found'
            : undefined,
      fetchedAt: state?.observedAt ?? new Date(0).toISOString(),
      stale: Boolean(error),
      error,
      observation: {
        state: error
          ? observationFailureState(error)
          : observation.refreshPending === true || !lastSuccess || !changeRequest
            ? 'refreshing'
            : 'observing',
        transport: 'connection',
        lastSuccessAt: lastSuccess,
        stale: Boolean(error),
        error,
      },
    }
  }
}
