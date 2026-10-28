import assert from 'node:assert/strict'
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SystemCredentialBackend } from '../dist/host/system-credential-backend.js'
import { SecureValueStore } from '../dist/host/secure-value-store.js'
import { ModelConfigurationStore } from '../dist/host/model-configuration-store.js'
import { CredentialMirrorMigration } from '../dist/host/credential-mirror-migration.js'
import { executorMigrationLock } from '../dist/runtime/workbench-migration-lock.js'

const script = fileURLToPath(import.meta.url)
const childMode = process.argv[2] === '--child'
const localSynthetic = process.argv.includes('--local-synthetic')
if (process.env.CI !== 'true' && !localSynthetic)
  throw new Error('Use an ephemeral CI runner or explicitly select --local-synthetic')
const service = childMode ? process.argv[3] : `wework-synthetic-credentials-${randomUUID()}`
assert.match(service, /^wework-synthetic-credentials-[a-f0-9-]{36}$/)
const executorIndex = process.argv.indexOf('--executor')
const executor = executorIndex === -1 ? null : process.argv[executorIndex + 1]
if (executorIndex !== -1) assert.ok(executor, '--executor needs a binary path')
const native = new SystemCredentialBackend(service)
const canary = 'Synthetic credential · 中文 · 🔑'
const large = '分片🔑'.repeat(700)
const secrets = { 'plugin.roundtrip': canary, 'plugin.empty': '', 'plugin.large': large }
const checkpoints = [
  'legacy-pending',
  'legacy-chunk',
  'legacy-commit',
  'legacy-clean',
  'model-intent',
  'model-file',
  'model-clean',
  'mirror-commit',
  'recovery-intent',
  'recovery-file',
  'recovery-clean',
]

function childArguments(directory, mode) {
  const args = [script, '--child', service, directory, mode]
  if (localSynthetic) args.push('--local-synthetic')
  if (executor) args.push('--executor', executor)
  return args
}

function child(directory, mode) {
  return spawnSync(process.execPath, childArguments(directory, mode), {
    env: process.env,
    timeout: 120_000,
    encoding: 'utf8',
  })
}

function parallelWriter(directory, mode) {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, childArguments(directory, mode), {
      env: process.env,
      timeout: 120_000,
      stdio: 'ignore',
    })
    worker.once('error', reject)
    worker.once('close', code =>
      code === 0 ? resolve() : reject(new Error(`Concurrent writer ${mode} failed`))
    )
  })
}

async function seed(directory) {
  const key = randomBytes(32)
  const values = Object.fromEntries(
    Object.entries(secrets).map(([name, value]) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return [
        name,
        Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]).toString('base64'),
      ]
    })
  )
  await writeFile(join(directory, 'secure-values.key'), key)
  await writeFile(join(directory, 'secure-values.json'), JSON.stringify({ version: 2, values }))
  await mkdir(join(directory, 'model-connections'))
  await writeFile(
    join(directory, 'model-connections/model.yml'),
    `version: 1
providers:
  - id: saved
    name: Synthetic connection
    base_url: https://synthetic.invalid/v1
    api_format: openai-responses
    api_key: synthetic-model-key
    models:
      - id: model-one
        model_id: upstream-one
`
  )
}

