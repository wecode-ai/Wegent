// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createCloudConfigModelService } from '../../e2e/desktop/modules/cloud-config-model-service.mjs'

test('keeps synthetic subscription refresh local while configuration bundles fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-cloud-config-service-'))
  const service = createCloudConfigModelService()
  const codexHome = join(root, 'managed-codex')
  const appEnvironment: Record<string, string> = { HOME: join(root, 'native-home') }
  try {
    await mkdir(codexHome, { recursive: true })
    await writeFile(join(codexHome, 'config.toml'), '')
    await service.prepareApp({
      appEnvironment,
      codexHome,
      control: { url: 'http://127.0.0.1:1', httpRequests: [] },
    })
    const refreshUrl = new URL(appEnvironment.CODEX_REFRESH_TOKEN_URL_OVERRIDE)
    expect(refreshUrl.hostname).toBe('127.0.0.1')
    expect(refreshUrl.pathname).toBe('/oauth/token')
    await service.failBundle()
    const bundleUrl = new URL('/backend-api/config/bundle', refreshUrl)
    expect((await fetch(bundleUrl)).status).toBe(200)
    expect((await fetch(bundleUrl)).status).toBe(503)

    const refresh = await fetch(refreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: 'synthetic-cloud-config-recovery-refresh',
      }),
    })
    expect(refresh.status).toBe(200)
    expect(await refresh.json()).toEqual({
      access_token: 'synthetic-cloud-config-recovery-access',
      refresh_token: 'synthetic-cloud-config-recovery-refresh',
    })
    expect(service.diagnostics().tokenRefreshes).toBe(1)
    expect((await fetch(bundleUrl)).status).toBe(503)
    expect(service.diagnostics().bundleFailures).toBe(2)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})
