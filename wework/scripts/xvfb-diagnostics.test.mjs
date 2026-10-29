import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { stat, writeFile } from 'node:fs/promises'
import { test } from 'vitest'

import { withXvfbDiagnostics } from '../e2e/desktop/xvfb-diagnostics.mjs'

test('captures file diagnostics with piped stdio while preserving the launcher failure', async () => {
  let logPath
  const reports = []
  const result = await withXvfbDiagnostics(
    async path => {
      logPath = path
      const child = spawn(
        process.execPath,
        [
          '-e',
          String.raw`require('node:fs').appendFileSync(process.argv[1], 'Fatal server error: fixture\n')
process.stderr.write('launcher stderr\n')
process.exit(37)`,
          path,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let stderrTail = ''
      child.stderr.on('data', chunk => (stderrTail += chunk.toString()))
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      assert.equal((await stat(path)).isFile(), true)
      return { code, stderrTail }
    },
    'fixture',
    message => reports.push(message)
  )
  assert.equal(result.code, 37)
  assert.match(result.stderrTail, /Fatal server error: fixture/)
  assert.match(result.stderrTail, /launcher stderr\n$/)
  assert.match(reports.join(''), /fixture Xvfb diagnostics/)
  await assert.rejects(stat(logPath), { code: 'ENOENT' })
})

test('keeps a successful result and removes its temporary diagnostics', async () => {
  let logPath
  const expected = { code: 0, stderrTail: '' }
  const reports = []
  const result = await withXvfbDiagnostics(
    async path => {
      logPath = path
      await writeFile(path, 'nonfatal Xvfb warning')
      return expected
    },
    'success',
    message => reports.push(message)
  )
  assert.equal(result, expected)
  assert.deepEqual(reports, [])
  await assert.rejects(stat(logPath), { code: 'ENOENT' })
})

test('a missing diagnostic file cannot mask an earlier launcher error', async () => {
  const expected = { code: 2, stderrTail: 'early launcher failure' }
  const result = await withXvfbDiagnostics(
    async () => expected,
    'missing',
    () => {}
  )
  assert.equal(result, expected)
})

test('preserves a thrown launch error and cleans up diagnostics', async () => {
  let logPath
  const expected = new Error('launch failed')
  await assert.rejects(
    withXvfbDiagnostics(async path => {
      logPath = path
      await writeFile(path, 'startup output')
      throw expected
    }, 'throw'),
    error => error === expected
  )
  await assert.rejects(stat(logPath), { code: 'ENOENT' })
})
