import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const launcherPath = fileURLToPath(new URL('./startup-gpu-launcher.sh', import.meta.url))
// Chromium 150 PrependWrapper preserves quote characters and splits on spaces.
// Keep the bootstrap one token; the shell expands the quoted path from env.
const launcherCommand = '/bin/sh -c exec${IFS}/bin/sh${IFS}"$WEWORK_E2E_GPU_LAUNCHER"${IFS}"$@" --'

export function createStartupGpuLaunch(
  evidencePath,
  { platform = process.platform, getuid = process.getuid, scriptPath = launcherPath } = {}
) {
  if (platform !== 'linux' || typeof getuid !== 'function' || getuid() !== 0) return null
  evidencePath = resolve(evidencePath)
  const nonce = randomBytes(16).toString('hex')
  return {
    evidencePath,
    nonce,
    argument: `--gpu-launcher=${launcherCommand}`,
    env: {
      WEWORK_E2E_GPU_LAUNCHER: scriptPath,
      WEWORK_E2E_GPU_EVIDENCE_PATH: evidencePath,
      WEWORK_E2E_GPU_EVIDENCE_PATH_JSON: JSON.stringify(evidencePath),
      WEWORK_E2E_GPU_EVIDENCE_NONCE: nonce,
    },
  }
}

export function parseStartupGpuEvidence(text, { evidencePath, nonce }) {
  if (!text || !text.endsWith('\n')) return null
  const records = text
    .slice(0, -1)
    .split('\n')
    .map(line => JSON.parse(line))
  assert.ok(records.length <= 2, 'The startup GPU restarted or emitted duplicate evidence')
  const identityKeys = ['launcherPid', 'parentPid', 'observerPid', 'actualGpuPid']
  for (const [index, record] of records.entries()) {
    assert.equal(record.event, index === 0 ? 'started' : 'exited', 'GPU evidence is out of order')
    assert.equal(record.casePath, evidencePath, 'GPU evidence belongs to another case')
    assert.equal(record.nonce, nonce, 'GPU evidence nonce does not match this launch')
    for (const key of identityKeys) {
      assert.ok(Number.isSafeInteger(record[key]) && record[key] > 0, `Invalid GPU ${key}`)
    }
    assert.equal(new Set(identityKeys.map(key => record[key])).size, identityKeys.length)
    if (index === 1) {
      for (const key of identityKeys) assert.equal(record[key], records[0][key])
      assert.ok(Number.isInteger(record.status) && record.status >= 0 && record.status <= 255)
    }
  }
  return records
}

export async function waitForStartupGpuExit(launch, deadline) {
  while (Date.now() < deadline) {
    let text = ''
    try {
      text = await readFile(launch.evidencePath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const records = parseStartupGpuEvidence(text, launch)
    if (Date.now() >= deadline) break
    if (records?.length === 2) {
      assert.equal(
        records[1].status,
        0,
        `The actual GPU exited with wait status ${records[1].status}`
      )
      return { started: records[0], exited: records[1] }
    }
    await setTimeout(Math.min(25, Math.max(0, deadline - Date.now())))
  }
  throw new Error('The actual GPU did not provide terminal evidence within the host exit deadline')
}

export function assertStartupGpuEvidence(result, proof, output) {
  assert.doesNotMatch(
    output,
    /GPU process launch fail(?:ed|ure)|error_code\s*[=:]?\s*1002\b|GPU process exited unexpectedly|unexpected GPU exit|fatalGpu/i,
    'The recovery probe reported a GPU launch or process failure'
  )
  const gpu = result.gpu
  assert.equal(gpu?.required, true, 'Missing required external GPU evidence')
  assert.equal(gpu.quitObserved, true, 'GPU observations did not reach app quit')
  assert.equal(gpu.nativeHostPid, result.profilePaths?.nativePid)
  assert.equal(
    proof.started.parentPid,
    gpu.nativeHostPid,
    'The GPU launcher is not owned by this host'
  )
  for (const metric of [gpu.initial, gpu.reopened]) {
    assert.equal(metric?.type, 'GPU')
    assert.equal(
      metric.pid,
      proof.started.launcherPid,
      'GPU metrics do not identify the Chrome-owned launcher'
    )
    assert.notEqual(metric.pid, gpu.nativeHostPid, 'The GPU still runs inside the native host')
    assert.ok(Number.isFinite(metric.creationTime) && metric.creationTime > 0)
  }
  assert.deepEqual(gpu.reopened, gpu.initial, 'The GPU restarted while recovery reopened')
  assert.equal(proof.exited.status, 0, 'The actual GPU did not exit normally')
  assert.ok(Array.isArray(gpu.childProcessGone), 'Missing GPU child-process-gone observations')
  for (const event of gpu.childProcessGone) {
    assert.equal(event.type, 'GPU')
    assert.equal(event.reason, 'clean-exit', `GPU child exited with reason ${event.reason}`)
    assert.equal(event.exitCode, 0, 'GPU child-process-gone reported a nonzero exit')
  }
}
