import { requestExecutor } from './executor-rpc.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'

const testId = id => `[data-testid=${JSON.stringify(id)}]`

export function readStandInBinding(control, timeoutMs) {
  return requestExecutor(control, 'runtime.stand_in.binding', { operation: 'get' }, timeoutMs)
}

export async function finishStandInOnboarding(control) {
  if (!Number(await control.command('getElementCount', testId('stand-in-onboarding')))) return
  await control.command('clickWhenEnabled', testId('stand-in-onboarding-complete'))
  await control.command('waitFor', testId('stand-in-onboarding'), { visible: false })
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
  const close = testId('stand-in-primary-profile-close')
  if ((await control.command('getElementCount', close)) !== '0')
    await control.command('clickWhenEnabled', close, { timeoutMs })
  await control.command('waitFor', testId('stand-in-profile-panel'), { visible: false, timeoutMs })
}
