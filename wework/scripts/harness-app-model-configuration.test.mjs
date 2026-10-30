import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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

it('reads model routes from the shared artifact without workspace dependencies', async () => {
  const directory = await instance()
  const artifact = join(directory, 'e2e-client')
  const bundled = spawnSync(
    process.execPath,
    [join(import.meta.dirname, 'build-desktop-e2e-client.mjs'), artifact],
    { encoding: 'utf8', timeout: 10_000 }
  )
  expect(bundled.error).toBeUndefined()
  expect(bundled.status, bundled.stdout + bundled.stderr).toBe(0)

  const fixture = join(directory, 'workspace', 'wework', 'e2e', 'desktop', 'modules')
  await mkdir(fixture, { recursive: true })
  const modulePath = join(fixture, 'harness-app-model-configuration.mjs')
  await copyFile(
    join(import.meta.dirname, '../e2e/desktop/modules/harness-app-model-configuration.mjs'),
    modulePath
  )
  await writeFile(
    join(directory, 'profiles', 'smoke', 'cordis.patch.yml'),
    '- id: llm-pi-ai\n  config:\n    providers:\n      bundled: { baseURL: http://127.0.0.1:9000/model }\n'
  )
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const {createRequire} = await import('node:module')
const {io} = createRequire(import.meta.url)(process.argv[3])
if (typeof io !== 'function') throw new Error('The bundled Socket.IO client is unavailable')
const {readActiveHarnessModelRoutes} = await import(process.argv[1])
console.log(JSON.stringify(await readActiveHarnessModelRoutes(process.argv[2])))`,
      pathToFileURL(modulePath).href,
      directory,
      join(artifact, 'socket.io-client.cjs'),
    ],
    {
      env: { ...process.env, WEWORK_E2E_YAML_PARSER: join(artifact, 'yaml.cjs'), NODE_PATH: '' },
      encoding: 'utf8',
      timeout: 10_000,
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual([
    { id: 'bundled', displayName: '', baseUrl: 'http://127.0.0.1:9000/model' },
  ])
}, 15_000)
