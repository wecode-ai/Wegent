import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { finished } from 'node:stream/promises'

const DEFAULT_TAIL_CHARACTERS = 12_000

export async function runCommandToLog({
  args,
  command,
  cwd,
  env,
  logPath,
  tailCharacters = DEFAULT_TAIL_CHARACTERS,
}) {
  await mkdir(dirname(logPath), { recursive: true })
  const logStream = createWriteStream(logPath, { encoding: 'utf8' })
  const logCompletion = finished(logStream)
  let tail = ''

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const capture = chunk => {
    const text = chunk.toString()
    tail = `${tail}${text}`.slice(-tailCharacters)
    logStream.write(text)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)

  let result
  try {
    result = await new Promise((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        resolvePromise({
          code: code ?? 1,
          signal,
        })
      })
    })
  } finally {
    logStream.end()
    await logCompletion
  }

  return {
    ...result,
    tail,
  }
}
