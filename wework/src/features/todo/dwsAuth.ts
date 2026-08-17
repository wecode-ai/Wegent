import type { DwsApi, DwsAuthStatus } from '@/api/dws'

const DWS_AUTH_POLL_INTERVAL_MS = 750
const DWS_AUTH_POLL_ATTEMPTS = 160

export async function waitForDwsAuthentication(dwsApi: DwsApi): Promise<DwsAuthStatus> {
  for (let attempt = 0; attempt < DWS_AUTH_POLL_ATTEMPTS; attempt += 1) {
    await new Promise(resolve => window.setTimeout(resolve, DWS_AUTH_POLL_INTERVAL_MS))
    const status = await dwsApi.authStatus()
    if (status.authenticated && status.token_valid !== false) return status
  }
  throw new Error('钉钉授权等待超时，请重试。')
}