async function upgrade(directory, mode) {
  let phase = 'legacy'
  const accounts = join(directory, 'accounts.jsonl')
  const checkpoint = name => {
    if (mode !== name) return
    writeFileSync(join(directory, 'checkpoint'), name, { mode: 0o600, flush: true })
    process.kill(process.pid, 'SIGKILL')
  }
  const backend = {
    get: account => native.get(account),
    async set(account, value) {
      // Journal account names before writes so the parent can clean up after SIGKILL.
      appendFileSync(accounts, `${JSON.stringify(account)}\n`, { mode: 0o600 })
      await native.set(account, value)
      if (account.endsWith('.control')) {
        const control = JSON.parse(value)
        if (phase === 'legacy' && control.pending) checkpoint('legacy-pending')
        if (phase === 'legacy' && control.current && !control.pending) checkpoint('legacy-commit')
        if (phase === 'mirror' && control.current && !control.pending) checkpoint('mirror-commit')
      } else if (phase === 'legacy' && !account.startsWith('profile.')) checkpoint('legacy-chunk')
    },
    delete: account => native.delete(account),
  }
  // CI exercises sequential processes; --executor also tests the production native lock.
  const acquireLock = executor
    ? executorMigrationLock(executor, { wait: true })
    : async () => {
        let held = true
        return {
          assertHeld() {
            assert.ok(held)
          },
          async release() {
            held = false
          },
        }
      }
  const store = new SecureValueStore(directory, { backend, acquireLock })
  await store.initialize()
  if (mode.startsWith('writer-')) {
    assert.ok(executor, 'Concurrent writers require the production lock')
    await store.set(`plugin.${mode}`, mode)
    return
  }
  checkpoint('legacy-clean')
  phase = 'model'
  const wrapped = {
    get: key => store.get(key),
    set: (key, value) => store.set(key, value),
    delete: key => store.delete(key),
    async update(change) {
      const before = await store.get('wework-models.pending')
      let after
      await store.update(values => {
        change(values)
        after = values['wework-models.pending']
      })
      if (!before && after) checkpoint(phase === 'recovery' ? 'recovery-intent' : 'model-intent')
      if (before && !after) checkpoint(phase === 'recovery' ? 'recovery-clean' : 'model-clean')
    },
  }
  // Before the cleanup transaction the YAML and binding have already been published.
  const update = wrapped.update
  wrapped.update = async change => {
    if (await store.get('wework-models.pending'))
      checkpoint(phase === 'recovery' ? 'recovery-file' : 'model-file')
    return update(change)
  }
  const models = new ModelConfigurationStore(join(directory, 'model-connections'), wrapped)
  const snapshot = await models.read()
  assert.equal(snapshot.error, undefined)
  phase = 'mirror'
  const mirrors = new CredentialMirrorMigration(store)
  await mirrors.preferences({
    cloudConnection: {
      apiBaseUrl: 'https://synthetic.invalid/api',
      token: 'synthetic-mirror-token',
    },
  })
  for (const [key, value] of Object.entries(secrets)) assert.equal(await store.get(key), value)
  const runtime = await models.runtime()
  assert.equal(runtime.models[0].provider.api_key, 'synthetic-model-key')
  assert.equal(
    JSON.parse(await store.get('wework-cloud.legacy')).accessToken,
    'synthetic-mirror-token'
  )
  assert.equal(await store.get('wework-models.pending'), null)
  assert.ok(!(await readdir(directory)).includes('secure-values.key'))
  assert.ok(
    !(await readFile(join(directory, 'model-connections/model.yml'), 'utf8')).includes(
      'synthetic-model-key'
    )
  )
  phase = 'recovery'
  await mirrors.archive(
    'legacy-model-settings',
    JSON.stringify([
      {
        id: 'model-one',
        modelId: 'recovered-upstream',
        baseUrl: 'https://recovered.invalid/v1',
        apiKey: 'synthetic-recovery-key',
      },
    ])
  )
  let recovery = await models.recovery()
  const archived = recovery.candidates.find(item => item.kind === 'legacy-models')
  if (archived)
    await models.restoreRecovery(archived.id, recovery.revision, (await models.read()).revision)
  phase = 'snapshot-recovery'
  if (!(await store.get('plugin.synthetic-recovered'))) {
    const damagedPath = (await models.read()).path
    const damaged = 'bad: [synthetic-original-preserved'
    await writeFile(damagedPath, damaged)
    assert.ok((await models.read()).error)
    recovery = await models.recovery()
    const valid = recovery.candidates.find(item => item.kind === 'saved-configuration')
    assert.ok(valid)
    const restored = await models.restoreRecovery(valid.id, recovery.revision, '')
    assert.notEqual(restored.path, damagedPath)
    assert.equal(await readFile(damagedPath, 'utf8'), damaged)
    await store.set('plugin.synthetic-recovered', restored.path)
  }
  const restoredModels = (await models.runtime()).models
  assert.deepEqual(restoredModels.map(item => item.provider.api_key).sort(), [
    'synthetic-model-key',
    'synthetic-recovery-key',
  ])
  assert.equal((await models.read()).path, await store.get('plugin.synthetic-recovered'))
  assert.ok(
    !(await readFile((await models.read()).path, 'utf8')).includes('synthetic-recovery-key')
  )
  assert.equal(
    (await models.recovery()).candidates.filter(item => item.kind === 'legacy-models').length,
    0
  )
  if (mode === 'verify-concurrent') {
    assert.equal(await store.get('plugin.writer-one'), 'writer-one')
    assert.equal(await store.get('plugin.writer-two'), 'writer-two')
  }
}

