import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { assertInstalledStartupWithStaleHistory } from '../e2e/desktop/modules/installed-startup-history.mjs'
import { processIsAlive } from '../e2e/desktop/process-lifecycle.mjs'

for (const version of ['target', 'wrong-source']) {
  test(`stops the upgraded host before stale-history restart (${version})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-startup-history-'))
    const host = spawn(
      process.execPath,
      ['-e', 'process.on("message", () => process.exit(0)); process.send("ready")'],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    )
    const exited = once(host, 'exit')
    try {
      await once(host, 'message')
      for (const [name, value] of Object.entries({
        active: 'target-slot',
        bridge: 'target-host',
        previousHealthy: 'source-slot',
        'active-pid': String(host.pid),
      }))
        await writeFile(join(root, name), value)
      const commands = []
      const verification = assertInstalledStartupWithStaleHistory({
        root,
        expectedVersion: 'target',
        installedVersion: async () => version,
        timeoutMs: 10_000,
        control: {
          async command(name) {
            commands.push(name)
            if (name === 'quitApp') host.send('quit')
          },
        },
        async restartDesktopApp({ afterStop }) {
          assert.equal(processIsAlive(host.pid), false, 'Upgraded host still owns the singleton')
          await afterStop()
          assert.equal(await readFile(join(root, 'active'), 'utf8'), 'source-slot')
          assert.equal(await readFile(join(root, 'bridge'), 'utf8'), join(root, 'missing-old-host'))
        },
      })
      if (version === 'target') {
        await verification
        expect(commands).toEqual(['quitApp', 'waitFor'])
      } else {
        await expect(verification).rejects.toThrow('Old release history overrode')
        expect(commands).toEqual(['quitApp'])
      }
      expect(await readFile(join(root, 'active'), 'utf8')).toBe('target-slot')
      expect(await readFile(join(root, 'bridge'), 'utf8')).toBe('target-host')
    } finally {
      host.kill()
      await exited
      await rm(root, { recursive: true, force: true })
    }
  })
}
