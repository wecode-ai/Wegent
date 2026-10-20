import { execFile } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'

const execute = promisify(execFile)
const roots = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('builds and materializes one archive per DSH source while preserving role assignments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-shared-runtime-'))
  roots.push(root)
  const scripts = join(root, 'scripts')
  const source = join(root, 'harness-runtime')
  const commands = join(root, 'commands')
  await Promise.all([
    mkdir(scripts),
    mkdir(join(source, 'plugins'), { recursive: true }),
    mkdir(commands),
    symlink(resolve('node_modules'), join(root, 'node_modules'), 'junction'),
  ])
  await Promise.all([
    cp(
      resolve('scripts/prepare-harness-runtime.mjs'),
      join(scripts, 'prepare-harness-runtime.mjs')
    ),
    cp(resolve('scripts/child-process-command.mjs'), join(scripts, 'child-process-command.mjs')),
    cp(resolve('scripts/lib'), join(scripts, 'lib'), { recursive: true }),
    writeFile(join(source, '.npmrc'), ''),
    writeFile(join(source, 'pnpm-workspace.yaml'), ''),
    writeFile(join(source, 'published-runtimes.json'), '{}'),
    writeFile(
      join(commands, 'install.cjs'),
      `
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
appendFileSync(process.env.INSTALL_LOG, version + '\\n')
const root = join('node_modules', '@deepseek-ai', 'dsh')
mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'package.json'), JSON.stringify({ version }))
writeFileSync(join(root, 'lib', 'bin.js'), '')
`
    ),
  ])
  if (process.platform === 'win32') {
    await writeFile(join(commands, 'pnpm.cmd'), `@"${process.execPath}" "%~dp0install.cjs" %*\r\n`)
  } else {
    await writeFile(join(commands, 'pnpm'), `#!/usr/bin/env node\nimport './install.cjs'\n`, {
      mode: 0o755,
    })
  }
  for (const [version, roles] of [
    ['0.1.0-rc.8', ['workbench']],
    ['0.2.0-rc.2', ['core', 'workbench']],
  ]) {
    const directory = join(source, 'runtimes', version)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        version,
        dependencies: { '@deepseek-ai/dsh': version },
        wework: { runtimeRoles: roles },
      })
    )
    await writeFile(join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  }
  const cache = join(root, 'cache')
  const log = join(root, 'installs.log')
  const environment = {
    ...process.env,
    PATH: `${commands}${delimiter}${process.env.PATH}`,
    INSTALL_LOG: log,
    APPLE_SIGNING_IDENTITY: '',
    WEWORK_HARNESS_RUNTIME_URL: '',
    WEWORK_HARNESS_RUNTIME_SKIP_REMOTE_REUSE: '1',
    WEWORK_HARNESS_RUNTIME_CACHE_ROOT: cache,
    WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT: cache,
  }
  const prepare = () =>
    execute(process.execPath, [join(scripts, 'prepare-harness-runtime.mjs'), '--materialize'], {
      cwd: root,
      env: environment,
    })

  await prepare()

  const { runtimes } = JSON.parse(
    await readFile(join(root, 'resources', 'bundled-harness-runtime', 'runtimes.json'), 'utf8')
  )
  expect(runtimes.map(runtime => [runtime.dshVersion, runtime.role])).toEqual([
    ['0.1.0-rc.8', 'workbench'],
    ['0.2.0-rc.2', 'core'],
    ['0.2.0-rc.2', 'workbench'],
  ])
  const [core, workbench] = runtimes.filter(runtime => runtime.dshVersion === '0.2.0-rc.2')
  expect(core.assetName).toBe(workbench.assetName)
  expect(core.sourceFingerprint).toBe(workbench.sourceFingerprint)
  expect(core.archiveSha256).toBe(workbench.archiveSha256)
  const assets = await readdir(join(cache, 'harness-runtime-assets'))
  expect(assets.filter(name => name.endsWith('.tar.gz'))).toHaveLength(2)
  expect((await readFile(log, 'utf8')).trim().split('\n').sort()).toEqual([
    '0.1.0-rc.8',
    '0.2.0-rc.2',
  ])
  const identity = JSON.parse(
    await readFile(
      join(cache, 'harness-runtime-dev', core.sourceFingerprint, 'runtime.json'),
      'utf8'
    )
  )
  expect(identity.roles).toEqual(['core', 'workbench'])
  const descriptor = JSON.parse(
    await readFile(
      join(cache, 'harness-runtime-assets', core.assetName.replace(/\.tar\.gz$/, '.json')),
      'utf8'
    )
  )
  expect(descriptor).not.toHaveProperty('role')

  await prepare()

  expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(2)
  expect((await readdir(join(cache, 'harness-runtime-dev'))).sort()).toEqual(
    [...new Set(runtimes.map(runtime => runtime.sourceFingerprint)), 'runtimes.json'].sort()
  )

  const legacy = runtimes.find(runtime => runtime.dshVersion === '0.1.0-rc.8')
  const { role: _legacyRole, ...publishedDescriptor } = legacy
  const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform]
  await writeFile(
    join(source, 'published-runtimes.json'),
    JSON.stringify({
      '0.1.0-rc.8': {
        roles: ['workbench'],
        assets: { [`${platform}-${process.arch}`]: publishedDescriptor },
      },
    })
  )
  await rm(join(source, 'runtimes', '0.1.0-rc.8'), { recursive: true })
  await rm(join(cache, 'harness-runtime-assets', legacy.assetName))
  const legacyRoot = join(cache, 'harness-runtime-dev', legacy.sourceFingerprint)
  const downloadedContent = join(cache, 'harness-runtime-dev', '.content-legacy-fixture')
  await rename(legacyRoot, downloadedContent)
  await symlink(downloadedContent, legacyRoot, 'junction')

  await prepare()

  const pinnedCatalog = JSON.parse(
    await readFile(join(root, 'resources', 'bundled-harness-runtime', 'runtimes.json'), 'utf8')
  )
  expect(pinnedCatalog.runtimes.find(runtime => runtime.dshVersion === '0.1.0-rc.8')).toEqual(
    legacy
  )
  expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(2)
  expect(JSON.parse(await readFile(join(legacyRoot, 'runtime.json'), 'utf8')).dshVersion).toBe(
    legacy.dshVersion
  )
})
