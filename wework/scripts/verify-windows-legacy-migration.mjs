import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

import { prepareWindowsMigrationAssets } from './windows-legacy-migration.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../electron/package.json', import.meta.url))

// Compile the actual historical sources, not a reimplementation of their updater.
// The path adapter runs Windows digest semantics against real local files on macOS/Linux.
async function loadHistoricalManager(reference) {
  const nativePath = {
    ...path,
    join: (...parts) =>
      path.isAbsolute(parts[0])
        ? path.join(...parts.map(part => part.replaceAll('\\', '/')))
        : path.win32.join(...parts),
  }
  const modules = new Map()
  const load = sourcePath => {
    if (modules.has(sourcePath)) return modules.get(sourcePath).exports
    const source = execFileSync('git', ['show', `${reference}:${sourcePath}`], {
      cwd: repository,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText
    const module = { exports: {} }
    modules.set(sourcePath, module)
    const historicalRequire = name => {
      if (name === 'node:path') return nativePath
      if (!name.startsWith('.')) return require(name)
      return load(
        path.posix
          .normalize(path.posix.join(path.posix.dirname(sourcePath), name))
          .replace(/\.js$/, '.ts')
      )
    }
    new Function('require', 'module', 'exports', compiled)(
      historicalRequire,
      module,
      module.exports
    )
    return module.exports
  }
  return load('wework/electron/src/runtime/component-update-manager.ts')
}

export async function verifyHistoricalWindowsMigration(reference) {
  const { ComponentUpdateManager, hashComponentPath, MANAGED_COMPONENT_IDS } =
    await loadHistoricalManager(reference)
  const version = /^wework-v(.+)$/.exec(reference)?.[1]
  if (!version) throw new Error('A published wework-v<version> tag is required')
  const root = await mkdtemp(path.join(tmpdir(), 'wework-legacy-source-'))
  const server = createServer()
  try {
    const resources = path.join(root, 'resources')
    await mkdir(resources)
    const packaged = {}
    for (const id of MANAGED_COMPONENT_IDS) {
      const directory = path.join(resources, id)
      if (id === 'executor' || id === 'dws') await writeFile(directory, `packaged ${id}`)
      else {
        await mkdir(directory)
        await writeFile(path.join(directory, 'index.js'), `packaged ${id}`)
      }
      packaged[id] = {
        version: `packaged-${id}`,
        path: id,
        sha256: await hashComponentPath(directory),
      }
    }
    await mkdir(path.join(resources, 'weworkCorePlugins/wework-app/web'), { recursive: true })
    await writeFile(path.join(resources, 'weworkCorePlugins/wework-app/web/index.html'), 'old app')
    await mkdir(path.join(resources, 'weworkAppStatic/vendor'))
    await mkdir(path.join(resources, 'weworkAppStatic/wasm'))
    await writeFile(
      path.join(resources, 'codex/WEGENT_CODEX_BINARY.json'),
      JSON.stringify({ binaryPath: 'index.js' })
    )
    await writeFile(
      path.join(resources, 'codex/codex-code-mode-host.exe'),
      'packaged code-mode host'
    )
    for (const id of ['weworkCorePlugins', 'weworkAppStatic', 'codex']) {
      packaged[id].sha256 = await hashComponentPath(path.join(resources, id))
    }
    await writeFile(
      path.join(resources, 'components.json'),
      JSON.stringify({
        schemaVersion: 1,
        appVersion: version,
        components: packaged,
      })
    )
    const targetVersion = '1.2.3'
    const descriptor = await prepareWindowsMigrationAssets({
      directory: root,
      version: targetVersion,
      arch: 'x64',
    })
    const component = descriptor.components.executor
    const archive = await readFile(path.join(root, component.assetName))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const remote = {
      ...descriptor,
      channel: 'stable',
      components: Object.fromEntries(
        Object.entries(descriptor.components).map(([id, value]) => [
          id,
          {
            ...value,
            archiveBytes: archive.length,
            downloadUrl: `${baseUrl}/${value.assetName}`,
          },
        ])
      ),
    }
    let downloads = 0
    server.on('request', (request, response) => {
      if (request.url === '/components-stable-windows-x64.json')
        response.end(JSON.stringify(remote))
      else if (request.url === `/${component.assetName}`) {
        downloads++
        response.end(archive)
      } else response.writeHead(404).end()
    })
    const manager = new ComponentUpdateManager({
      resourcesRoot: resources,
      dataDirectory: path.join(root, 'data'),
      updateBaseUrl: baseUrl,
      currentAppVersion: version,
      platform: 'win32',
      arch: 'x64',
      fetch: globalThis.fetch,
    })
    assert.equal(await manager.stageUpdateForApp(targetVersion, 'stable'), true)
    const stateFile = path.join(root, 'data/managed-components/state.json')
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(state.pending.appVersion, targetVersion)
    assert.equal(state.pending.stagedFromAppVersion, version)
    assert.equal(downloads, 7)
    for (const id of MANAGED_COMPONENT_IDS) {
      const ticket = path.join(
        root,
        'data/managed-components/blobs',
        id,
        component.archiveSha256,
        component.entryPath
      )
      assert.equal(await hashComponentPath(ticket), component.contentSha256)
    }
    const startup = await manager.prepareStartup()
    assert.equal(startup.executor, path.join(resources, 'executor'))
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).pending.appVersion, targetVersion)
    // The fixture contains nested paths to distinguish native and POSIX tree algorithms.
    const treeHash = await hashComponentPath(path.join(resources, 'weworkCorePlugins'))
    return {
      reference,
      sourceSha: execFileSync('git', ['rev-parse', reference], {
        cwd: repository,
        encoding: 'utf8',
      }).trim(),
      stage: 'passed',
      oldClientRetainsPackagedExecutor: true,
      downloads,
      ticketSha256: component.contentSha256,
      treeHash,
    }
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const references = process.argv.slice(2)
  const results = []
  for (const reference of references.length
    ? references
    : ['wework-v0.4.1', 'wework-v0.5.10', 'wework-v0.5.12']) {
    const result = await verifyHistoricalWindowsMigration(reference)
    console.log(JSON.stringify(result))
    results.push(result)
  }
  if (results.length === 3 && references.length === 0) {
    assert.equal(results[0].treeHash, results[2].treeHash)
    assert.notEqual(results[0].treeHash, results[1].treeHash)
    console.log(
      'Verified historical native/POSIX divergence and shared migration-ticket compatibility'
    )
  }
}
