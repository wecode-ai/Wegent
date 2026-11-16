import { requestExecutor } from './executor-rpc.mjs'
import { getDesktopOwner } from './desktop-owner-fixture.mjs'

/** Existing business checkpoints start after the real, explicitly opted-out onboarding. */
export async function prepareStandInOnboardingFixture(control, timeoutMs) {
  const user = getDesktopOwner()
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
