import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cpuHardwareKey } from './wework-cpu-hardware-key.mjs'

const processors = (model, count = 4) => Array.from({ length: count }, () => ({ model }))

test('separates the captured AMD main baseline from the Intel PR runner', () => {
  const main = cpuHardwareKey(processors('AMD EPYC 9V45 96-Core Processor'))
  const pr = cpuHardwareKey(processors('INTEL(R) XEON(R) PLATINUM 8573C'))
  assert.match(main.fingerprint, /^[a-f0-9]{64}$/)
  assert.notEqual(main.fingerprint, pr.fingerprint)
})

test('keeps the fingerprint stable across model whitespace and CPU enumeration order', () => {
  const first = cpuHardwareKey([{ model: '  Model B  ' }, { model: 'Model A' }])
  const second = cpuHardwareKey([{ model: ' Model A ' }, { model: 'Model B' }])
  assert.deepEqual(first, second)
  assert.deepEqual(first.models, ['Model A', 'Model B'])
})

test('separates actual logical processor counts and mixed-model distributions', () => {
  const four = cpuHardwareKey(processors('Model A', 4))
  const eight = cpuHardwareKey(processors('Model A', 8))
  assert.equal(four.cpuCount, 4)
  assert.equal(eight.cpuCount, 8)
  assert.notEqual(four.fingerprint, eight.fingerprint)
  assert.notEqual(
    cpuHardwareKey([...processors('Model A', 3), { model: 'Model B' }]).fingerprint,
    cpuHardwareKey([{ model: 'Model A' }, ...processors('Model B', 3)]).fingerprint
  )
})

test('fails when hardware or any processor model is unavailable or invalid', () => {
  for (const hardware of [null, undefined, [], new Array(1), [{}], [{ model: 1 }]]) {
    assert.throws(() => cpuHardwareKey(hardware), /CPU/)
  }
  for (const model of ['', '   ', 'unknown', ' UNKNOWN ', 'Unknown processor', 'Model\nA']) {
    assert.throws(() => cpuHardwareKey(processors(model)), /CPU processor model/)
  }
})

test('the actual action rejects missing or empty CPU measurements with or without a baseline', () => {
  const action = readFileSync(
    new URL('../actions/compare-wework-cpu-benchmark/action.yml', import.meta.url),
    'utf8'
  ).replaceAll('\r\n', '\n')
  const availability = action.split(
    '    - name: Report current sample and baseline availability\n'
  )[1]
  const script = availability
    .match(/      run: \|\n((?:        .*\n)+)/)[1]
    .split('\n')
    .map(line => line.slice(8))
    .join('\n')
  const root = mkdtempSync(join(tmpdir(), 'wework-cpu-gate-'))
  try {
    for (const baseline of [false, true]) {
      for (const sample of ['missing', 'empty', 'valid']) {
        const directory = join(root, `${baseline}-${sample}`)
        const sampleDir = join(directory, '.ci-artifacts/wework-cpu-benchmarks')
        const baselineDir = join(directory, '.ci-cache/wework-cpu-benchmarks')
        mkdirSync(sampleDir, { recursive: true })
        mkdirSync(baselineDir, { recursive: true })
        if (baseline) writeFileSync(join(baselineDir, 'executor-stream-recovery.json'), '[]\n')
        if (sample !== 'missing') {
          writeFileSync(
            join(sampleDir, 'executor-stream-recovery.json'),
            sample === 'empty' ? '' : '[]\n'
          )
        }
        const output = join(directory, 'output')
        const summary = join(directory, 'summary')
        writeFileSync(output, '')
        writeFileSync(summary, '')
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
          cwd: directory,
          encoding: 'utf8',
          env: {
            ...process.env,
            CHECKPOINT: 'executor-stream-recovery',
            HARDWARE_FINGERPRINT: cpuHardwareKey(processors('Model A')).fingerprint,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
          },
        })
        assert.equal(result.status, sample === 'valid' ? 0 : 1, `${baseline}-${sample}`)
        assert.equal(readFileSync(output, 'utf8').includes('available=true'), sample === 'valid')
        if (sample !== 'valid') assert.match(result.stdout, /Missing required CPU sample/)
        if (!baseline) {
          assert.match(readFileSync(summary, 'utf8'), /Performance comparison was not performed/)
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
