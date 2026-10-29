import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { test, expect, vi, onTestFailed, onTestFinished } from 'vitest'
import { watchDevelopmentBuild } from './lib/development-build-watch.mjs'

async function publishSource(temporary, source, contents) {
  // Publish complete inputs; writeFile on the watched source exposes a truncated file.
  const next = path.join(temporary, 'next-entry.js')
  await writeFile(next, contents)
  await rename(next, source)
}

test.each(['checkout', 'dist/checkout', '.git/worktrees/checkout', 'node_modules/checkout'])(
  'builds changes under %s, recovers from failure, and ignores output',
  async checkout => {
    const started = performance.now()
    const phases = []
    const snapshots = []
    const errors = []
    let published = ''
    const record = phase =>
      phases.push({ phase, elapsedMs: Math.round(performance.now() - started) })
    onTestFailed(() => {
      console.error('[development-build-watch]', { checkout, phases, snapshots, errors, published })
    })
    record('preparing-source')
    const temporary = await mkdtemp(path.join(tmpdir(), 'development-build-watch-'))
    const root = path.join(temporary, checkout)
    await mkdir(root, { recursive: true })
    const output = path.join(root, 'output')
    await mkdir(output)
    const source = path.join(root, 'entry.js')
    await writeFile(source, 'one')
    const failedBuild = Promise.withResolvers()
    const recoveredBuild = Promise.withResolvers()
    const subsequentBuild = Promise.withResolvers()
    const onError = vi.fn(error => {
      errors.push(error.message)
      record('failed-build-callback')
      failedBuild.resolve(error)
    })
    const build = vi.fn(async () => {
      const snapshot = await readFile(source, 'utf8')
      snapshots.push(snapshot)
      record('build-read-source')
      if (snapshot === 'invalid') throw new Error('compile failed')
      published = snapshot
      await writeFile(path.join(output, 'bundle.js'), snapshot)
      if (snapshot === 'two') recoveredBuild.resolve()
      if (snapshot === 'three') subsequentBuild.resolve()
    })
    record('starting-watcher')
    const watcher = await watchDevelopmentBuild({
      directories: [root],
      files: [],
      ignored: [output],
      build,
      onError,
      debounceMs: 20,
    })
    onTestFinished(async () => {
      record('closing-watcher')
      await watcher.close()
      record('watcher-closed')
      await rm(temporary, { recursive: true, force: true })
    })
    record('initial-build-ready')
    expect(published).toBe('one')
    record('publishing-invalid-source')
    await publishSource(temporary, source, 'invalid')
    record('awaiting-failed-build')
    // Await native build callbacks under Vitest's test deadline, with cleanup
    // registered separately so a missing notification cannot leak the watcher.
    expect(await failedBuild.promise).toEqual(new Error('compile failed'))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(published).toBe('one')
    record('publishing-recovered-source')
    await publishSource(temporary, source, 'two')
    record('awaiting-recovered-build')
    await recoveredBuild.promise
    record('recovered-build-ready')
    expect(published).toBe('two')
    expect(snapshots).toEqual(['one', 'invalid', 'two'])
    expect(build).toHaveBeenCalledTimes(3)
    record('publishing-subsequent-atomic-save')
    await publishSource(temporary, source, 'three')
    await subsequentBuild.promise
    expect(published).toBe('three')
    expect(snapshots).toEqual(['one', 'invalid', 'two', 'three'])
    expect(build).toHaveBeenCalledTimes(4)
  }
)

test('observes edits inside an existing linked workspace directory', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'development-watch-linked-workspace-'))
  const root = path.join(temporary, 'checkout')
  const target = path.join(temporary, 'linked-source')
  await Promise.all([mkdir(root), mkdir(target)])
  const source = path.join(target, 'entry.js')
  const linked = path.join(root, 'workspace')
  await writeFile(source, 'one')
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir')
  const rebuilt = Promise.withResolvers()
  const snapshots = []
  const watcher = await watchDevelopmentBuild({
    directories: [root],
    files: [],
    debounceMs: 20,
    onError: error => rebuilt.reject(error),
    build: async () => {
      const snapshot = await readFile(path.join(linked, 'entry.js'), 'utf8')
      snapshots.push(snapshot)
      if (snapshot === 'two') rebuilt.resolve()
    },
  })
  onTestFinished(async () => {
    await watcher.close()
    await rm(temporary, { recursive: true, force: true })
  })
  await writeFile(source, 'two')
  await rebuilt.promise
  expect(snapshots).toEqual(['one', 'two'])
})

test('rebuilds unchanged CSS assets and publishes subsequent asset edits with fresh Vite instances', async () => {
  const { build: viteBuild } = await import('vite')
  const { readdir } = await import('node:fs/promises')
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'wework-css-build-')))
  const output = path.join(root, 'output')
  await writeFile(path.join(root, 'index.html'), '<script type="module" src="/entry.js"></script>')
  await writeFile(path.join(root, 'entry.js'), 'import "./style.css"; console.log("one")')
  await writeFile(path.join(root, 'style.css'), 'body { background: url("./image.svg") }')
  const svg = color =>
    `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${color}" width="10" height="10"/></svg>`
  await writeFile(path.join(root, 'image.svg'), svg('red'))
  let completed = 0
  const onError = vi.fn()
  const watcher = await watchDevelopmentBuild({
    directories: [root],
    files: [],
    ignored: [output],
    debounceMs: 20,
    onError,
    build: async () => {
      await viteBuild({
        root,
        configFile: false,
        logLevel: 'silent',
        build: { outDir: output, emptyOutDir: false, assetsInlineLimit: 0 },
      })
      completed += 1
    },
  })
  try {
    await writeFile(path.join(root, 'entry.js'), 'import "./style.css"; console.log("two")')
    await expect.poll(() => completed, { timeout: 10000 }).toBe(2)
    await writeFile(path.join(root, 'image.svg'), svg('blue'))
    await expect.poll(() => completed, { timeout: 10000 }).toBe(3)
    expect(onError).not.toHaveBeenCalled()
    expect(
      (await readdir(path.join(output, 'assets'))).filter(file => file.endsWith('.svg'))
    ).toHaveLength(2)
  } finally {
    await watcher.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