async function roundtrip() {
  assert.equal(await native.get('roundtrip'), null)
  await native.set('roundtrip', canary)
  assert.equal(await native.get('roundtrip'), canary)
  await native.set('roundtrip', 'A'.repeat(2_000))
  assert.equal(await native.get('roundtrip'), 'A'.repeat(2_000))
  await native.set('roundtrip', 'rotated')
  assert.equal(await native.get('roundtrip'), 'rotated')
  await native.delete('roundtrip')
  await native.delete('roundtrip')
  assert.equal(await native.get('roundtrip'), null)
}

async function verifyNative() {
  const root = await mkdtemp(join(tmpdir(), 'wework-native-upgrade-'))
  const directories = []
  try {
    await roundtrip()
    for (const mode of ['normal', ...checkpoints]) {
      const directory = join(root, mode)
      directories.push(directory)
      await mkdir(directory)
      await seed(directory)
      const initial = child(directory, mode)
      if (mode === 'normal') assert.equal(initial.status, 0, initial.stderr)
      else {
        assert.equal(readFileSync(join(directory, 'checkpoint'), 'utf8'), mode)
        assert.ok(
          initial.signal === 'SIGKILL' || (process.platform === 'win32' && initial.status !== 0),
          `Checkpoint ${mode} did not terminate: ${initial.stderr}`
        )
      }
      // Two fresh processes must recover the exact original bytes and model binding.
      for (let restart = 0; restart < 2; restart++) {
        const recovered = child(directory, 'verify')
        assert.equal(recovered.status, 0, `${mode} recovery failed: ${recovered.stderr}`)
      }
      process.stdout.write(`Native upgrade ${mode}: preserved credentials across two restarts\n`)
      if (mode === 'normal' && executor) {
        await Promise.all([
          parallelWriter(directory, 'writer-one'),
          parallelWriter(directory, 'writer-two'),
        ])
        const concurrent = child(directory, 'verify-concurrent')
        assert.equal(concurrent.status, 0, concurrent.stderr)
        process.stdout.write(
          'Concurrent native writers: retained both changes with the production lock\n'
        )
      }
    }
  } finally {
    const accounts = new Set(['roundtrip'])
    for (const directory of directories) {
      try {
        for (const line of readFileSync(join(directory, 'accounts.jsonl'), 'utf8')
          .trim()
          .split('\n'))
          if (line) accounts.add(JSON.parse(line))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    // A fresh adapter still performs cleanup if a tested operation timed out.
    const cleanup = new SystemCredentialBackend(service)
    for (const account of accounts) await cleanup.delete(account)
    await rm(root, { recursive: true, force: true })
  }
  process.stdout.write(
    `Native credential verification passed on ${process.platform}/${process.arch}; production lock: ${Boolean(executor)}\n`
  )
}

if (childMode) await upgrade(process.argv[4], process.argv[5])
else await verifyNative()
