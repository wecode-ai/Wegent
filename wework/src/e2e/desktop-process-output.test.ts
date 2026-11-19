// @vitest-environment node

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

test('drains process output in delivery order before capture completes', async () => {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/process-output.mjs')
  ).href
  const { appendProcessOutput, flushProcessOutput } = await import(/* @vite-ignore */ moduleUrl)
  const directory = await mkdtemp(join(tmpdir(), 'wework-process-output-'))
  const destination = join(directory, 'app.log')
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const delivered: Buffer[] = []
  for (const stream of [stdout, stderr]) {
    stream.on('data', chunk => delivered.push(Buffer.from(chunk)))
  }
  try {
    appendProcessOutput(stdout, destination)
    appendProcessOutput(stderr, destination)
    const chunks = Array.from({ length: 256 }, (_, index) => `${index}: ${'x'.repeat(index)}\n`)
    for (const [index, chunk] of chunks.entries()) {
      const stream = index % 2 ? stderr : stdout
      stream.write(Buffer.from(chunk))
    }
    appendProcessOutput(null, destination)
    stdout.end()
    stderr.end()
    await flushProcessOutput()
    expect(delivered).toHaveLength(chunks.length)
    expect(await readFile(destination)).toEqual(Buffer.concat(delivered))
  } finally {
    stdout.end()
    stderr.end()
    await flushProcessOutput()
    await rm(directory, { recursive: true, force: true })
  }
})

test('fails an unclosed output source and retains bytes already delivered', async () => {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/process-output.mjs')
  ).href
  const { appendChildProcessOutput, flushProcessOutput, processOutputDiagnostics } = await import(
    /* @vite-ignore */ moduleUrl
  )
  const directory = await mkdtemp(join(tmpdir(), 'wework-unclosed-output-'))
  const destination = join(directory, 'app.log')
  const source = new PassThrough()
  const stderr = new PassThrough()
  const identity = { pid: 42, exitCode: 0, signalCode: null }
  const owner = { ...identity, stdout: source, stderr }
  try {
    appendChildProcessOutput(owner, destination)
    source.write('last received evidence\n')
    expect(processOutputDiagnostics()[0].sources.map(entry => entry.owner)).toEqual([
      identity,
      identity,
    ])
    stderr.end()
    const error = await flushProcessOutput({ sourceTimeoutMs: 0 }).catch(
      (failure: unknown) => failure
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0].code).toBe('ERR_PROCESS_OUTPUT_UNCLOSED')
    expect(source.destroyed).toBe(true)
    expect(await readFile(destination, 'utf8')).toBe('last received evidence\n')
    expect(processOutputDiagnostics()).toEqual([])
  } finally {
    source.destroy()
    stderr.destroy()
    await flushProcessOutput()
    await rm(directory, { recursive: true, force: true })
  }
})

test('finishes capture when an exited launcher leaves its output pipe open', async () => {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/process-output.mjs')
  ).href
  const { appendProcessOutput, closeExitedProcessOutput, flushProcessOutput } = await import(
    /* @vite-ignore */ moduleUrl
  )
  const directory = await mkdtemp(join(tmpdir(), 'wework-process-output-'))
  const destination = join(directory, 'app.log')
  const launcherOutput = new PassThrough()
  const liveOutput = new PassThrough()
  try {
    appendProcessOutput(launcherOutput, destination, { exitCode: 0, signalCode: null })
    appendProcessOutput(liveOutput, destination, { exitCode: null, signalCode: null })
    const finalLog = Buffer.alloc(128 * 1024, 'x')
    launcherOutput.write(finalLog)
    await closeExitedProcessOutput(destination)
    expect(launcherOutput.destroyed).toBe(true)
    expect(liveOutput.destroyed).toBe(false)
    liveOutput.end('live\n')
    await flushProcessOutput()
    expect(await readFile(destination)).toEqual(Buffer.concat([finalLog, Buffer.from('live\n')]))
  } finally {
    launcherOutput.end()
    liveOutput.end()
    await flushProcessOutput()
    await rm(directory, { recursive: true, force: true })
  }
})
