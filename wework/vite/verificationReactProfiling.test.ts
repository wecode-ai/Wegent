// @vitest-environment node
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { build } from 'vite'
import { expect, test } from 'vitest'
import { verificationReactProfiling } from './verificationReactProfiling'

test('a production verification bundle records actual React commits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verification-profiler-'))
  const source = join(directory, 'input.js')
  await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'junction')
  await writeFile(
    source,
    `import { createElement, Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
const root = createRoot(document.getElementById('root'))
window.commits = []
window.renderFixture = text => flushSync(() => root.render(createElement(Profiler, {
  id: 'verification',
  onRender: (id, phase, actualDuration) => window.commits.push({ id, phase, actualDuration })
}, createElement('p', null, text))))
window.disposeFixture = () => root.unmount()`
  )
  try {
    for (const profiling of [false, true]) {
      const output = await build({
        configFile: false,
        root: directory,
        logLevel: 'silent',
        plugins: profiling ? [verificationReactProfiling()] : [],
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        build: {
          write: false,
          rolldownOptions: { input: source, output: { format: 'iife' } },
        },
      })
      if (Array.isArray(output) || !('output' in output))
        throw new Error('Expected a single build output')
      const chunks = output.output.filter(item => item.type === 'chunk')
      expect(chunks).toHaveLength(1)
      const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only' })
      try {
        dom.window.eval(chunks[0].code)
        dom.window.renderFixture('First')
        expect(dom.window.document.getElementById('root')?.textContent).toBe('First')
        dom.window.renderFixture('Second')
        expect(dom.window.document.getElementById('root')?.textContent).toBe('Second')
        expect(dom.window.commits.map((commit: { phase: string }) => commit.phase)).toEqual(
          profiling ? ['mount', 'update'] : []
        )
        for (const commit of dom.window.commits) {
          expect(commit.actualDuration).toBeGreaterThanOrEqual(0)
          expect(commit.id).toBe('verification')
        }
        dom.window.disposeFixture()
      } finally {
        dom.window.close()
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
