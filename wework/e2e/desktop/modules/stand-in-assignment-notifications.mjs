import assert from 'node:assert/strict'

import { requestExecutor } from './executor-rpc.mjs'
import { requestJson, requireJson, waitForValue } from './human-workflow-transition.mjs'

export async function configureDefaultAssistants({
  control,
  baseUrl,
  projectId,
  users,
  marker,
  uiTimeoutMs,
}) {
  const configured = []
  for (const [index, fixture] of users.entries()) {
    const userId = fixture.user.id
    const initial = await requestExecutor(
      control,
      'runtime.stand_in.personal.get',
      { userId },
      uiTimeoutMs
    )
    const role = {
      ...initial.roles[0],
      id: `default-assistant-${index === 0 ? 'a' : 'b'}`,
      name: `Default assistant ${index === 0 ? 'A' : 'B'}`,
      enabled: true,
      prompt: `${marker} complete only the assigned workflow stage and publish evidence.`,
      collaboration: {
        ...initial.roles[0].collaboration,
        enabled: true,
        allProjects: false,
        projects: [{ id: String(projectId), store: 'cloud' }],
        excludedProjects: [],
        tags: [],
        policy: { automatic: true, askBeforeAct: false },
      },
    }
    const saved = await requestExecutor(
      control,
      'runtime.stand_in.personal.save',
      { userId, settings: { ...initial, roles: [role] } },
      uiTimeoutMs
    )
    configured.push({ userId, roleId: role.id, settings: saved })
  }
  return configured
}

export async function startOnlineEndpoints({ environment, users, processId }) {
  const endpoints = []
  for (const [index, fixture] of users.entries()) {
    const name = index === 0 ? 'a' : 'b'
    const started = await environment.startGeneratedRemoteDevice({
      deviceId: `w0069-default-assistant-${name}-${processId}`,
      deviceName: `W0069 default assistant ${name.toUpperCase()}`,
      deviceType: 'remote',
      authToken: fixture.token,
    })
    endpoints.push({
      deviceId: `w0069-default-assistant-${name}-${processId}`,
      userId: fixture.user.id,
      token: fixture.token,
      ...started,
    })
  }
  for (const endpoint of endpoints) {
    await waitForValue({
      load: () => requireJson(environment.backendUrl, endpoint.token, '/api/devices'),
      accept: devices =>
        devices.items?.some(
          device => device.device_id === endpoint.deviceId && device.status === 'online'
        ) === true,
      label: `Endpoint ${endpoint.deviceId} did not register online`,
      timeoutMs: 30_000,
    })
  }
  return endpoints
}

export async function waitForAssignmentNotification({ baseUrl, token, issueId, timeoutMs }) {
  return waitForValue({
    load: () => requireJson(baseUrl, token, '/api/v1/wework-notifications?category=collaboration'),
    accept: payload =>
      payload.items?.find(
        row => row.payload?.itemId === issueId || row.payload?.issueId === issueId
      ) ?? null,
    label: `No assignment notification was persisted for ${issueId}`,
    timeoutMs,
  })
}

export async function assertQualityAdmissionRejected({ baseUrl, token, issue }) {
  const result = await requestJson(baseUrl, token, `/api/v1/loop-items/${issue.id}`, {
    method: 'PATCH',
    body: { version: issue.version, status: 'in_review', tags: ['质量验收'] },
  })
  assert.equal(
    result.ok,
    false,
    `Quality admission accepted an Issue without a PR, head SHA, or green checks: ${JSON.stringify(result.data)}`
  )
  assert.match(
    JSON.stringify(result.data),
    /PR|pull request|head|checks|quality|质量/iu,
    'Quality admission must explain the missing PR, head SHA, and green checks'
  )
}
