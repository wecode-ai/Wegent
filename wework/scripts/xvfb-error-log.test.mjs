import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'

import { withXvfbErrorLog } from '../e2e/desktop/xvfb-error-log.mjs'

const fixture = `
const { mkdirSync, statSync, unlinkSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(1)
const errorFile = args[args.indexOf('-e') + 1]
if (!statSync(errorFile).isFile()) throw new Error('Xvfb error path must be a regular file')
if (args.includes('--unreadable')) {
  unlinkSync(errorFile)
  mkdirSync(errorFile)
} else if (!args.includes('--empty')) {
  writeFileSync(errorFile, 'Xvfb fixture diagnostic\\n')
}
process.stderr.write('primary checkpoint stderr\\n')
process.exitCode = Number(args.at(-1))
`

function runFixture(errorFile, code, options = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', fixture, '--', '-e', errorFile, ...options, `${code}`],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stderr = ''
    child.stdout.resume()
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolvePromise({ code: exitCode, signal, stderr }))
  })
}

it.each([0, 37])('forwards Xvfb diagnostics without changing exit code %i', async code => {
  let errorFile
  let diagnostics = ''
  const result = await withXvfbErrorLog(
    'fixture',
    path => {
      errorFile = path
      return runFixture(path, code)
    },
    text => {
      diagnostics += text
    }
  )

  expect(result).toEqual({ code, signal: null, stderr: 'primary checkpoint stderr\n' })
  expect(diagnostics).toContain('[desktop-e2e] fixture Xvfb diagnostics:')
  expect(diagnostics).toContain('Xvfb fixture diagnostic')
  expect(existsSync(dirname(errorFile))).toBe(false)
})

it('uses separate regular files for concurrent Xvfb processes and cleans both', async () => {
  const paths = []
  const results = await Promise.all(
    [0, 37].map(code =>
      withXvfbErrorLog(
        'parallel',
        path => {
          paths.push(path)
          return runFixture(path, code)
        },
        () => {}
      )
    )
  )

  expect(results.map(result => result.code)).toEqual([0, 37])
  expect(new Set(paths).size).toBe(2)
  expect(new Set(paths.map(dirname)).size).toBe(2)
  for (const path of paths) expect(existsSync(dirname(path))).toBe(false)
})

it('preserves a real spawn error and cleans its Xvfb file', async () => {
  let errorFile
  await expect(
    withXvfbErrorLog(
      'spawn-error',
      path => {
        errorFile = path
        return new Promise((resolvePromise, reject) => {
          const child = spawn(join(dirname(path), 'missing-executable'), [], { stdio: 'ignore' })
          child.once('error', reject)
          child.once('close', resolvePromise)
        })
      },
      () => {}
    )
  ).rejects.toMatchObject({ code: 'ENOENT' })
  expect(existsSync(dirname(errorFile))).toBe(false)
})

it('does not replace a failed checkpoint when reading diagnostics fails', async () => {
  let errorFile
  let diagnostics = ''
  const result = await withXvfbErrorLog(
    'read-error',
    path => {
      errorFile = path
      return runFixture(path, 37, ['--unreadable'])
    },
    text => {
      diagnostics += text
    }
  )

  expect(result.code).toBe(37)
  expect(result.stderr).toBe('primary checkpoint stderr\n')
  expect(diagnostics).toContain('could not read Xvfb diagnostics:')
  expect(existsSync(dirname(errorFile))).toBe(false)
})

it('preserves failures and cleans up when diagnostic output throws', async () => {
  let errorFile
  const result = await withXvfbErrorLog(
    'write-error',
    path => {
      errorFile = path
      return runFixture(path, 37)
    },
    () => {
      throw new Error('diagnostic sink unavailable')
    }
  )

  expect(result.code).toBe(37)
  expect(existsSync(dirname(errorFile))).toBe(false)
})

it('does not emit diagnostics for an empty Xvfb log', async () => {
  let errorFile
  let diagnostics = ''
  const result = await withXvfbErrorLog(
    'empty',
    path => {
      errorFile = path
      return runFixture(path, 0, ['--empty'])
    },
    text => {
      diagnostics += text
    }
  )

  expect(result.code).toBe(0)
  expect(diagnostics).toBe('')
  expect(existsSync(dirname(errorFile))).toBe(false)
})
