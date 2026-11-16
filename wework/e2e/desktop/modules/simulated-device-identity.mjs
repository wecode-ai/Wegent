import { createHash } from 'node:crypto'

/** Keep simulated device namespaces stable, including the original device. */
export function simulatedDeviceApplicationId({ applicationId, profile, originalProfile }) {
  if (profile === originalProfile) return applicationId
  const suffix = createHash('sha256').update(profile).digest('hex').slice(0, 12)
  return `${applicationId}.device${suffix}`
}
