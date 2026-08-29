#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { CORE_PLUGIN_DIRECTORIES, corePluginTarget } from './lib/core-plugin-resources.mjs'

const execFileAsync = promisify(execFile)
const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const defaultWeworkRoot = resolve(scriptDirectory, '..')

function componentSha(id, sourceSha, source) {
  return createHash('sha256')
    .update(id)
    .update('\0')
    .update(sourceSha)
    .update('\0')
    .update(resolve(source))
    .digest('hex')
}

async function replaceLink(source, destination) {
  const metadata = await stat(source)
  await mkdir(dirname(destination), { recursive: true })
  await rm(destination, { recursive: true, force: true })
  const type =
    process.platform === 'win32' && metadata.isDirectory()
      ? 'junction'
      : metadata.isDirectory()
        ? 'dir'
        : 'file'
  await symlink(resolve(source), destination, type)
}

async function copyCorePlugin(weworkRoot, directory, destination) {
  const source = join(weworkRoot, 'dsh', directory)
  const appWebRoot = join(weworkRoot, 'dsh', 'app-wework', 'web')
  await cp(source, destination, {
    recursive: true,
    filter: path =>
      !path.endsWith('.test.mjs') &&
      (directory !== 'app-wework' ||
        (path !== appWebRoot && !path.startsWith(`${appWebRoot}${sep}`))),
  })
}

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function hashTree(root, relative = '') {
  const hash = createHash('sha256')
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(relative, entry.name)
    if (entry.isDirectory()) {
      hash.update(`directory:${child}\0${await hashTree(root, child)}\0`)
    } else if (entry.isFile()) {
      hash.update(`file:${child}\0${await sha256(join(root, child))}\0`)
    }
  }
  return hash.digest('hex')
}

async function resolveSourceSha(repositoryRoot) {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })
  return stdout.trim()
}

export async function prepareDevelopmentComponentResources(options) {
  const weworkRoot = resolve(options.weworkRoot ?? defaultWeworkRoot)
  const repositoryRoot = resolve(weworkRoot, '..')
  const electronRoot = join(weworkRoot, 'electron')
  const resourcesRoot = resolve(options.resourcesRoot)
  const sourceSha = options.sourceSha ?? (await resolveSourceSha(repositoryRoot))
  if (!/^[0-9a-f]{40,64}$/i.test(sourceSha)) {
    throw new Error(`Invalid Wework source SHA: ${sourceSha}`)
  }

  await rm(resourcesRoot, { recursive: true, force: true })
  await mkdir(resourcesRoot, { recursive: true, mode: 0o700 })

  const linkedComponents = {
    coreDsh: [options.runtimeRoot, 'harness-runtime'],
    bundledPlugins: [join(weworkRoot, 'resources', 'bundled-plugins'), 'bundled-plugins'],
    executor: [options.executorPath, join('bin', 'wegent-executor')],
    codex: [options.codexPath, join('codex', 'codex')],
    dws: [options.dwsPath, join('bin', 'dws')],
  }
  for (const [source, target] of Object.values(linkedComponents)) {
    await replaceLink(source, join(resourcesRoot, target))
  }

  const corePluginsRoot = join(resourcesRoot, 'wework-core-plugins')
  for (const directory of CORE_PLUGIN_DIRECTORIES) {
    await copyCorePlugin(weworkRoot, directory, join(corePluginsRoot, corePluginTarget(directory)))
  }
  const corePluginsSha256 = await hashTree(corePluginsRoot)

  const electronPackage = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8'))
  const weworkPackage = JSON.parse(await readFile(join(weworkRoot, 'package.json'), 'utf8'))
  const version = `wework-dev-${sourceSha.slice(0, 12)}`
  const components = {
    electron: {
      version: electronPackage.devDependencies.electron,
      path: '.',
      sha256: componentSha('electron', sourceSha, electronRoot),
    },
    coreDsh: component('harness-runtime', options.runtimeRoot),
    weworkCorePlugins: {
      version,
      path: 'wework-core-plugins',
      sha256: corePluginsSha256,
    },
    bundledPlugins: component('bundled-plugins', join(weworkRoot, 'resources', 'bundled-plugins')),
    executor: component(join('bin', 'wegent-executor'), options.executorPath),
    codex: component(join('codex', 'codex'), options.codexPath),
    dws: {
      ...component(join('bin', 'dws'), options.dwsPath),
      version: weworkPackage.devDependencies['dingtalk-workspace-cli'],
    },
  }

  function component(path, source) {
    return {
      version,
      path,
      sha256: componentSha(path, sourceSha, source),
    }
  }

  await writeFile(
    join(resourcesRoot, 'components.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        appVersion: electronPackage.version,
        sourceSha,
        channel: 'development',
        components,
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
  console.log(`Electron development resources: ${resourcesRoot}`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const required = name => {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`${name} is required`)
    return value
  }
  await prepareDevelopmentComponentResources({
    weworkRoot: defaultWeworkRoot,
    resourcesRoot: required('WEWORK_COMPONENT_RESOURCES_ROOT'),
    runtimeRoot: required('WEWORK_HARNESS_RUNTIME_ROOT'),
    executorPath: process.env.WEGENT_EXECUTOR_BINARY?.trim() || required('WEWORK_EXECUTOR_PATH'),
    codexPath: required('CODEX_BINARY_PATH'),
    dwsPath: required('DWS_BINARY_PATH'),
  })
}
