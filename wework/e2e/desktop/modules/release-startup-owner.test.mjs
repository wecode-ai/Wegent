import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
  async context => {
    const root = await mkdtemp(join(tmpdir(), 'wework-native-release-startup-'))
    const alias = `${root}-alias`
    const entry = join(root, 'main.cjs')
    const source = fileURLToPath(
      new URL('../../../electron/src/runtime/release-startup-owner.ts', import.meta.url)
    )
    const { stdout } = await promisify(execFile)('rustc', ['-vV'])
    const target = /^host: (.+)$/m.exec(stdout)[1]
    const launcher = await phase('build launcher', buildLauncher(join(root, 'resources'), target))
    const hosts = []
    const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
    const electron = require('electron')
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(
      entry,
      `
    const {app} = require('electron')
    const {appendFileSync,existsSync,readFileSync,mkdirSync} = require('node:fs')
    const trace = phase => {
      const event = JSON.stringify({phase,pid:process.pid})
      appendFileSync(require('node:path').join(${JSON.stringify(root)}, 'trace-' + process.pid + '.jsonl'), event + '\\n')
      console.error(event)
    }
    trace('entry')
    const profile = require('node:path').join(${JSON.stringify(root)}, 'profile-' + process.pid)
    mkdirSync(profile, {recursive:true,mode:0o700})
    app.setPath('userData', profile)
    const {stripTypeScriptTypes} = require('node:module')
    const code = stripTypeScriptTypes(readFileSync(${JSON.stringify(source)}, 'utf8'))
    import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')).then(async ({acquireReleaseStartup}) => {
      trace('acquiring')
      const release = await acquireReleaseStartup(process.argv.at(-1), ${JSON.stringify(launcher)}, error => {
        console.error(error.message)
        app.exit(1)
      })
      trace('acquired')
      await app.whenReady()
      trace('ready')
      console.log(JSON.stringify({owned:true,pid:process.pid}))
      // Windows Electron's GUI entry closes stdin; use an explicit test command file.
      const command = require('node:path').join(${JSON.stringify(root)}, 'release-' + process.pid)
      const commands = setInterval(() => {
        if (!existsSync(command)) return
        clearInterval(commands)
        void (async () => {
          trace('releasing')
          await release()
          trace('released')
          app.exit(0)
        })().catch(error => {console.error(error);app.exit(1)})
      }, 25)
    }).catch(error => {console.error(error);app.exit(1)})
  `
    )
    function launch(identity) {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.NODE_OPTIONS
      const child = spawn(electron, [entry, identity], { env, stdio: ['ignore', 'pipe', 'pipe'] })
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
          assert.equal(JSON.parse(line).pid, child.pid)
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
      void host.ready.catch(() => {})
      return host
    }
    async function releaseAndExit(host, name) {
      await writeFile(join(root, `release-${host.child.pid}`), 'release')
      assert.deepEqual(await phase(name, host.exited, host), [0, null], host.stderr)
      const trace = await readFile(join(root, `trace-${host.child.pid}.jsonl`), 'utf8')
      assert.ok(
        trace
          .trim()
          .split('\n')
          .map(line => JSON.parse(line))
          .some(event => event.phase === 'released' && event.pid === host.child.pid),
        trace
      )
    }
    async function phase(name, operation, host, signal = context.signal) {
      console.log(`[native-startup] ${name}: start${host ? ` pid=${host.child.pid}` : ''}`)
      let timer
      let cancel
      try {
        return await Promise.race([
          operation,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${name} exceeded 15 seconds`)), 15_000)
            cancel = () => reject(signal.reason)
            signal.addEventListener('abort', cancel, { once: true })
            if (signal.aborted) cancel()
          }),
        ])
      } catch (error) {
        console.error(`[native-startup] ${name}: failed`, {
          pid: host?.child.pid,
          exitCode: host?.child.exitCode,
          signalCode: host?.child.signalCode,
          stderr: host?.stderr,
          trace: host
            ? await readFile(join(root, `trace-${host.child.pid}.jsonl`), 'utf8').catch(
                error => error.message
              )
            : undefined,
        })
        throw error
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
      }
    }
    try {
      const first = launch(root)
      await phase('first ownership', first.ready, first)
      const next = launch(alias)
      // A negative observation window proves the waiting process cannot enter the transaction.
      await new Promise(resolve => setTimeout(resolve, 500))
      assert.equal(next.owned, false)
      assert.equal(next.child.exitCode, null)
      first.child.kill('SIGKILL')
      await phase('crashed owner exit', first.exited, first)
      await phase('ownership after crash', next.ready, next)
      await releaseAndExit(next, 'normal owner exit')
      const afterRelease = launch(root)
      await phase('ownership after release', afterRelease.ready, afterRelease)
      await releaseAndExit(afterRelease, 'final owner exit')
    } finally {
      for (const host of hosts) {
        if (host.child.exitCode === null && host.child.signalCode === null)
          host.child.kill('SIGKILL')
        try {
          await phase('cleanup owner', host.exited, host, new AbortController().signal)
        } finally {
          host.child.stdout.destroy()
          host.child.stderr.destroy()
        }
      }
      await rm(alias, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  }
)
