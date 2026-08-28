import { createRequire } from 'node:module'
import { delimiter, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const { isPlainNodeRuntime, resolveNodeRuntime } = require('../scripts/node-runtime.cjs')
const electronRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('finds a plain Node.js runtime even when the current process is Electron', () => {
  const runtime = resolveNodeRuntime({
    ...process.env,
    PATH: process.env.PATH,
  })

  expect(isPlainNodeRuntime(runtime, process.env)).toBe(true)
})

test('rejects an explicit non-Node runtime instead of silently falling back', () => {
  expect(() =>
    resolveNodeRuntime({
      PATH: '',
      WEWORK_NODE_BINARY: electronRoot,
    })
  ).toThrow('WEWORK_NODE_BINARY is not a plain Node.js runtime')
})

test('fails when no plain Node.js runtime is available', () => {
  expect(() =>
    resolveNodeRuntime(
      {
        PATH: ['/missing/one', '/missing/two'].join(delimiter),
      },
      process.platform,
      '/missing/current-node'
    )
  ).toThrow('A plain Node.js runtime is required')
})
