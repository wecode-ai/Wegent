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
