// @vitest-environment node

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import {
  historicalPluginExecutor,
  LEGACY_PLUGIN_RELEASES,
} from '../e2e/desktop/modules/legacy-plugin-executor.mjs'

test.each(['interrupted', 'bad-hash', 'bad-cache'])(
  'historical plugin downloads preserve hash failures and clean up %s downloads',
  async failure => {
    const directory = await mkdtemp(join(tmpdir(), 'legacy-plugin-download-'))
    const release = LEGACY_PLUGIN_RELEASES[0]
    const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform]
    const hash = release.archives[`${platform}-${process.arch}`]
    const asset = `WeworkComponent_executor_${hash}_${platform}_${process.arch}.tar.gz`
    const fetch = vi.fn(async () => {
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
      assert.equal(fetch.mock.calls.length, failure === 'bad-cache' ? 0 : 1)
      if (failure === 'bad-cache')
        assert.equal(await readFile(join(directory, asset), 'utf8'), 'preserve invalid cache')
    } finally {
      vi.unstubAllGlobals()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
