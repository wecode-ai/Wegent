import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { runCommandToLog } from './command-log.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true }))
  )
})

async function temporaryLogPath() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-command-log-'))
  temporaryDirectories.push(directory)
  return join(directory, 'nested', 'command.log')
}

describe('runCommandToLog', () => {
  test('writes stdout and stderr to the log without forwarding them', async () => {
    const logPath = await temporaryLogPath()

    const result = await runCommandToLog({
      args: ['-e', "process.stdout.write('stdout\\n'); process.stderr.write('stderr\\n')"],
      command: process.execPath,
      logPath,
    })

    expect(result).toMatchObject({ code: 0, signal: null })
    expect(await readFile(logPath, 'utf8')).toContain('stdout\n')
    expect(await readFile(logPath, 'utf8')).toContain('stderr\n')
    expect(result.tail).toContain('stdout\n')
    expect(result.tail).toContain('stderr\n')
  })

  test('returns the exit code and only the configured output tail', async () => {
    const logPath = await temporaryLogPath()

    const result = await runCommandToLog({
      args: ['-e', "process.stdout.write('0123456789'); process.exitCode = 7"],
      command: process.execPath,
      logPath,
      tailCharacters: 4,
    })

    expect(result).toEqual({
      code: 7,
      signal: null,
      tail: '6789',
    })
    expect(await readFile(logPath, 'utf8')).toBe('0123456789')
  })

  test('closes the log when the command cannot be started', async () => {
    const logPath = await temporaryLogPath()

    await expect(
      runCommandToLog({
        args: [],
        command: join(tmpdir(), 'missing-wework-command'),
        logPath,
      })
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(logPath, 'utf8')).resolves.toBe('')
  })
})
