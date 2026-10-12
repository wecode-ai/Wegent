import { verifyCloudModelRecovery } from '../modules/cloud-model-recovery.mjs'
import { fetchJson } from '../modules/shared.mjs'

export function createDesktopScenario() {
  let cloudEnvironment
  const request = (path, options = {}) =>
    fetchJson(`${cloudEnvironment.backendUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${cloudEnvironment.authToken}`,
        'Content-Type': 'application/json',
      },
    })

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(cloud) {
      cloudEnvironment = cloud
      await request('/api/admin/setup-complete', { method: 'POST' })
    },
    setCloudEnvironment(cloud) {
      cloudEnvironment = cloud
    },
    async verify(control) {
      await verifyCloudModelRecovery(control, cloudEnvironment, request)
    },
  }
}
