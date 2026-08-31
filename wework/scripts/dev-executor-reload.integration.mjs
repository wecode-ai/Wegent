import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const OUTPUT_TIMEOUT_MS = 15_000
const PROCESS_EXIT_TIMEOUT_MS = 10_000
const weworkDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function waitForOutput(stream, pattern, diagnostics = () => '') {
  return new Promise((resolveOutput, rejectOutput) => {
    let output = ''
    const timeout = setTimeout(() => {
      cleanup()
      rejectOutput(
        new Error(
          `Timed out waiting for ${pattern}; output=${JSON.stringify(output)}; diagnostics=${JSON.stringify(diagnostics())}`
        )
      )
    }, OUTPUT_TIMEOUT_MS)
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

async function stopProcess(process) {
  if (process.exitCode !== null || process.signalCode !== null) return
  const exited = new Promise(resolveExit => process.once('exit', resolveExit))
  process.kill('SIGTERM')
  await Promise.race([exited, delay(2_500)])
  if (process.exitCode === null && process.signalCode === null) {
    process.kill('SIGKILL')
    await exited
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await delay(50)
  }
  assert.fail(`Executor process ${pid} did not exit`)
}

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-executor-reload-'))
  const executorDirectory = join(directory, 'executor')
  const sourceDirectory = join(executorDirectory, 'src')
  const sourcePath = join(sourceDirectory, 'main.rs')
  const targetDirectory = join(directory, 'target')
  const binDirectory = join(directory, 'bin')
  const buildLog = join(directory, 'build.log')
  const executorTemplate = join(directory, 'fake-executor.mjs')
  const cargo = join(binDirectory, 'cargo')
  let watcher = null

  try {
    await mkdir(sourceDirectory, { recursive: true })
    await mkdir(binDirectory, { recursive: true })
    await writeFile(join(executorDirectory, 'Cargo.toml'), '[package]\nname = "fake"\n')
    await writeFile(join(executorDirectory, 'Cargo.lock'), '')
    await writeFile(sourcePath, 'fn main() {}\n')
    await writeFile(
      executorTemplate,
      `#!/usr/bin/env node
console.log(\`ready \${process.pid}\`)
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

    watcher = spawn(
      process.execPath,
      [join(weworkDirectory, 'scripts', 'dev-executor-reload.mjs'), 'app-ipc-server'],
      {
        cwd: weworkDirectory,
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
    let watcherStderr = ''
    watcher.stderr.on('data', chunk => {
      watcherStderr += chunk
    })

    const firstReady = await waitForOutput(watcher.stdout, /ready (\d+)\n/, () => watcherStderr)
    await writeFile(sourcePath, 'fn main() { println!("changed"); }\n')
    const secondReady = await waitForOutput(watcher.stdout, /ready (\d+)\n/)
    assert.notEqual(secondReady[1], firstReady[1])
    assert.equal((await readFile(buildLog, 'utf8')).trim().split('\n').length, 2)

    const now = new Date()
    await utimes(sourcePath, now, now)
    await delay(700)
    assert.equal((await readFile(buildLog, 'utf8')).trim().split('\n').length, 2)

    watcher.stdin.write('ping\n')
    await waitForOutput(watcher.stdout, /echo:ping\n/)

    const thirdReadyOutput = waitForOutput(watcher.stdout, /ready (\d+)\n/)
    watcher.stdin.write('crash\n')
    const thirdReady = await thirdReadyOutput
    assert.notEqual(thirdReady[1], secondReady[1])
    assert.equal((await readFile(buildLog, 'utf8')).trim().split('\n').length, 2)

    await stopProcess(watcher)
    await waitForProcessExit(Number(thirdReady[1]))
    watcher = null
  } finally {
    if (watcher) await stopProcess(watcher)
    await rm(directory, { recursive: true, force: true })
  }
}

await run()
process.stdout.write('dev executor reload integration test passed\n')
