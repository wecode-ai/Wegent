import assert from 'node:assert/strict'
import { commandOutputAsync, redisCliBinary } from './shared.mjs'
import { pluginApi, testId, until } from './plugin-regression-fixture.mjs'

export async function disconnectDesktopCloud(control) {
  await control.command('navigate', 'body', { value: '/settings/connections' })
  await control.command(
    'waitFor',
    `${testId('settings-cloud-disconnect-button')}, ${testId('settings-cloud-connect-button')}`,
    { visible: true, enabled: true, stableMs: 250 }
  )
  if (
    Number(
      await control.command('getElementCount', testId('settings-cloud-disconnect-button'), {
        visible: true,
      })
    )
  )
    await control.command('clickWhenEnabled', testId('settings-cloud-disconnect-button'))
  await control.command('waitFor', testId('settings-cloud-connect-button'), {
    visible: true,
    enabled: true,
    stableMs: 250,
  })
}

/** Drive production native authorization and renderer persistence against the real Backend. */
export async function signInDesktopCloud(
  control,
  cloud,
  { backendUrl = cloud.backendUrl, token = cloud.authToken, user, timeoutMs = 10_000 } = {}
) {
  const account = { backendUrl: cloud.backendUrl, authToken: token }
  user ??= await pluginApi(account, '/users/me')
  const sessionKeys = async () =>
    (
      await commandOutputAsync(redisCliBinary(), [
        '-p',
        String(cloud.redisPort),
        '--raw',
        '--scan',
        '--pattern',
        '*wework_auth_session:*',
      ])
    )
      .split(/\r?\n/)
      .filter(Boolean)
  await disconnectDesktopCloud(control)
  const before = new Set(await sessionKeys())
  await control.command('clickWhenEnabled', testId('settings-cloud-connect-button'))
  await control.command('waitFor', testId('cloud-backend-url-input'))
  await control.command('fill', testId('cloud-backend-url-input'), { value: backendUrl })
  await control.command('clickWhenEnabled', testId('cloud-authorization-submit-button'))
  const keys = await until(
    sessionKeys,
    keys => keys.some(key => !before.has(key)),
    'Real cloud authorization did not create a new Redis session'
  )
  const created = keys.filter(key => !before.has(key))
  assert.equal(created.length, 1, 'The account switch created ambiguous authorization sessions')
  const sessionId = created[0].split('wework_auth_session:').at(-1)
  assert.match(sessionId, /^[a-f0-9-]{36}$/)
  await cloud.waitForAuthorizationPolling(sessionId)
  const approved = await pluginApi(account, `/auth/wework/sessions/${sessionId}/approve`, 'POST', {
    signal: AbortSignal.timeout(timeoutMs),
  })
  assert.equal(approved.status, 'approved')
  // Return from the system browser before asserting the desktop's visible connection state.
  await control.command('focusMainWindow', 'body')
  await control.command('waitFor', testId('cloud-connection-status-card'), {
    text: user.user_name,
    visible: true,
    timeoutMs,
  })
  const card = await control.command('getText', testId('cloud-connection-status-card'), {
    visible: true,
  })
  assert.ok(card.includes(user.user_name), 'The real connection card has the wrong account')
  await control.command('click', testId('settings-back-button'), { visible: true })
  await control.command('waitFor', testId('desktop-sidebar-account'), {
    text: user.user_name,
    visible: true,
  })
  return user
}
