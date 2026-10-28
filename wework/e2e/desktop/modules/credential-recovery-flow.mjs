import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopHostInvoke } from './desktop-host-ipc.mjs'

const selector = id => `[data-testid="${id}"]`
const fixtureModel = 'credential-recovery-conflict'

/** Seed historical files before startup, using only this checkpoint's isolated profile. */
export async function seedCredentialRecovery(userData) {
  const path = join(userData, 'renderer-local-storage.json')
  const renderer = JSON.parse(await readFile(path, 'utf8'))
  renderer.entries['wework.localModelSettings.v1'] = JSON.stringify([
    {
      id: fixtureModel,
      modelId: 'recovered-upstream',
      baseUrl: 'https://old-recovery.invalid/v1',
      apiKey: 'synthetic-conflict-key',
      enabled: false,
    },
  ])
  await writeFile(path, JSON.stringify(renderer), { mode: 0o600 })
  await mkdir(join(userData, 'model-connections'), { recursive: true })
  await writeFile(
    join(userData, 'model-connections/model.yml'),
    `version: 1
providers:
  - id: credential-recovery-existing
    name: Existing recovery fixture
    base_url: https://current-recovery.invalid/v1
    api_format: openai-responses
    api_key: synthetic-original-key
    enabled: false
    models:
      - id: ${fixtureModel}
        model_id: original-upstream
`,
    { mode: 0o600 }
  )
}

export async function activateCredentialRecoveryFixture(control) {
  const snapshot = await desktopHostInvoke(control, 'modelConfiguration.read')
  await desktopHostInvoke(control, 'modelConfiguration.save', {
    revision: snapshot.revision,
    providers: snapshot.providers.map(provider =>
      provider.id === 'credential-recovery-existing' ? { ...provider, enabled: true } : provider
    ),
  })
}

/** Real Host, vault, journal and renderer flow; no production recovery backdoor is needed. */
export async function verifyCredentialRecovery(control) {
  await control.command('navigate', 'body', { value: '/settings/personal/models' })
  await control.command('waitFor', selector('provider-recovery-open'))
  const original = await desktopHostInvoke(control, 'modelConfiguration.read')
  const recovery = await desktopHostInvoke(control, 'modelConfiguration.recovery')
  const legacy = recovery.candidates.find(item => item.kind === 'legacy-models')
  assert.ok(legacy, 'Historical conflict must create its own recoverable archive')
  assert.ok(!JSON.stringify(recovery).includes('synthetic-conflict-key'))
  await control.command('click', selector('provider-recovery-open'))
  await control.command('waitFor', selector(`provider-recovery-select-${legacy.id}`))
  await control.command('click', selector(`provider-recovery-select-${legacy.id}`))
  await control.command('waitFor', selector('provider-recovery-confirm'))
  await control.command('click', selector('provider-recovery-confirm-cancel-button'))
  assert.equal(
    (await desktopHostInvoke(control, 'modelConfiguration.read')).revision,
    original.revision
  )
  await control.command('click', selector(`provider-recovery-select-${legacy.id}`))
  await control.command('click', selector('provider-recovery-confirm'))
  await control.command('waitFor', selector('provider-recovery-success'))
  let restored = await desktopHostInvoke(control, 'modelConfiguration.read')
  const connection = restored.providers.find(provider =>
    provider.models.some(model => model.model_id === 'recovered-upstream')
  )
  assert.ok(connection)
  assert.equal(connection.base_url, 'https://old-recovery.invalid/v1')
  assert.notEqual(connection.models[0].id, fixtureModel)
  assert.ok(connection.api_key_configured)
  assert.ok(
    restored.providers.some(provider => provider.models.some(model => model.id === fixtureModel))
  )
  assert.ok(
    !(await desktopHostInvoke(control, 'modelConfiguration.recovery')).candidates.some(
      item => item.id === legacy.id
    )
  )

  const damagedPath = restored.path
  const damaged = 'external: [synthetic-damage-preserved'
  await writeFile(damagedPath, damaged)
  const readyCount = control.readyCount
  await control.command('reloadMainWindow', 'body')
  await control.awaitReadyAfter(readyCount)
  await control.command('navigate', 'body', { value: '/settings/personal/models' })
  await control.command('waitFor', selector('provider-settings-error'))
  await control.command('click', selector('provider-recovery-open'))
  const valid = (await desktopHostInvoke(control, 'modelConfiguration.recovery')).candidates.find(
    item => item.kind === 'saved-configuration'
  )
  assert.ok(valid)
  await control.command('waitFor', selector(`provider-recovery-select-${valid.id}`))
  await control.command('click', selector(`provider-recovery-select-${valid.id}`))
  await control.command('click', selector('provider-recovery-confirm'))
  await control.command('waitFor', selector('provider-recovery-success'))
  restored = await desktopHostInvoke(control, 'modelConfiguration.read')
  assert.notEqual(restored.path, damagedPath)
  assert.equal(await readFile(damagedPath, 'utf8'), damaged)
  assert.equal(restored.error, undefined)
  assert.ok(!JSON.stringify(restored).includes('synthetic-conflict-key'))
  assert.ok(!(await readFile(restored.path, 'utf8')).includes('synthetic-conflict-key'))
  await control.command('click', selector('provider-recovery-close'))
  await desktopHostInvoke(control, 'modelConfiguration.save', {
    revision: restored.revision,
    providers: restored.providers.filter(
      provider => provider.id !== 'credential-recovery-existing' && provider.id !== connection.id
    ),
  })
}
