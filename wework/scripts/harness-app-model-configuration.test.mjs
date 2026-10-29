import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  readActiveHarnessModelRoutes,
  readPendingHarnessModelRoutes,
} from '../e2e/desktop/modules/harness-app-model-configuration.mjs'

const directories = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function instance() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-harness-model-configuration-'))
  directories.push(directory)
  await mkdir(join(directory, 'profiles', 'smoke'), { recursive: true })
  return directory
}

it('reads the active profile after DSH imports and renames the startup settings', async () => {
  const directory = await instance()
  await writeFile(join(directory, 'settings.yaml.imported'), 'llm-pi-ai: { providers: {} }\n')
  await writeFile(
    join(directory, 'profiles', 'smoke', 'cordis.patch.yml'),
    `- id: agent-default-model
  config: { provider: wework-local, model: wework-selected }
- id: llm-pi-ai
  config:
    providers:
      wework-local: { displayName: Wework, baseURL: 'http://127.0.0.1:9000/default' }
      wework-model-extra:
        displayName: 'Extra: model'
        baseURL: http://127.0.0.1:9000/extra
      unrelated: { displayName: No route }
`
  )

  await expect(readActiveHarnessModelRoutes(directory)).resolves.toEqual([
    { id: 'wework-local', displayName: 'Wework', baseUrl: 'http://127.0.0.1:9000/default' },
    {
      id: 'wework-model-extra',
      displayName: 'Extra: model',
      baseUrl: 'http://127.0.0.1:9000/extra',
    },
  ])
})

it('keeps active routes empty until the profile contains providers', async () => {
  const directory = await instance()
  await writeFile(
    join(directory, 'settings.yaml'),
    'llm-pi-ai: { providers: { wework-local: { baseURL: "http://127.0.0.1:9000/stale" } } }\n'
  )
  await writeFile(join(directory, 'profiles', 'smoke', 'cordis.patch.yml'), '[]\n')

  await expect(readActiveHarnessModelRoutes(directory)).resolves.toEqual([])
})

it('reads pending routes when an invalid profile prevents DSH from starting', async () => {
  const directory = await instance()
  await writeFile(join(directory, 'profiles', 'smoke', 'cordis.patch.yml'), '- id: [unterminated\n')
  await writeFile(
    join(directory, 'settings.yaml'),
    `llm-pi-ai:
  providers:
    wework-local: { displayName: Wework, baseURL: 'http://127.0.0.1:9000/failed-default' }
    wework-model-extra: { displayName: Extra, baseURL: 'http://127.0.0.1:9000/failed-extra' }
`
  )

  await expect(readPendingHarnessModelRoutes(directory)).resolves.toEqual([
    { id: 'wework-local', displayName: 'Wework', baseUrl: 'http://127.0.0.1:9000/failed-default' },
    {
      id: 'wework-model-extra',
      displayName: 'Extra',
      baseUrl: 'http://127.0.0.1:9000/failed-extra',
    },
  ])
})
