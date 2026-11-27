import assert from 'node:assert/strict'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'

const testId = id => `[data-testid=${JSON.stringify(id)}]`

export async function finishStandInOnboarding(control) {
  if (!Number(await control.command('getElementCount', testId('stand-in-onboarding')))) return
  await control.command('clickWhenEnabled', testId('stand-in-onboarding-continue'))
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

export async function bindStoppedStandIn(control, userId, deviceId, _timeoutMs) {
  await control.command('clickWhenEnabled', testId(`stand-in-instance-bind-${userId}-${deviceId}`))
  await control.command('waitFor', testId('stand-in-overview'))
  assert.equal(await control.command('getElementCount', testId('stand-in-workspace-location')), '0')
}
