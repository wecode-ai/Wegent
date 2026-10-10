import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

test('persists process output in delivery order before returning from data events', async () => {
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../e2e/desktop/process-output.mjs')
  ).href
  const { appendProcessOutput } = await import(/* @vite-ignore */ moduleUrl)
  const directory = await mkdtemp(join(tmpdir(), 'wework-process-output-'))
  const destination = join(directory, 'app.log')
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  try {
    appendProcessOutput(stdout, destination)
    appendProcessOutput(stderr, destination)
    const chunks = Array.from({ length: 256 }, (_, index) => `${index}: ${'x'.repeat(index)}\n`)
    for (const [index, chunk] of chunks.entries()) {
      const stream = index % 2 ? stderr : stdout
      stream.emit('data', Buffer.from(chunk))
    }
    expect(readFileSync(destination, 'utf8')).toBe(chunks.join(''))
    appendProcessOutput(null, destination)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
