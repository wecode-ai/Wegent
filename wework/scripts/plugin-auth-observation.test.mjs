// @vitest-environment node
import { test, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  pendingTarget,
  readTargetObservations,
  targetSettled,
} from '../e2e/desktop/modules/plugin-auth-observation.mjs'

test('observes the exact connector enrollment across unrelated audits and process restarts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-auth-observation-'))
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const marker = join(dir, 'reconcile')
  expect(await readTargetObservations(marker, 73, 'mail')).toEqual([])
  const target = {
    process: 1,
    id: 1,
    installed_plugin_id: 73,
    connector_slug: 'mail',
    phase: 'started',
  }
  const unrelated = [
    { ...target, phase: 'settled', process: 2 },
    { ...target, phase: 'settled', installed_plugin_id: 84 },
    { ...target, phase: 'settled', connector_slug: 'oauth' },
  ]
  const content = [target, ...unrelated].map(row => JSON.stringify(row)).join('\n') + '\n'
  await writeFile(`${marker}.targets`, content + '{"incomplete":')
  let rows = await readTargetObservations(marker, 73, 'mail')
  expect(pendingTarget(rows)).toEqual(target)
  expect(targetSettled(rows, target)).toBe(false)
  await writeFile(
    `${marker}.targets`,
    content + JSON.stringify({ ...target, phase: 'settled' }) + '\n'
  )
  rows = await readTargetObservations(marker, 73, 'mail')
  expect(targetSettled(rows, target)).toBe(true)
  expect(pendingTarget(rows)).toBeUndefined()
})
