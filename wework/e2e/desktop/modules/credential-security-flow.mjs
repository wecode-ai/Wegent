import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopHostEnvelope, desktopHostInvoke } from './desktop-host-ipc.mjs'

/** Runs inside the CI-registered model-settings checkpoint with real Host and Executor services. */
export async function verifyCredentialSecurity(control, userData) {
  const origin = await control.command('getLocationOrigin', 'body')
  const pluginKey = 'credential-e2e.synthetic'
  let restoreProviders = null
  await desktopHostInvoke(control, 'secureStorage.set', {
    key: pluginKey,
    value: 'synthetic-canary',
  })
  try {
    for (const capability of [
      'secureStorage.get',
      'secureStorage.set',
      'secureStorage.delete',
      'filesystem.readFileChunk',
      'modelConfiguration.recovery',
      'modelConfiguration.restoreRecovery',
    ]) {
      const response = await fetch(`${origin}/wework/electron-host/v1/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Host: new URL(origin).host,
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
        },
        body: JSON.stringify({ capability, params: { key: pluginKey, value: 'attacker-canary' } }),
      })
      assert.equal(response.status, 403)
      assert.equal((await response.json()).error.code, 'capability_denied')
    }
    assert.equal(
      await desktopHostInvoke(control, 'secureStorage.get', { key: pluginKey }),
      'synthetic-canary'
    )
    for (const capability of ['secureStorage.get', 'secureStorage.set', 'secureStorage.delete']) {
      const denied = await desktopHostEnvelope(control, capability, {
        key: 'wework-models.last-good',
        value: 'attacker-canary',
      })
      assert.equal(denied.error?.code, 'capability_denied')
    }
    let snapshot = await desktopHostInvoke(control, 'modelConfiguration.read')
    if (!snapshot.providers.some(provider => provider.models.length)) {
      restoreProviders = snapshot.providers
      snapshot = await desktopHostInvoke(control, 'modelConfiguration.save', {
        revision: snapshot.revision,
        providers: [
          {
            id: 'credential-security-fixture',
            name: 'Security fixture',
            base_url: 'http://127.0.0.1:9/v1',
            api_format: 'openai-responses',
            api_key: 'wework-e2e-test-key',
            models: [{ id: 'credential-security-model', model_id: 'synthetic' }],
          },
        ],
      })
    }
    const runtime = await desktopHostInvoke(control, 'modelConfiguration.runtime')
    assert.ok(
      runtime.models.length > 0,
      'Security checkpoint requires its own seeded model fixtures'
    )
    assert.ok(runtime.models.every(entry => entry.provider.api_key.startsWith('wework-vault.')))
    assert.ok(!JSON.stringify([snapshot, runtime]).includes('wework-e2e-test-key'))
    const source = await readFile(snapshot.path, 'utf8')
    assert.ok(source.includes('credential_protocol: 3'))
    assert.ok(!source.includes('wework-e2e-test-key'))
    for (const file of ['secure-values.key', 'secure-values.json', 'cloud-credentials.json'])
      await assert.rejects(access(join(userData, file)), { code: 'ENOENT' })
  } finally {
    if (restoreProviders) {
      const latest = await desktopHostInvoke(control, 'modelConfiguration.read')
      await desktopHostInvoke(control, 'modelConfiguration.save', {
        revision: latest.revision,
        providers: restoreProviders,
      })
    }
    await desktopHostInvoke(control, 'secureStorage.delete', { key: pluginKey })
  }
}
