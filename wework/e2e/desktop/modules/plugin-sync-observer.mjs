import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'

function socketPacket(text, type) {
  const packet = text.match(new RegExp(`^${type}(\\/[^,]+,)?(\\d+)?(\\[.*)$`, 's'))
  if (!packet) return null
  return { namespace: packet[1] ?? '', id: packet[2] ?? '', data: JSON.parse(packet[3]) }
}

const pluginIds = items => (items ?? []).map(item => String(item.installed_plugin_id ?? item.id))

// Observe only allowlisted plugin and device metadata. Original traffic always
// flows through the real transport, except an explicitly held capability frame.
export function observePluginSyncTransport(proxy, { holdCapability = () => false } = {}) {
  const observation = {
    capabilities: [],
    acknowledgements: [],
    registrations: [],
    heartbeats: [],
    reconciliations: [],
    writes: [],
  }
  const gate = proxy.holdNextCapabilitySync(holdCapability)
  observation.gate = gate
  const receive = gate.receive
  gate.receive = (text, frames, output) => {
    const packet = socketPacket(text, '42')
    if (packet?.data[0] === 'device:sync_capabilities') {
      const payload = packet.data[1]
      observation.capabilities.push({
        at: Date.now(),
        namespace: packet.namespace,
        id: packet.id,
        deviceId: payload.device_id,
        mode: payload.mode,
        scope: payload.scope ?? 'all',
        pluginSync: payload.plugin_sync,
        pluginIds: pluginIds(payload.plugins),
        removedIds: pluginIds(payload.removed_plugins),
        skills: (payload.skills ?? []).map(item => item.name),
        mcps: (payload.mcps ?? []).map(item => item.name),
      })
    }
    return receive(text, frames, output)
  }
  const observeAcknowledgement = gate.observeAcknowledgement
  gate.observeAcknowledgement = text => {
    const packet = socketPacket(text, '42')
    if (packet?.data[0] === 'device:register') {
      const payload = packet.data[1]
      observation.registrations.push({
        at: Date.now(),
        deviceId: payload.device_id,
        runtimeInstanceId: payload.runtime_instance_id,
      })
    }
    if (packet?.data[0] === 'device:heartbeat') {
      observation.heartbeats.push({ at: Date.now(), deviceId: packet.data[1]?.device_id })
    }
    const acknowledgement = socketPacket(text, '43')
    if (
      acknowledgement &&
      observation.capabilities.some(
        request =>
          request.id === acknowledgement.id && request.namespace === acknowledgement.namespace
      )
    ) {
      const payload = acknowledgement.data[0]
      observation.acknowledgements.push({
        at: Date.now(),
        namespace: acknowledgement.namespace,
        id: acknowledgement.id,
        success: payload.success,
        scope: payload.scope,
        pluginSync: payload.plugin_sync,
        pluginIds: pluginIds(payload.plugins),
      })
    }
    return observeAcknowledgement(text)
  }

  const forward = proxy.forward
  proxy.forward = function (request, response) {
    const url = new URL(request.url, this.target)
    if (url.pathname.startsWith('/api/plugins/')) {
      const entry = {
        at: Date.now(),
        method: request.method,
        path: url.pathname,
        deviceId: url.searchParams.get('device_id'),
      }
      observation.writes.push(entry)
      if (request.method === 'POST' && url.pathname.endsWith('/sync-device')) {
        observation.reconciliations.push({
          ...entry,
          reconcile: url.searchParams.get('reconcile') === 'true',
        })
      }
    }
    return forward.call(this, request, response)
  }
  assert.equal(proxy.websockets.size, 0, 'Configure the observer before opening its connection')
  return observation
}

export function pluginSyncGeneration(sync, installedId) {
  return sync?.version === 3 ? sync.revisions[String(installedId)] : sync?.generation
}

export function latestPluginSyncRequest(requests, installedId) {
  return requests.reduce(
    (latest, request) =>
      !latest ||
      pluginSyncGeneration(request.pluginSync, installedId) >
        pluginSyncGeneration(latest.pluginSync, installedId)
        ? request
        : latest,
    undefined
  )
}

// A later full sync may supersede a setup delta before the polling read. Require
// an exact successful transport ACK for the generation actually on disk.
export function acknowledgedPluginGeneration(observation, plugin, installedId, baseline) {
  const request = observation.capabilities.find(
    value =>
      value.at >= baseline.at &&
      pluginSyncGeneration(value.pluginSync, installedId) === plugin?.plugin_sync_generation &&
      pluginSyncGeneration(value.pluginSync, installedId) >=
        pluginSyncGeneration(baseline.pluginSync, installedId) &&
      value.pluginIds.includes(String(installedId))
  )
  if (!request) return null
  return (
    observation.acknowledgements.find(
      value =>
        value.at >= request.at &&
        value.id === request.id &&
        value.namespace === request.namespace &&
        value.success === true &&
        value.pluginIds.includes(String(installedId)) &&
        isDeepStrictEqual(value.pluginSync, request.pluginSync)
    ) ?? null
  )
}
