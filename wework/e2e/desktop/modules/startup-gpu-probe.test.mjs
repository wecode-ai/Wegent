import assert from 'node:assert/strict'
import { once } from 'node:events'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveElectronLaunchArguments } from './electron-launch-arguments.mjs'
import { inspectBeforeStart } from './inspect-before-start.mjs'
import { spawnStartupGdbProbe } from './startup-gdb-probe.mjs'
import {
  assertStartupGpuEvidence,
  createStartupGpuLaunch,
  waitForStartupGpuExit,
} from './startup-gpu-evidence.mjs'

const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
const fixtureDirectory = fileURLToPath(new URL('.', import.meta.url))
const nativeTests = { skip: process.platform !== 'linux', timeout: 60_000 }

async function withNativeGpuLaunch(disableGpuSandbox, verify) {
  const root = await mkdtemp(join(tmpdir(), 'startup native GPU "quoted" '))
  const resultPath = join(root, 'result.json')
  const scriptPath = join(root, "GPU launcher 'with spaces'.sh")
  // The unit runner is unprivileged. Exercise the root launch arguments without
  // claiming that this fixture certifies the container's root/recovery flow.
  const launch = createStartupGpuLaunch(join(root, 'GPU "quoted" evidence.jsonl'), {
    platform: 'linux',
    getuid: () => 0,
    scriptPath,
  })
  const argument = launch.arguments[1]
  let probe
  let timer
  try {
    await copyFile(fileURLToPath(new URL('./startup-gpu-launcher.sh', import.meta.url)), scriptPath)
    const environment = {
      ...process.env,
      ...launch.env,
      WEWORK_E2E_GPU_SMOKE_ROOT: root,
      WEWORK_E2E_GPU_SMOKE_RESULT: resultPath,
      WEWORK_E2E_GPU_LAUNCHER_VALUE: argument.slice('--gpu-launcher='.length),
    }
    delete environment.ELECTRON_RUN_AS_NODE
    const args = resolveElectronLaunchArguments({
      platform: 'linux',
      getuid: () => 0,
      isolatedXvfb: 'true',
      extraArguments: [
        '--inspect-brk=127.0.0.1:0',
        ...launch.arguments.filter(value => disableGpuSandbox || value !== '--disable-gpu-sandbox'),
      ],
    })
    probe = spawnStartupGdbProbe(
      require('electron'),
      [...args, 'startup-gpu-smoke.mjs'],
      {
        cwd: fixtureDirectory,
        env: environment,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
      // The expected trap needs the crashing thread and exit marker. Dumping
      // every thread can prevent GDB from reaching the marker before the deadline.
      { allThreads: disableGpuSandbox }
    )
    const ended = once(probe.child, 'exit')
    const closed = new Promise(resolve => probe.child.once('close', resolve))
    await inspectBeforeStart(
      probe.child,
      `(() => {
        const fs = process.getBuiltinModule('fs')
        const stat = fs.readFileSync('/proc/self/stat', 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/)
        console.info('[startup-gdb-inferior]', JSON.stringify({
          pid:process.pid,ppid:process.ppid,pgid:Number(fields[2])
        }))
      })()`
    )
    const deadline = Date.now() + 15_000
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native GPU launch contract timed out')), 15_000)
    })
    const [code, signal] = await Promise.race([ended, timeout])
    await verify({
      probe,
      launch,
      argument,
      resultPath,
      exit: { code, signal },
      deadline,
      closed,
      timeout,
    })
  } catch (error) {
    const snapshots = await Promise.allSettled([
      readFile(resultPath, 'utf8'),
      readFile(launch.evidencePath, 'utf8'),
    ])
    console.error(
      '[startup-gpu-contract] failure',
      JSON.stringify({
        disableGpuSandbox,
        snapshots: snapshots.map(value =>
          value.status === 'fulfilled' ? value.value : { error: value.reason.code }
        ),
      })
    )
    if (probe) await probe.captureFailure()
    throw error
  } finally {
    clearTimeout(timer)
    try {
      if (probe) await probe.cleanup()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}

async function readContractResult({ probe, argument, resultPath }, disableGpuSandbox) {
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  assert.equal(result.error, undefined, result.error)
  assert.equal(result.switches.gpuLauncher, argument.slice('--gpu-launcher='.length))
  assert.equal(result.switches.disableGpuSandbox, disableGpuSandbox)
  assert.equal(result.profilePaths.nativePid, probe.identity.pid)
  assert.equal(result.gpu.nativeHostPid, probe.identity.pid)
  return result
}

test(
  'the native exit gate rejects the known broken GPU launcher configuration',
  nativeTests,
  async () => {
    await withNativeGpuLaunch(false, async fixture => {
      const { probe, launch, exit, closed, timeout } = fixture
      // Finish reading the failed inferior's stack within the same exit deadline.
      await Promise.race([closed, timeout])
      assert.deepEqual(exit, { code: 255, signal: null }, probe.output)
      assert.deepEqual(probe.exit, exit)
      await assert.rejects(probe.assertNormalExit(exit))
      assert.match(probe.output, /Thread 1 "electron" received signal SIGTRAP,/)
      assert.match(probe.output, /GPU process exited unexpectedly: exit_code=133/)
      assert.match(
        probe.output,
        /FATAL:content\/browser\/gpu\/gpu_data_manager_impl_private\.cc:\d+\] GPU process isn't usable\. Goodbye\./
      )
      assert.match(probe.output, /^\[startup-gdb-host-exit\] unavailable\s*$/m)
      assert.doesNotMatch(probe.output, /^\[startup-gdb-host-exit\] 0\s*$/m)
      await assert.rejects(readFile(launch.evidencePath), { code: 'ENOENT' })
      const result = await readContractResult(fixture, false)
      assert.equal(result.gpu.quitObserved, false)
      assert.equal(result.gpu.initial, null)
      assert.equal(result.gpu.reopened, null)
      assert.ok(result.gpu.childProcessGone.length > 0)
      for (const event of result.gpu.childProcessGone) {
        assert.equal(event.type, 'GPU')
        assert.equal(event.reason, 'crashed')
        assert.equal(event.exitCode, 133)
      }
      console.log(
        '[startup-gpu-contract] rejected',
        JSON.stringify({ wrapperPid: probe.child.pid, exit, result, gpuEvidence: 'absent' })
      )
    })
  }
)

test(
  'the corrected GPU launcher preserves normal host and actual GPU exits',
  nativeTests,
  async () => {
    await withNativeGpuLaunch(true, async fixture => {
      const { probe, launch, exit, deadline } = fixture
      assert.deepEqual(exit, { code: 0, signal: null }, probe.output)
      const proof = await waitForStartupGpuExit(launch, deadline)
      await probe.assertNormalExit(exit)
      const result = await readContractResult(fixture, true)
      assertStartupGpuEvidence(result, proof, probe.output)
      assert.deepEqual(result.gpuParents.reopened, result.gpuParents.initial)
      assert.equal(result.gpuParents.initial.pid, result.profilePaths.nativePid)
      assert.equal(result.gpuParents.initial.isZygote, false)
      console.log(
        '[startup-gpu-contract] wrapped',
        JSON.stringify({
          wrapperPid: probe.child.pid,
          exit,
          ...proof,
          metrics: result.gpu,
          switches: result.switches,
        })
      )
    })
  }
)
