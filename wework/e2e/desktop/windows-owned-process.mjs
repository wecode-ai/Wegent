import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function windowsApplicationCommandLine(executable, args) {
  return [executable, ...args]
    .map(argument => {
      assert.equal(typeof argument, 'string')
      assert.ok(!argument.includes('\0'), 'Windows arguments cannot contain NUL')
      return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
    })
    .join(' ')
}

async function applicationHandle(launcher, pidPath, timeoutMs, state) {
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      if (state.error) throw state.error
      try {
        const pid = Number(await readFile(pidPath, 'utf8'))
        assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Invalid owned application PID')
        return {
          pid,
          launcher,
          stdout: launcher.stdout,
          stderr: launcher.stderr,
          get exitCode() {
            return launcher.exitCode
          },
          get signalCode() {
            return launcher.signalCode
          },
          on: launcher.on.bind(launcher),
          once: launcher.once.bind(launcher),
          off: launcher.off.bind(launcher),
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (launcher.exitCode !== null || launcher.signalCode !== null)
        throw new Error(
          `Windows owned launcher exited before application creation: ${launcher.exitCode}`
        )
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('Windows owned application was not created within its startup budget')
  } catch (error) {
    launcher.kill('SIGTERM')
    throw error
  }
}

export async function launchWindowsOwnedApplication(
  executable,
  args,
  options,
  resultDir,
  timeoutMs
) {
  const configPath = join(resultDir, `windows-launch-${randomUUID()}.json`)
  const pidPath = `${configPath}.pid`
  const resumePath = `${configPath}.resume`
  await writeFile(
    configPath,
    JSON.stringify({
      executable,
      commandLine: windowsApplicationCommandLine(executable, args),
      directory: options.cwd,
      ownerProcessId: process.pid,
    })
  )
  const launcher = spawn(
    'pwsh.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      join(import.meta.dirname, 'windows-owned-process.ps1'),
      '-ConfigPath',
      configPath,
      '-PidPath',
      pidPath,
      '-ResumePath',
      resumePath,
    ],
    {
      ...options,
      cwd: import.meta.dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  )
  const state = { error: null }
  launcher.once('error', error => {
    state.error = error
  })
  const application = applicationHandle(launcher, pidPath, timeoutMs, state)
  application.catch(() => undefined)
  return {
    launcher,
    application,
    async resume() {
      await writeFile(`${resumePath}.writing`, 'resume')
      await rename(`${resumePath}.writing`, resumePath)
      await Promise.all([rm(configPath, { force: true }), rm(pidPath, { force: true })])
    },
  }
}
