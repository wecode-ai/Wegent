import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, test } from 'vitest'

import { localArtifactGenerationScript } from '../e2e/desktop/scenarios/local-artifact-declaration.scenario.mjs'

const require = createRequire(import.meta.url)
const directories = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function executeFixture(declare) {
  const root = mkdtempSync(join(tmpdir(), 'wework-artifact-frame-'))
  directories.push(root)
  let stdout = ''
  runInNewContext(localArtifactGenerationScript(), {
    Buffer,
    require: name =>
      name === 'child_process'
        ? { execFileSync: (...args) => declare(root, ...args) }
        : require(name),
    process: {
      env: { WEGENT_TASK_WORKSPACE: root, WEGENT_EXECUTOR_BINARY: 'fixture-executor' },
      stdout: { write: data => (stdout += data) },
    },
  })
  return stdout
}

test.each(['\n', '\r\n'])(
  'frames unpadded declaration output before tool metadata with %j CLI lines',
  ending => {
    let artifact
    const stdout = executeFixture((root, binary, args, options) => {
      assert.equal(binary, 'fixture-executor')
      assert.deepEqual(Array.from(args).slice(0, 3), ['artifact', 'declare', '--path'])
      assert.equal(options.cwd, root)
      const name = args[3]
      assert.equal(
        readFileSync(join(root, name), 'utf8'),
        '# Local deliverable\nGenerated without a Backend Task.\n'
      )
      artifact = { name, padding: '' }
      while (Buffer.byteLength(JSON.stringify(artifact)) % 3 !== 0) artifact.padding += 'a'
      return `[WEGENT_ARTIFACT]${JSON.stringify(artifact)}${ending}`
    })
    const wrapped = JSON.stringify([
      { type: 'function_call_output', output: `${stdout}Process completed with exit code 0` },
    ])
    const encoded = wrapped.match(/LOCAL_ARTIFACT_RESULT:([A-Za-z0-9+/=]+)/)?.[1]
    assert.ok(encoded && !encoded.endsWith('='), 'Exercise the unpadded base64 boundary')
    assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), artifact)
    assert.ok(stdout.endsWith('\n'))
  }
)

test('a missing real declaration marker remains a failure', () => {
  assert.throws(() => executeFixture(() => 'No declaration result\n'), /No declaration result/)
})

test('a failed declaration command remains a failure', () => {
  const failure = new Error('Native declaration failed')
  assert.throws(
    () =>
      executeFixture(() => {
        throw failure
      }),
    error => error === failure
  )
})
