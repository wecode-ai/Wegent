import { expect, test } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialMirrorMigration } from './credential-mirror-migration.js'

function fixture() {
  let values: Record<string, string> = {}
  const migration = new CredentialMirrorMigration({
    update: async change => {
      const next = { ...values }
      change(next)
      values = next
    },
  })
  return {
    migration,
    values: () => values,
    update: (change: (values: Record<string, string>) => void) => change(values),
  }
}
const connection = {
  apiBaseUrl: 'https://cloud.example/api',
  credentialMode: 'legacy_access_token',
  token: 'token-canary',
  user: { id: 7 },
}

test('protects model and cloud mirrors before returning sanitized metadata, including empty keys', async () => {
  const f = fixture()
  const models = JSON.stringify([{ id: 'one', apiKey: 'model-canary' }])
  const safe = await f.migration.renderer({
    'wework.localModelSettings.v1': models,
    'wework.cloudConnection': JSON.stringify(connection),
    unrelated: 'keep',
  })
  expect(JSON.stringify(safe)).not.toMatch(/model-canary|token-canary|localModelSettings/)
  expect(safe.unrelated).toBe('keep')
  expect(f.values()['wework-models.legacy']).toBe(models)
  expect(JSON.parse(f.values()['wework-cloud.legacy'])).toEqual({
    apiBaseUrl: connection.apiBaseUrl,
    accessToken: 'token-canary',
  })
  expect(await f.migration.preferences({ cloudConnection: connection })).toEqual({
    cloudConnection: {
      apiBaseUrl: connection.apiBaseUrl,
      credentialMode: 'legacy_access_token',
      user: { id: 7 },
    },
  })
})

test('restored mirrors cannot replace selected credentials or resurrect a cleared connection', async () => {
  const f = fixture()
  await f.migration.renderer({
    'wework.localModelSettings.v1': '[]',
    'wework.cloudConnection': JSON.stringify(connection),
  })
  f.update(values => {
    delete values['wework-models.legacy']
    delete values['wework-cloud.legacy']
    values['wework-cloud.mirrors-closed'] = '3'
  })
  const safe = await f.migration.renderer({
    'wework.localModelSettings.v1': 'restored',
    'wework.cloudConnection': JSON.stringify(connection),
  })
  expect(f.values()['wework-models.legacy']).toBeUndefined()
  expect(f.values()['wework-cloud.legacy']).toBeUndefined()
  expect(JSON.stringify(safe)).not.toContain('token-canary')
})

test('conflicting legacy tokens are preserved privately without silently replacing the selected token', async () => {
  const f = fixture()
  await f.migration.preferences({ cloudConnection: connection })
  const safe = await f.migration.renderer({
    'wework.cloudConnection': JSON.stringify({ ...connection, token: 'other-canary' }),
  })
  expect(f.values()['wework-cloud.legacy']).toContain('token-canary')
  expect(Object.keys(f.values()).some(key => key.startsWith('wework-mirrors.conflict.'))).toBe(true)
  expect(JSON.stringify(safe)).not.toContain('other-canary')
})

test('archives exact damaged bytes before removing only known weak artifacts; failures keep the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-mirror-artifacts-'))
  try {
    const f = fixture()
    const name = 'app-preferences.json.corrupt-123'
    const bytes = Buffer.from([0, 255, 1, 2])
    await writeFile(join(root, name), bytes)
    await writeFile(join(root, 'unrelated.backup'), 'keep')
    const failing = new CredentialMirrorMigration({
      update: async () => {
        throw new Error('vault unavailable')
      },
    })
    await expect(failing.cleanArtifacts(root)).rejects.toThrow('vault unavailable')
    expect(await readFile(join(root, name))).toEqual(bytes)
    await f.migration.cleanArtifacts(root)
    expect(await readdir(root)).toEqual(['unrelated.backup'])
    const archive = JSON.parse(Object.values(f.values())[0])
    expect(archive.name).toBe(name)
    expect(Buffer.from(archive.base64, 'base64')).toEqual(bytes)
    await f.migration.archive(name, bytes)
    expect(Object.keys(f.values())).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each([
  'https://user:password@cloud.example',
  'ftp://cloud.example',
  'https://cloud.example?a=1',
  'https://cloud.example/#token',
])('invalid endpoint %s cannot silently select a token', async apiBaseUrl => {
  const f = fixture()
  await expect(
    f.migration.preferences({ cloudConnection: { ...connection, apiBaseUrl } })
  ).rejects.toThrow()
  expect(f.values()).toEqual({})
})
