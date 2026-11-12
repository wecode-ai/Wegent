// @vitest-environment node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

const relay = fileURLToPath(
  new URL('../e2e/desktop/modules/codex-stdio-gate-process.mjs', import.meta.url)
)
const payload = `${JSON.stringify({ id: 1, result: { models: [{ slug: 'large-catalog', instructions: 'x'.repeat(2 * 1024 * 1024) }] } })}\n`
const digest = value => createHash('sha256').update(value).digest('hex')

test.each(['cli', 'app-server'])(
  'drains large %s output and preserves the child exit status',
  async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-stdio-gate-'))
    // Pass the payload through a file-independent script argument without exceeding ARG_MAX.
    const source = `const value = JSON.stringify({id:1,result:{models:[{slug:'large-catalog',instructions:'x'.repeat(2*1024*1024)}]}})+'\\n'; process.stdout.write(value, () => { process.exitCode = 7 })`
    const child = spawn(
      process.execPath,
      [relay, process.execPath, directory, '-e', source, '--', mode],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
    const closed = once(child, 'close')
    const chunks = []
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk
    })
    if (mode === 'cli') child.stdin.end()
    try {
      await pipeline(
        child.stdout,
        new Writable({
          highWaterMark: 1024,
          write(chunk, _encoding, done) {
            chunks.push(Buffer.from(chunk))
            setTimeout(done, 1)
          },
        })
      )
      const [code, signal] = await closed
      assert.equal(signal, null, stderr)
      assert.equal(code, 7, stderr)
      const output = Buffer.concat(chunks)
      assert.equal(output.length, Buffer.byteLength(payload), 'The relay truncated native output')
      assert.equal(digest(output), digest(payload), 'The relay changed native output bytes')
    } finally {
      child.kill()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
