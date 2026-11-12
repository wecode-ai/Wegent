import { requestExecutor } from './executor-rpc.mjs'
import { fetchJson } from './shared.mjs'

/** Existing business checkpoints start after the real, explicitly opted-out onboarding. */
export async function prepareStandInOnboardingFixture(control, cloud, timeoutMs) {
  const user = cloud
    ? await fetchJson(`${cloud.backendUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${cloud.authToken}` },
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
