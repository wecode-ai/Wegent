import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { buildLauncher } from '../../../electron/scripts/build-launcher.mjs'

test(
  'native bootstrap transactions serialize aliases and release after an Electron crash',
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-native-release-startup-'))
    const alias = `${root}-alias`
    const entry = join(root, 'main.cjs')
    const source = fileURLToPath(
      new URL('../../../electron/src/runtime/release-startup-owner.ts', import.meta.url)
    )
    const { stdout } = await promisify(execFile)('rustc', ['-vV'])
    const target = /^host: (.+)$/m.exec(stdout)[1]
    const launcher = await buildLauncher(join(root, 'resources'), target)
    const hosts = []
    const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
    const electron = require('electron')
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(
      entry,
      `
    const {app} = require('electron')
    const {readFileSync,mkdirSync} = require('node:fs')
    const profile = require('node:path').join(${JSON.stringify(root)}, 'profile-' + process.pid)
    mkdirSync(profile, {recursive:true,mode:0o700})
    app.setPath('userData', profile)
    const {stripTypeScriptTypes} = require('node:module')
    const code = stripTypeScriptTypes(readFileSync(${JSON.stringify(source)}, 'utf8'))
    import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')).then(async ({acquireReleaseStartup}) => {
      const release = await acquireReleaseStartup(process.argv.at(-1), ${JSON.stringify(launcher)}, error => {
        console.error(error.message)
        app.exit(1)
      })
      await app.whenReady()
      console.log(JSON.stringify({owned:true,pid:process.pid}))
      process.stdin.once('data', async () => {await release();app.exit(0)})
      setInterval(() => {}, 1000)
    }).catch(error => {console.error(error);app.exit(1)})
  `
    )
    function launch(identity) {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.NODE_OPTIONS
      const child = spawn(electron, [entry, identity], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      const exited = once(child, 'exit')
      const host = { child, exited, stderr: '', owned: false }
      hosts.push(host)
      child.stderr.on('data', chunk => {
        host.stderr += chunk
      })
      const lines = createInterface({ input: child.stdout, signal: AbortSignal.timeout(15_000) })
      const reported = (async () => {
        for await (const line of lines) {
          if (!line.trim()) continue
          assert.equal(JSON.parse(line).owned, true)
          host.owned = true
          return
        }
        throw new Error(`Native startup did not report ownership: ${host.stderr}`)
      })()
      host.ready = Promise.race([
        reported,
        exited.then(() => {
          throw new Error(`Native startup exited before reporting: ${host.stderr}`)
        }),
      ])
      return host
    }
    try {
      const first = launch(root)
      await first.ready
      const next = launch(alias)
      // A negative observation window proves the waiting process cannot enter the transaction.
      await new Promise(resolve => setTimeout(resolve, 500))
      assert.equal(next.owned, false)
      assert.equal(next.child.exitCode, null)
      first.child.kill('SIGKILL')
      await first.exited
      await next.ready
      next.child.stdin.end('release')
      assert.deepEqual(await next.exited, [0, null], next.stderr)
      const afterRelease = launch(root)
      await afterRelease.ready
      afterRelease.child.stdin.end('release')
      assert.deepEqual(await afterRelease.exited, [0, null], afterRelease.stderr)
    } finally {
      for (const host of hosts) {
        if (host.child.exitCode === null && host.child.signalCode === null)
          host.child.kill('SIGKILL')
        await host.exited
        await host.ready.catch(() => {})
      }
      await rm(alias, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  }
)
