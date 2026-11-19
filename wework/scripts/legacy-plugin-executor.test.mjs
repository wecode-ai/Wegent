// @vitest-environment node

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, vi } from 'vitest'
import {
  historicalPluginExecutor,
  LEGACY_PLUGIN_RELEASES,
  assertHistoricalPackageUncached,
  seedHistoricalRuntimeBytecode,
} from '../e2e/desktop/modules/legacy-plugin-executor.mjs'

test('legacy bytecode fixture preserves the private package and installation manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-plugin-bytecode-'))
  const source = join(root, 'capabilities/store/plugins/41-wegent-demo-1.0')
  const runtime = join(root, 'codex/plugins/cache/wegent/demo/1.0')
  const claude = join(root, 'claude/plugins/cache/wegent/demo/1.0')
  const manifestPath = join(root, 'capabilities/manifest.json')
  await mkdir(source, { recursive: true })
  await mkdir(runtime, { recursive: true })
  await mkdir(claude, { recursive: true })
  await writeFile(join(source, 'payload.py'), 'original package')
  const manifest = JSON.stringify({
    version: 1,
    plugins: {
      'demo@wegent': {
        managed: true,
        installed_plugin_id: 41,
        store_path: source,
        runtime: { codex_link: runtime, claude_link: claude },
      },
    },
  })
  await writeFile(manifestPath, manifest)
  try {
    const result = await seedHistoricalRuntimeBytecode(root, LEGACY_PLUGIN_RELEASES[0], 'demo')
    assert.equal(result.installedPluginId, 41)
    assert.deepEqual(Object.keys(result.paths), ['codex_link', 'claude_link'])
    for (const path of Object.values(result.paths))
      assert.equal(await readFile(path, 'utf8'), 'generated runtime bytecode')
    assert.deepEqual(await readdir(source), ['payload.py'])
    assert.equal(await readFile(join(source, 'payload.py'), 'utf8'), 'original package')
    assert.equal(await readFile(manifestPath, 'utf8'), manifest)

    const shared = JSON.parse(manifest)
    shared.plugins['demo@wegent'].runtime.codex_link = source
    await writeFile(manifestPath, JSON.stringify(shared))
    await assert.rejects(
      seedHistoricalRuntimeBytecode(root, LEGACY_PLUGIN_RELEASES[0], 'demo'),
      /Bytecode must not alter the delivered package/
    )
    assert.deepEqual(await readdir(source), ['payload.py'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy bytecode fixture rejects a runtime alias of the private package before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-plugin-bytecode-alias-'))
  const source = join(root, 'source')
  const runtime = join(root, 'runtime')
  const alias = join(root, 'source-alias')
  try {
    await mkdir(source)
    await mkdir(runtime)
    await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await mkdir(join(root, 'capabilities'))
    await writeFile(
      join(root, 'capabilities/manifest.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'demo@wegent': {
            managed: true,
            store_path: source,
            runtime: { codex_link: runtime, claude_link: alias },
          },
        },
      })
    )
    await assert.rejects(
      seedHistoricalRuntimeBytecode(root, LEGACY_PLUGIN_RELEASES[0], 'demo'),
      /Bytecode must not alter the delivered package/
    )
    assert.deepEqual(await readdir(source), [])
    assert.deepEqual(await readdir(runtime), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each(['shared/plugins', 'shared/metadata'])(
  'legacy runtime witness precondition rejects cached archive evidence in %s',
  async directory => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-plugin-archive-proof-'))
    const digest = 'a'.repeat(64)
    const checksum = `sha256:${digest}`
    try {
      await assertHistoricalPackageUncached(root, checksum)
      const path = join(
        root,
        directory,
        directory.endsWith('metadata') ? `plugins-${digest}.json` : digest
      )
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'cached archive evidence')
      await assert.rejects(assertHistoricalPackageUncached(root, checksum))
      assert.equal(await readFile(path, 'utf8'), 'cached archive evidence')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test.each(['interrupted', 'bad-hash', 'bad-cache'])(
  'historical plugin downloads preserve hash failures and clean up %s downloads',
  async failure => {
    const directory = await mkdtemp(join(tmpdir(), 'legacy-plugin-download-'))
    const release = LEGACY_PLUGIN_RELEASES[0]
    const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform]
    const hash = release.archives[`${platform}-${process.arch}`]
    const asset = `WeworkComponent_executor_${hash}_${platform}_${process.arch}.tar.gz`
    const metadataUrl = `https://api.github.com/repos/wecode-ai/Wegent/releases/tags/wework-v${release.version}`
    const assetUrl = 'https://api.github.com/repos/wecode-ai/Wegent/releases/assets/123?download=1'
    const fetch = vi.fn(async url => {
      if (url === metadataUrl) return Response.json({ assets: [{ name: asset, id: 123 }] })
      assert.equal(url, assetUrl)
      if (failure === 'interrupted') {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial'))
              setTimeout(() => controller.error(new Error('interrupted download')), 0)
            },
          })
        )
      }
      return new Response('untrusted archive')
    })
    vi.stubGlobal('fetch', fetch)
    try {
      if (failure === 'bad-cache') await writeFile(join(directory, asset), 'preserve invalid cache')
      await assert.rejects(
        historicalPluginExecutor(release, directory),
        failure === 'interrupted' ? /interrupted download/ : /Historical component bytes changed/
      )
      assert.deepEqual(await readdir(directory), failure === 'bad-cache' ? [asset] : [])
      assert.deepEqual(
        fetch.mock.calls.map(([url]) => url),
        failure === 'bad-cache' ? [] : [metadataUrl, assetUrl]
      )
      if (failure === 'bad-cache')
        assert.equal(await readFile(join(directory, asset), 'utf8'), 'preserve invalid cache')
    } finally {
      vi.unstubAllGlobals()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
