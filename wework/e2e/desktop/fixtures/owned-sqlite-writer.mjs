import { fork } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { readNativeProcessIdentity } from '../process-identity.mjs'

const file = fileURLToPath(import.meta.url)
const startedAt =
  process.platform === 'win32' ? Date.now() : readNativeProcessIdentity(process.pid).startedAt
if (process.argv[2] === 'writer') {
  const home = process.argv[3]
  await mkdir(home, { recursive: true })
  const database = new DatabaseSync(join(home, 'state_5.sqlite'))
  database.exec('PRAGMA journal_mode=WAL; CREATE TABLE writes(value INTEGER)')
  const insert = database.prepare('INSERT INTO writes VALUES (?)')
  let count = 0
  const timer = setInterval(() => insert.run(count++), 10)
  process.on('SIGTERM', () => {
    if (process.argv[4] === 'true') return
    clearInterval(timer)
    database.close()
    process.exit(0)
  })
  process.send({ writerPid: process.pid, writerStartedAt: startedAt })
} else {
  const child = fork(file, ['writer', process.argv[3], process.argv[4]], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  child.once('message', detail => process.send({ ...detail, applicationStartedAt: startedAt }))
  if (process.argv[5] === 'true') process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}
