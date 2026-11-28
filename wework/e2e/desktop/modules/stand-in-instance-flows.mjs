import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import {
  closeStandInSettingsAfterBinding,
  openStandInSettings,
} from './stand-in-profile-navigation.mjs'
import { fetchJson } from './shared.mjs'
import { until } from './plugin-regression-fixture.mjs'

const testId = id => `[data-testid=${JSON.stringify(id)}]`

export function readStandInBinding(control, timeoutMs) {
  return requestExecutor(control, 'runtime.stand_in.binding', { operation: 'get' }, timeoutMs)
}

export async function finishStandInOnboarding(control) {
  if (!Number(await control.command('getElementCount', testId('stand-in-onboarding')))) return
  await control.command('clickWhenEnabled', testId('stand-in-onboarding-complete'))
  await control.command('waitFor', testId('stand-in-onboarding'), { visible: false })
}

export async function stopBoundStandIn(control, _timeoutMs) {
  if ((await control.command('getElementCount', testId('stand-in-instance-stop'))) === '0') {
    if (Number(await control.command('getElementCount', testId('stand-in-close'))) > 0)
      await control.command('clickWhenEnabled', testId('stand-in-close'))
    await control.command('clickWhenEnabled', testId('stand-in-primary-open'))
    await openStandInSettings(control)
  }
  await control.command('clickWhenEnabled', testId('stand-in-instance-stop'))
  await control.command('clickWhenEnabled', testId('stand-in-instance-stop-confirm'))
  await control.command('waitFor', testId('stand-in-instance-stopped'))
}

export async function bindStoppedStandIn(control, userId, deviceId, timeoutMs, cloud) {
  await control.command('clickWhenEnabled', testId(`stand-in-instance-bind-${userId}-${deviceId}`))
  await control.command('waitFor', testId('stand-in-overview'), { timeoutMs })
  await assertStandInAccountDevice(userId, deviceId, timeoutMs, cloud)
  assert.equal(await control.command('getElementCount', testId('stand-in-workspace-location')), '0')
}

export async function assertStandInAccountDevice(userId, deviceId, timeoutMs, cloud) {
  const request = (path, signal = AbortSignal.timeout(timeoutMs)) =>
    fetchJson(`${cloud.backendUrl}/api${path}`, {
      headers: { Authorization: `Bearer ${cloud.authToken}` },
      signal,
    })
  const user = await request('/users/me')
  assert.equal(user.id, userId, 'The fixture session must own the selected assistant')
  const message = `The account primary assistant must select execution device ${deviceId}`
  const deadline = performance.now() + timeoutMs
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    await until(
      () => request('/v1/personal-assistant', signal),
      ({ assistant }) =>
        performance.now() < deadline &&
        assistant?.definitions?.find(entry => entry.roleId === '@primary')?.bot?.spec
          ?.execution_policy?.environment_id === deviceId,
      message,
      timeoutMs
    )
  } catch (cause) {
    if (signal.aborted || performance.now() >= deadline) throw new Error(message, { cause })
    throw cause
  }
}

export async function chooseStandInExecutionDevice(control, deviceId, timeoutMs, waitForSaved) {
  await control.command('clickWhenEnabled', testId('stand-in-primary-open'))
  await openStandInSettings(control)
  const select = testId('personal-assistant-execution-device')
  if ((await control.command('getElementCount', select)) === '0')
    await control.command('clickWhenEnabled', testId('stand-in-primary-execution-toggle'))
  await control.command('clickWhenEnabled', select, { timeoutMs })
  await control.command(
    'clickWhenEnabled',
    `[role="listbox"] [role="option"][data-value=${JSON.stringify(deviceId)}]`,
    { timeoutMs }
  )
  if (waitForSaved) await waitForSaved()
  await closeStandInSettingsAfterBinding(control, timeoutMs)
}
