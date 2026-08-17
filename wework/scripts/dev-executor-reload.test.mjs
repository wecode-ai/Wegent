import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const temporaryDirectories = []
const processes = []

afterEach(async () => {
  for (const process of processes.splice(0)) {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL')
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

function waitForOutput(stream, pattern, timeoutMs = 10_000) {
  return new Promise((resolveOutput, rejectOutput) => {
    let output = ''
    const timeout = setTimeout(() => {
      cleanup()
      rejectOutput(new Error(`Timed out waiting for ${pattern}; output=${JSON.stringify(output)}`))
    }, timeoutMs)
    const onData = chunk => {
      output += chunk
      const match = output.match(pattern)
      if (!match) return
      cleanup()
      resolveOutput(match)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      stream.off('data', onData)
    }
    stream.on('data', onData)
  })
}

describe('dev executor reload', () => {
  test('builds once initially and rebuilds after a source change', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-executor-reload-'))
    temporaryDirectories.push(directory)
    const executorDirectory = join(directory, 'executor')
    const sourceDirectory = join(executorDirectory, 'src')
    const targetDirectory = join(directory, 'target')
    const binDirectory = join(directory, 'bin')
    const buildLog = join(directory, 'build.log')
    const executorTemplate = join(directory, 'fake-executor.mjs')
    const cargo = join(binDirectory, 'cargo')
    await mkdir(sourceDirectory, { recursive: true })
    await mkdir(binDirectory, { recursive: true })
    await writeFile(join(executorDirectory, 'Cargo.toml'), '[package]\nname = "fake"\n')
    await writeFile(join(executorDirectory, 'Cargo.lock'), '')
    await writeFile(join(sourceDirectory, 'main.rs'), 'fn main() {}\n')
    await writeFile(
      executorTemplate,
      `#!/usr/bin/env node
process.stdout.write(\`ready \${process.pid}\\n\`)
process.stdin.on('data', chunk => {
  if (chunk.toString().trim() === 'crash') process.exit(1)
  process.stdout.write(\`echo:\${chunk}\`)
})
setInterval(() => {}, 1_000)
`
    )
    await chmod(executorTemplate, 0o755)
    await writeFile(
      cargo,
      `#!/usr/bin/env node
import { appendFileSync, chmodSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
appendFileSync(process.env.TEST_BUILD_LOG, 'build\\n')
const output = join(process.env.CARGO_TARGET_DIR, 'debug', 'wegent-executor')
mkdirSync(join(process.env.CARGO_TARGET_DIR, 'debug'), { recursive: true })
copyFileSync(process.env.TEST_EXECUTOR_TEMPLATE, output)
chmodSync(output, 0o755)
`
    )
    await chmod(cargo, 0o755)

    const watcher = spawn(
      process.execPath,
      [resolve('scripts/dev-executor-reload.mjs'), 'app-ipc-server'],
      {
        cwd: resolve('.'),
        env: {
          ...process.env,
          CARGO_TARGET_DIR: targetDirectory,
          PATH: `${binDirectory}:${process.env.PATH}`,
          TEST_BUILD_LOG: buildLog,
          TEST_EXECUTOR_TEMPLATE: executorTemplate,
          WEGENT_EXECUTOR_SOURCE_DIR: executorDirectory,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
    processes.push(watcher)

    const firstReady = await waitForOutput(watcher.stdout, /ready (\d+)\n/)
    await writeFile(join(sourceDirectory, 'main.rs'), 'fn main() { println!("changed"); }\n')
    const secondReady = await waitForOutput(watcher.stdout, /ready (\d+)\n/)
    expect(secondReady[1]).not.toBe(firstReady[1])
    expect((await readFile(buildLog, 'utf8')).trim().split('\n')).toHaveLength(2)

    watcher.stdin.write('ping\n')
    await expect(waitForOutput(watcher.stdout, /echo:ping\n/)).resolves.toBeTruthy()

    const thirdReadyOutput = waitForOutput(watcher.stdout, /ready (\d+)\n/)
    watcher.stdin.write('crash\n')
    const thirdReady = await thirdReadyOutput
    expect(thirdReady[1]).not.toBe(secondReady[1])
    expect((await readFile(buildLog, 'utf8')).trim().split('\n')).toHaveLength(2)

    watcher.kill('SIGTERM')
    await new Promise(resolveExit => watcher.once('exit', resolveExit))
    processes.splice(processes.indexOf(watcher), 1)
    await expect
      .poll(() => {
        try {
          process.kill(Number(thirdReady[1]), 0)
          return true
        } catch {
          return false
        }
      })
      .toBe(false)
  })
})
