#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { logTurn, MAX_METADATA_BYTES } from '../logger.mjs'

try {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > MAX_METADATA_BYTES) throw new Error('Hook metadata exceeds 1 MiB')
    chunks.push(chunk)
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'))
  process.stdout.write(`${JSON.stringify(await logTurn(payload, config))}\n`)
} catch (error) {
  process.stderr.write(`turn-diff-logger: ${error.message}\n`)
  process.exitCode = 1
}
