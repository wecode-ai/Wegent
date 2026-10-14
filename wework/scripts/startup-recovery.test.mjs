import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, test } from 'vitest'
import { compactDesktopE2EResult } from '../e2e/desktop/result-retention.mjs'
import {
  executeStartupRecoveryChild,
  startupRecoveryFailureDiagnostic,
  writeStartupRecoveryDiagnostic,
} from '../e2e/desktop/modules/startup-recovery.mjs'

async function fixture() {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-recovery-diagnostic-'))
  const root = join(resultDir, 'startup-recovery')
  await mkdir(root)
  onTestFinished(() => rm(resultDir, { recursive: true, force: true }))
  return { root, resultDir }
}

test('retains only fixed child failure fields and rethrows the exact process error', async () => {
  const paths = await fixture()
  const secret = 'https://private.invalid/session/private?token=secret'
  await writeFile(
    join(paths.root, 'failure-diagnostic.json'),
    JSON.stringify({
      phase: 'load-services',
      verificationMode: 'runtime',
      errorName: 'SyntaxError',
      errorCode: 'ERR_MODULE_NOT_FOUND',
      message: secret,
      stack: secret,
      url: secret,
    })
  )
  const error = Object.assign(new Error(secret), { code: 1, stderr: secret, stdout: secret })
  const options = { timeout: 60_000, maxBuffer: 1024 * 1024 }
  await assert.rejects(
    executeStartupRecoveryChild('electron', ['verify'], options, {
      ...paths,
      execute: async (executable, args, passedOptions) => {
        assert.equal(executable, 'electron')
        assert.deepEqual(args, ['verify'])
        assert.equal(passedOptions, options)
        throw error
      },
    }),
    actual => actual === error
  )
  const retained = await readFile(join(paths.resultDir, 'startup-reset-failure.json'), 'utf8')
  assert.equal(retained.includes(secret), false)
  assert.deepEqual(JSON.parse(retained), {
    phase: 'load-services',
    verificationMode: 'runtime',
    errorName: 'SyntaxError',
    errorCode: 'ERR_MODULE_NOT_FOUND',
    exitCode: 1,
    killed: false,
    signal: null,
  })
})

test('missing or invalid child evidence retains process status without changing failure', async () => {
  const paths = await fixture()
  const error = Object.assign(new Error('private path'), {
    code: 7,
    killed: true,
    signal: 'SIGTERM',
  })
  for (const content of [null, '{invalid']) {
    if (content !== null) await writeFile(join(paths.root, 'failure-diagnostic.json'), content)
    await assert.rejects(
      executeStartupRecoveryChild(
        'electron',
        [],
        {},
        {
          ...paths,
          execute: async () => {
            throw error
          },
        }
      ),
      actual => actual === error
    )
    const retained = JSON.parse(await readFile(join(paths.resultDir, 'startup-reset-failure.json')))
    assert.equal(retained.phase, 'unknown')
    assert.equal(retained.exitCode, 7)
    assert.equal(retained.killed, true)
    assert.equal(retained.signal, 'SIGTERM')
  }
})

test('diagnostic write failure preserves the original child error', async () => {
  const paths = await fixture()
  const error = new Error('original subprocess failure')
  await assert.rejects(
    executeStartupRecoveryChild(
      'electron',
      [],
      {},
      {
        ...paths,
        resultDir: join(paths.resultDir, 'missing'),
        execute: async () => {
          throw error
        },
      }
    ),
    actual => actual === error
  )
})

test('successful subprocess execution retains its result and creates no failure report', async () => {
  const paths = await fixture()
  const result = { stdout: 'success', stderr: '' }
  assert.equal(
    await executeStartupRecoveryChild(
      'electron',
      [],
      {},
      {
        ...paths,
        execute: async () => result,
      }
    ),
    result
  )
  await assert.rejects(readFile(join(paths.resultDir, 'startup-reset-failure.json')), {
    code: 'ENOENT',
  })
})

test('unknown child fields, codes and signal cannot leak messages or private paths', () => {
  const secret = '/private/token-secret'
  const value = startupRecoveryFailureDiagnostic(
    {
      phase: secret,
      verificationMode: secret,
      errorName: secret,
      errorCode: secret,
    },
    { code: secret, signal: secret, killed: secret }
  )
  assert.equal(JSON.stringify(value).includes(secret), false)
  assert.deepEqual(value, {
    phase: 'unknown',
    verificationMode: 'unknown',
    errorName: 'unknown',
    errorCode: 'unknown',
    exitCode: null,
    killed: false,
    signal: null,
  })
})

test('non-object child diagnostic shapes remain fixed unknown fields', () => {
  for (const value of [null, '/private/secret', 12, []]) {
    assert.equal(startupRecoveryFailureDiagnostic(value).phase, 'unknown')
  }
})

test('failure report survives the actual transient result compaction', async () => {
  const paths = await fixture()
  await writeFile(
    join(paths.root, 'failure-diagnostic.json'),
    JSON.stringify({
      phase: 'submit-recovery',
      verificationMode: 'user',
    })
  )
  const error = Object.assign(new Error('original'), { code: 1 })
  await assert.rejects(
    executeStartupRecoveryChild(
      'electron',
      [],
      {},
      {
        ...paths,
        execute: async () => {
          throw error
        },
      }
    ),
    actual => actual === error
  )
  await compactDesktopE2EResult(paths.resultDir)
  await assert.rejects(readFile(join(paths.root, 'failure-diagnostic.json')), { code: 'ENOENT' })
  const retained = JSON.parse(await readFile(join(paths.resultDir, 'startup-reset-failure.json')))
  assert.equal(retained.phase, 'submit-recovery')
  assert.equal(retained.verificationMode, 'user')
  assert.equal(retained.exitCode, 1)
})

test('child diagnostic filesystem failure leaves verification state and mandatory files intact', async () => {
  const paths = await fixture()
  const blockingFile = join(paths.root, 'blocking-file')
  await writeFile(blockingFile, 'required fixture')
  const value = { phase: 'load-services', verificationMode: 'runtime' }
  // A real ENOTDIR failure must leave the in-memory phase and mandatory fixture intact.
  const invalidTarget = join(blockingFile, 'diagnostic.json')
  assert.throws(() => writeFileSync(invalidTarget, '{}'))
  assert.doesNotThrow(() => writeStartupRecoveryDiagnostic(invalidTarget, value, writeFileSync))
  assert.deepEqual(value, { phase: 'load-services', verificationMode: 'runtime' })
  assert.equal(await readFile(blockingFile, 'utf8'), 'required fixture')
})
