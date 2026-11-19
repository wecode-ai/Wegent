import type { DeviceCommandRequest, DeviceCommandResponse } from '@/types/api'

export function createConnectionObserverFixture() {
  const discoveries = new Map<string, unknown>()
  return (request: DeviceCommandRequest) => {
    const input = JSON.parse(request.args![0])
    if (input.discovery) discoveries.set(input.consumerKey, input.discovery)
    const reply = connectionObserverReply({
      ...request,
      args: [JSON.stringify({ ...input, discovery: discoveries.get(input.consumerKey) })],
    })
    if (request.command_key === 'connection_observer_stop') discoveries.delete(input.consumerKey)
    return reply
  }
}

/** Native observation protocol fixture; never executes a model or a Git command. */
export function connectionObserverReply(
  request: DeviceCommandRequest,
  lastCollectedAt = Date.parse('2026-11-15T00:00:00Z')
): DeviceCommandResponse {
  const input = JSON.parse(request.args![0])
  if (request.command_key === 'connection_observer_stop')
    return { success: true, stdout: { stopped: true }, stderr: '' }
  const query = input.discovery
    ? JSON.parse(input.discovery.query)
    : {
        instance: 'https://github.com',
        repository: 'org/repo',
        monitoredObjects: [{ entityKind: 'change_request', number: 1 }],
      }
  const platform = input.discovery?.providerId?.endsWith('/gitlab') ? 'gitlab' : 'github'
  const number = query.monitoredObjects?.[0].number ?? 1
  const url = `${query.instance}/${query.repository}/${platform === 'github' ? 'pull' : '-/merge_requests'}/${number}`
  const source = {
    providerId: `@wegent/dsh-connection-git/${platform}`,
    kind: 'repository',
    profile: JSON.stringify([query.instance, 'account']),
    id: 'repository',
    name: query.repository,
    ...(query.branch ? { branch: query.branch } : { monitoredObjects: query.monitoredObjects }),
  }
  return {
    success: true,
    stderr: '',
    stdout: {
      observer: {
        id: `observer-${input.consumerKey}-${input.generation}`,
        consumerKey: input.consumerKey,
        generation: input.generation,
        source,
        observationId: `source-${url}`,
        stopped: false,
      },
      observation: {
        id: `source-${url}`,
        source,
        lastCollectedAt,
        resourceStates: [
          {
            kind: 'change_request',
            provider: platform,
            topicId: url,
            observedAt: new Date(lastCollectedAt).toISOString(),
            data: {
              number,
              url,
              state: 'OPEN',
              title: 'Observed PR',
              headRefName: query.branch,
            },
          },
        ],
        errorCode: null,
        refreshPending: request.command_key === 'connection_observer_refresh',
      },
    },
  }
}
