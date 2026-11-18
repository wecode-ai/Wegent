// @vitest-environment node

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createCloudConfigModelService } from '../e2e/desktop/modules/cloud-config-model-service.mjs'

test('serves a synthetic token refresh for the isolated official account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-cloud-config-model-'))
  const home = join(root, 'home')
  const codexHome = join(root, 'executor-home', 'codex')
  const appEnvironment = { HOME: home }
  const service = createCloudConfigModelService()
  try {
    await Promise.all([mkdir(home, { recursive: true }), mkdir(codexHome, { recursive: true })])
    await writeFile(join(codexHome, 'config.toml'), 'model = "gpt-6.1-sol"\n')
    await service.prepareApp({
      appEnvironment,
      codexHome,
      control: { url: 'http://model.example' },
    })

    const refreshUrl = appEnvironment.CODEX_REFRESH_TOKEN_URL_OVERRIDE
    assert.match(refreshUrl, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/token$/)
    const response = await fetch(refreshUrl, { method: 'POST', body: '{}' })
    assert.equal(response.status, 200)
    const refresh = await response.json()
    assert.equal(refresh.access_token, 'synthetic-cloud-config-recovery-access')
    assert.equal(refresh.refresh_token, 'synthetic-cloud-config-recovery-refresh')
    assert.equal(refresh.id_token.split('.').length, 3)
    assert.equal(service.diagnostics().tokenRefreshes, 1)

    const config = await readFile(join(codexHome, 'config.toml'), 'utf8')
    assert.match(
      config,
      new RegExp(`chatgpt_base_url = "${new URL(refreshUrl).origin}/backend-api/"`)
    )
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})
