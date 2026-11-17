#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { handleEvent } from '../logger.mjs'
import { processQueue } from '../worker.mjs'
import { MAX_METADATA_BYTES } from '../storage.mjs'

try {
  if (process.argv[2] === 'worker') {
    await processQueue(process.argv[3])
  } else {
    const chunks = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      bytes += chunk.length
      if (bytes > MAX_METADATA_BYTES) throw new Error('Hook input exceeds 1 MiB')
      chunks.push(chunk)
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'))
    process.stdout.write(JSON.stringify(await handleEvent(input, config)) + '\n')
  }
} catch (error) {
  process.stderr.write('turn-diff-logger: ' + error.message + '\n')
  process.exitCode = 1
}
