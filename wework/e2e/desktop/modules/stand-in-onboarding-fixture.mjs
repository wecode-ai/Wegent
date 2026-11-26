import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { requestExecutor } from './executor-rpc.mjs'
import { fetchJson } from './shared.mjs'

/** Existing business checkpoints start after the real, explicitly opted-out onboarding. */
export async function prepareStandInOnboardingFixture(
  control,
  cloud,
  timeoutMs,
  token = cloud?.authToken
) {
  const user = cloud
    ? await fetchJson(`${cloud.backendUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    : { id: 9001 }
  await requestExecutor(
    control,
    'runtime.stand_in.onboarding.complete',
    {
      userId: user.id,
      weeklyReview: false,
      time: '09:00',
      language: 'zh-CN',
    },
    timeoutMs
  )
}

// These desktop stories address the same fixture owner in local Executor RPCs.
// Each checkpoint owns its database, so the fixture identity is isolated.
export async function createStandInFixtureSession(cloud) {
  await cloud.executeDatabase('ALTER TABLE users AUTO_INCREMENT = 9001')
  const credentials = { user_name: 'wework-desktop-e2e-cloud-user', password: randomUUID() }
  const member = await fetchJson(`${cloud.backendUrl}/api/admin/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...credentials,
      email: 'desktop-e2e@example.com',
      role: 'user',
      auth_source: 'password',
    }),
  })
  assert.equal(member.id, 9001)
  const session = await fetchJson(`${cloud.backendUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  })
  return session.access_token
}

export async function initializeFixtureAssistant(backendUrl, token) {
  return fetchJson(`${backendUrl}/api/v1/personal-assistant`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ definitions: [{ roleId: '@primary', name: '默认助理', prompt: '' }] }),
  })
}
