import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertStartupGpuEvidence,
  createStartupGpuLaunch,
  parseStartupGpuEvidence,
  waitForStartupGpuExit,
} from '../e2e/desktop/modules/startup-gpu-evidence.mjs'

const shellTests = { skip: process.platform === 'win32', timeout: 5_000 }

function gpuLauncherArgument(launch) {
  assert.equal(launch.arguments[0], '--disable-gpu-sandbox')
  assert.equal(launch.arguments.length, 2)
  assert.match(launch.arguments[1], /^--gpu-launcher=/)
  return launch.arguments[1]
}

async function startGpu(t, mode = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'startup GPU "quoted" '))
  const scriptPath = join(root, "GPU launcher 'with spaces'.sh")
  await copyFile(
    fileURLToPath(new URL('../e2e/desktop/modules/startup-gpu-launcher.sh', import.meta.url)),
    scriptPath
  )
  const launch = createStartupGpuLaunch(join(root, 'case "with spaces".jsonl'), {
    platform: 'linux',
    getuid: () => 0,
    scriptPath,
  })
  // This bootstrap has no spaces inside its shell-code token. Chromium's
  // PrependWrapper keeps its quotes, unlike a shell command-line parser.
  const [program, ...prefix] = gpuLauncherArgument(launch)
    .slice('--gpu-launcher='.length)
    .split(' ')
  const source = `
    const fs = require('node:fs');
    if (fs.readFileSync(7, 'utf8') !== 'mojo-fd-seven') process.exit(91);
    process.stderr.write('gpu-stderr-marker\\n');
    process.stdout.write('gpu-ready:' + process.pid + '\\n');
    fs.readSync(3, Buffer.alloc(1), 0, 1, null);
    ${mode === 'trap' ? "process.kill(process.pid, 'SIGTRAP');" : `process.exit(${mode === 'nonzero' ? 17 : 0});`}
  `
  const child = spawn(program, [...prefix, process.execPath, '--eval', source], {
    env: { ...process.env, ...launch.env },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'pipe'],
  })
  const reader = createInterface({ input: child.stdout })
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  const pipeErrors = []
  for (const fd of [3, 7]) child.stdio[fd].on('error', error => pipeErrors.push(error))
  const closed = once(child, 'close')
  t.after(async () => {
    if (!child.stdio[3].writableEnded) child.stdio[3].end(Buffer.from([1]))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    reader.close()
    await rm(root, { recursive: true, force: true })
  })
  const ready = once(reader, 'line', { signal: AbortSignal.timeout(2_000) })
  child.stdio[7].end('mojo-fd-seven')
  const [line] = await ready
  assert.match(line, /^gpu-ready:\d+$/)
  return {
    launch,
    child,
    closed,
    pipeErrors,
    gpuPid: Number(line.slice('gpu-ready:'.length)),
    release: () => child.stdio[3].end(Buffer.from([1])),
    stderr: () => stderr,
  }
}

function applicationEvidence(proof) {
  const metric = { type: 'GPU', pid: proof.started.launcherPid, creationTime: Date.now() }
  return {
    profilePaths: { nativePid: process.pid },
    gpu: {
      required: true,
      nativeHostPid: process.pid,
      initial: metric,
      reopened: { ...metric },
      childProcessGone: [],
      quitObserved: true,
    },
  }
}

test(
  'records the real GPU wait0 and preserves inherited FD7 through paths with spaces',
  shellTests,
  async t => {
    const fixture = await startGpu(t)
    fixture.release()
    const proof = await waitForStartupGpuExit(fixture.launch, Date.now() + 2_000)
    await fixture.closed
    assert.equal(proof.started.launcherPid, fixture.child.pid)
    assert.equal(proof.started.parentPid, process.pid)
    assert.equal(proof.started.actualGpuPid, fixture.gpuPid)
    assert.equal(proof.exited.status, 0)
    assert.deepEqual(fixture.pipeErrors, [])
    assert.match(fixture.stderr(), /gpu-stderr-marker/)
    assertStartupGpuEvidence(applicationEvidence(proof), proof, fixture.stderr())
  }
)

test('the observer survives launcher SIGKILL and waits for the actual GPU', shellTests, async t => {
  const fixture = await startGpu(t)
  const exited = once(fixture.child, 'exit')
  assert.equal(fixture.child.kill('SIGKILL'), true)
  assert.deepEqual(await exited, [null, 'SIGKILL'])
  fixture.release()
  const proof = await waitForStartupGpuExit(fixture.launch, Date.now() + 2_000)
  assert.equal(proof.started.actualGpuPid, fixture.gpuPid)
  assert.equal(proof.exited.status, 0)
  await fixture.closed
})

for (const mode of ['nonzero', 'trap']) {
  test(
    `rejects an actual GPU ${mode === 'trap' ? 'SIGTRAP' : 'nonzero exit'}`,
    shellTests,
    async t => {
      const fixture = await startGpu(t, mode)
      fixture.release()
      await assert.rejects(
        waitForStartupGpuExit(fixture.launch, Date.now() + 2_000),
        /actual GPU exited with wait status/
      )
      const records = parseStartupGpuEvidence(
        await readFile(fixture.launch.evidencePath, 'utf8'),
        fixture.launch
      )
      assert.equal(records[0].actualGpuPid, fixture.gpuPid)
      if (mode === 'nonzero') assert.equal(records[1].status, 17)
      else assert.ok(records[1].status > 128)
      await fixture.closed
    }
  )
}

test('rejects a second GPU launch or evidence from another nonce', shellTests, async t => {
  const fixture = await startGpu(t)
  fixture.release()
  await waitForStartupGpuExit(fixture.launch, Date.now() + 2_000)
  const text = await readFile(fixture.launch.evidencePath, 'utf8')
  assert.throws(() => parseStartupGpuEvidence(text + text, fixture.launch), /restarted|duplicate/)
  assert.throws(
    () => parseStartupGpuEvidence(text, { ...fixture.launch, nonce: '0'.repeat(32) }),
    /nonce/
  )
})

test('rejects GPU restarts, child failures, and launch-failure output', shellTests, async t => {
  const fixture = await startGpu(t)
  fixture.release()
  const proof = await waitForStartupGpuExit(fixture.launch, Date.now() + 2_000)
  const result = applicationEvidence(proof)
  result.gpu.reopened.creationTime += 1
  assert.throws(() => assertStartupGpuEvidence(result, proof, ''), /restarted/)
  result.gpu.reopened.creationTime = result.gpu.initial.creationTime
  result.gpu.childProcessGone.push({ type: 'GPU', reason: 'crashed', exitCode: 133 })
  assert.throws(() => assertStartupGpuEvidence(result, proof, ''), /crashed/)
  result.gpu.childProcessGone = []
  for (const output of [
    'GPU process launch failed: error_code=1002',
    'GPU process exited unexpectedly',
    'fatalGpu',
  ]) {
    assert.throws(
      () => assertStartupGpuEvidence(result, proof, output),
      /GPU launch or process failure/
    )
  }
})

test('does not extend an exhausted host exit deadline', async () => {
  await assert.rejects(
    waitForStartupGpuExit({ evidencePath: 'not-read-after-deadline' }, Date.now() - 1),
    /host exit deadline/
  )
})

test('adds no launcher on other platforms or for a non-root Linux host', () => {
  for (const platform of ['win32', 'darwin']) {
    assert.equal(createStartupGpuLaunch('/unused', { platform, getuid: () => 0 }), null)
  }
  assert.equal(createStartupGpuLaunch('/unused', { platform: 'linux', getuid: () => 1000 }), null)
})
