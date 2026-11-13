/** Exercise the delivered model store and native credentials without touching personal files. */
export async function verifyLegacyModelBindings({ nativeRequire, directory, host }) {
  const assert = nativeRequire('node:assert/strict')
  const fs = nativeRequire('node:fs/promises')
  const path = nativeRequire('node:path')
  const { SecureValueStore } = nativeRequire(path.join(host, 'secure-value-store.js'))
  const { ModelConfigurationStore } = nativeRequire(path.join(host, 'model-configuration-store.js'))
  const root = await fs.mkdtemp(path.join(directory, 'upgrade-model-binding-'))
  try {
    for (const external of [false, true]) {
      const profile = path.join(root, external ? 'external' : 'default')
      const legacy = path.join(profile, 'model-connections')
      const target = path.join(profile, 'protected-credentials/model-connections')
      await fs.mkdir(legacy, { recursive: true, mode: 0o700 })
      const source = path.join(external ? profile : legacy, 'model.yml')
      const original = JSON.stringify({
        version: 1,
        providers: [
          {
            id: 'rollback-binding',
            name: 'Rollback binding',
            base_url: 'https://model.invalid/v1',
            api_format: 'openai-responses',
            api_key: 'synthetic-source-model-key',
            models: [{ id: 'fixture', model_id: 'fixture' }],
          },
        ],
      })
      const binding = JSON.stringify({ path: source })
      await fs.writeFile(source, original, { mode: 0o600 })
      if (external)
        await fs.writeFile(path.join(legacy, 'model-binding.json'), binding, { mode: 0o600 })
      const store = new ModelConfigurationStore(target, new SecureValueStore(profile), legacy)
      assert.equal((await store.read()).error, undefined, 'Legacy model import failed')
      assert.equal(
        (await store.runtime()).models[0].provider.api_key,
        'synthetic-source-model-key',
        'Legacy model import lost its credential'
      )
      const snapshot = await store.bind(source)
      assert.equal(
        snapshot.path,
        path.join(target, 'model.yml'),
        'Legacy model file was not isolated'
      )
      await store.save(
        snapshot.revision,
        snapshot.providers.map(provider => ({
          ...provider,
          api_key: 'synthetic-target-model-key',
        }))
      )
      assert.equal(
        await fs.readFile(source, 'utf8'),
        original,
        'Binding changed the rollback model file'
      )
      if (external)
        assert.equal(
          await fs.readFile(path.join(legacy, 'model-binding.json'), 'utf8'),
          binding,
          'Binding changed the previous release selection'
        )
      await fs.writeFile(
        source,
        original.replace('synthetic-source-model-key', 'synthetic-rollback-model-key')
      )
      const reopened = new ModelConfigurationStore(target, new SecureValueStore(profile), legacy)
      assert.equal(
        (await reopened.read()).error,
        undefined,
        'Protected model binding did not reopen'
      )
      const runtime = await reopened.runtime()
      assert.equal(
        runtime.models[0].provider.api_key,
        'synthetic-target-model-key',
        'The protected model store synchronized a rollback write'
      )
      assert.ok(
        (await fs.readFile(source, 'utf8')).includes('synthetic-rollback-model-key'),
        'Reopening the target changed the rollback model file'
      )
      assert.ok(
        !(await fs.readFile(snapshot.path, 'utf8')).includes('synthetic-target-model-key'),
        'The selected model file contains a plaintext target credential'
      )
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
  return true
}
