// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { retainUpgradeReleaseDiagnostics } from '../../e2e/desktop/modules/upgrade-stopped-diagnostics.mjs'

test('retains migration progress without credentials or private journal entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stopped-diagnostics-'))
  try {
    const store = join(root, 'releases')
    const slot = join(store, 'slots', 'target')
    const home = join(root, 'codex')
    await mkdir(slot, { recursive: true })
    await mkdir(home)
    const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value))
    await json(join(slot, 'release.json'), { id: 'target', version: '2.0.0' })
    await json(join(slot, 'after-stop-request.json'), {
      protocol: 1,
      codexHome: home,
      workbenchRoot: join(root, 'workbench'),
    })
    await json(join(home, 'auth.json'), { credential: 'PRIVATE_AUTH_SENTINEL' })
    await json(join(home, '.wework-provider-migration.json'), {
      version: 3,
      complete: true,
      pending_from: 0,
      entries: [{ before: 'PRIVATE_SESSION_SENTINEL' }],
      index_routes: { private: 'PRIVATE_PROVIDER_SENTINEL' },
    })
    const resultDir = join(root, 'results')
    const electronUserDataDirectory = join(root, 'profile')
    await mkdir(resultDir)
    await mkdir(join(electronUserDataDirectory, 'logs'), { recursive: true })
    await writeFile(join(electronUserDataDirectory, 'logs', 'release.log'), 'retained diagnostic')
    await writeFile(join(store, 'active'), 'target')
    await retainUpgradeReleaseDiagnostics({
      root: store,
      version: '2.0.0',
      resultDir,
      electronUserDataDirectory,
    })
    const output = join(resultDir, 'stopped-preparation-result.json')
    const text = await readFile(output, 'utf8')
    expect(text).not.toContain('PRIVATE_')
    expect(JSON.parse(text).targets[0].homes[0].journal).toEqual({
      version: 3,
      complete: true,
      pendingFrom: 0,
      entries: 1,
    })
    expect(await readFile(join(resultDir, 'release-logs', 'release.log'), 'utf8')).toBe(
      'retained diagnostic'
    )
    expect(
      JSON.parse(await readFile(join(resultDir, 'release-state-result.json'), 'utf8'))
    ).toMatchObject({
      active: 'target',
      trial: null,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
