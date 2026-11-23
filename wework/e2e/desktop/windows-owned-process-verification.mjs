import assert from 'node:assert/strict'
import { once } from 'node:events'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchWindowsOwnedApplication } from './windows-owned-process.mjs'
import { until } from './modules/plugin-regression-fixture.mjs'
import { withTimeout } from './modules/shared.mjs'

const marker = 'WINDOWS_OWNED_DESCENDANT_READY'
const descendant = `console.log('${marker}'); setInterval(() => {}, 1000)`
const parent = [
  "const fs = require('node:fs')",
  "const { spawn } = require('node:child_process')",
  'fs.watchFile(process.argv[1], { interval: 10 }, () => {',
  "  if (fs.readFileSync(process.argv[1], 'utf8') === 'exit') process.exit(0)",
  '})',
  `spawn(process.execPath, ['--input-type=commonjs', '-e', ${JSON.stringify(descendant)}],`,
  "  { stdio: ['ignore', 'inherit', 'inherit'] })",
].join('\n')

export async function verifyWindowsOwnedProcess(resultDir, timeoutMs) {
  if (process.platform !== 'win32') return
  const exitPath = join(resultDir, 'windows-owned-parent-exit')
  await writeFile(exitPath, 'waiting')
  const owned = await launchWindowsOwnedApplication(
    process.execPath,
    ['--input-type=commonjs', '-e', parent, exitPath],
    { cwd: resultDir, env: process.env },
    resultDir,
    timeoutMs
  )
  let output = ''
  owned.launcher.stdout.on('data', chunk => {
    output += chunk
  })
  owned.launcher.stderr.on('data', chunk => {
    output += chunk
  })
  const closed = once(owned.launcher, 'close')
  closed.catch(() => undefined)
  try {
    await withTimeout(
      (async () => {
        const application = await owned.application
        await owned.resume()
        await until(
          () => output.includes(marker),
          Boolean,
          'The real owned descendant did not start',
          timeoutMs
        )
        await writeFile(`${exitPath}.writing`, 'exit')
        await rename(`${exitPath}.writing`, exitPath)
        const [exitCode] = await closed
        assert.equal(exitCode, 0, output)
        assert.ok(output.includes(marker), 'Owned child output was lost')
        await writeFile(
          join(resultDir, 'windows-owned-process-verification.json'),
          JSON.stringify({
            applicationPid: application.pid,
            exitCode,
            descendantStarted: true,
            stdoutEnded: owned.launcher.stdout.readableEnded,
            stderrEnded: owned.launcher.stderr.readableEnded,
          })
        )
        assert.ok(owned.launcher.stdout.readableEnded && owned.launcher.stderr.readableEnded)
      })(),
      timeoutMs,
      'Owned descendants kept the exited application pipes open'
    )
  } finally {
    if (owned.launcher.exitCode === null && owned.launcher.signalCode === null)
      owned.launcher.kill('SIGTERM')
    await closed
    await rm(exitPath, { force: true })
  }
}
