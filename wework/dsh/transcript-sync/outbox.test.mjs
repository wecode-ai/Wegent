import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SqliteSyncOutbox } from './outbox.js'

test('stores only durable turn locators across a month of intensive offline use', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-sync-outbox-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'outbox.sqlite3')
  const outbox = new SqliteSyncOutbox(path)
  const turnsPerDay = 500
  const offlineDays = 31
  const total = turnsPerDay * offlineDays
  const bodyMarker = '正文不能进入outbox'.repeat(1000)

  for (let sequence = 1; sequence <= total; sequence += 1) {
    outbox.enqueue({
      transcriptId: 'month-offline-transcript',
      taskId: 'month-offline-task',
      title: 'Month offline',
      sequence,
      turnId: `month-offline-turn-${sequence}`,
      sessionId: 'month-offline-session',
      payload: {
        assistantMessage: bodyMarker,
        reasoning: bodyMarker,
      },
    })
  }

  assert.equal(outbox.count(), total)
  assert.equal(Object.hasOwn(outbox.first(), 'payload'), false)
  outbox.close()

  const databaseBytes = (await stat(path)).size
  assert.ok(databaseBytes < 16 * 1024 * 1024, `Outbox grew to ${databaseBytes} bytes`)
  assert.equal((await readFile(path)).includes(Buffer.from(bodyMarker)), false)

  const reopened = new SqliteSyncOutbox(path)
  assert.equal(reopened.count(), total)
  assert.deepEqual(reopened.first(), {
    transcriptId: 'month-offline-transcript',
    taskId: 'month-offline-task',
    title: 'Month offline',
    sequence: 1,
    turnId: 'month-offline-turn-1',
    sessionId: 'month-offline-session',
    baseSequence: 0,
    cloudSequence: 1,
  })
  reopened.close()
})

test('persists acknowledgements and advances the next local causal base', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-sync-outbox-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'outbox.sqlite3')
  const turn = {
    transcriptId: 'shared-transcript',
    taskId: 'local-task',
    title: 'Shared transcript',
    sequence: 7,
    turnId: 'stable-turn-id',
    sessionId: 'local-session',
  }
  const outbox = new SqliteSyncOutbox(path)

  outbox.enqueue(turn, 11)
  outbox.close()

  const reopened = new SqliteSyncOutbox(path)
  assert.equal(reopened.first().cloudSequence, 12)
  reopened.acknowledge(reopened.first())
  assert.equal(reopened.count(), 0)
  reopened.enqueue({ ...turn, sequence: 8, turnId: 'next-turn-id' })
  assert.equal(reopened.first().baseSequence, 12)
  assert.equal(reopened.first().cloudSequence, 13)
  reopened.close()
})

test('persists an automatic branch route for later turns across restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-sync-outbox-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'outbox.sqlite3')
  const turn = {
    transcriptId: 'shared-transcript',
    taskId: 'local-task',
    title: 'Shared transcript',
    sequence: 7,
    turnId: 'conflicting-turn',
    sessionId: 'local-session',
  }
  const outbox = new SqliteSyncOutbox(path)

  outbox.enqueue(turn, 4)
  outbox.fork(outbox.first(), 'fork-stable-id')
  outbox.close()

  const reopened = new SqliteSyncOutbox(path)
  assert.deepEqual(reopened.first(), {
    ...turn,
    transcriptId: 'fork-stable-id',
    baseSequence: 0,
    cloudSequence: 1,
    parentTranscriptId: 'shared-transcript',
    forkedAtSequence: 4,
  })
  reopened.acknowledge(reopened.first())
  reopened.enqueue({ ...turn, sequence: 8, turnId: 'next-turn' }, 99)
  assert.deepEqual(reopened.first(), {
    ...turn,
    transcriptId: 'fork-stable-id',
    sequence: 8,
    turnId: 'next-turn',
    baseSequence: 1,
    cloudSequence: 2,
    parentTranscriptId: 'shared-transcript',
    forkedAtSequence: 4,
  })
  reopened.close()
})

test('upgrades an existing locator outbox without copying transcript bodies', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-sync-outbox-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'outbox.sqlite3')
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE session_routes (
      session_id TEXT PRIMARY KEY,
      transcript_id TEXT NOT NULL,
      parent_transcript_id TEXT,
      forked_at_sequence INTEGER,
      acknowledged_sequence INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE pending_turns (
      turn_id TEXT PRIMARY KEY,
      transcript_id TEXT NOT NULL,
      local_sequence INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      base_sequence INTEGER NOT NULL,
      cloud_sequence INTEGER NOT NULL,
      parent_transcript_id TEXT,
      forked_at_sequence INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (session_id, local_sequence)
    );
  `)
  legacy.close()

  const outbox = new SqliteSyncOutbox(path)
  outbox.enqueue({
    transcriptId: 'transcript-1',
    taskId: 'task-1',
    title: 'Task',
    sequence: 1,
    turnId: 'turn-1',
    sessionId: 'session-1',
    executorTurnId: 'executor-turn-1',
  })

  assert.equal(outbox.first().executorTurnId, 'executor-turn-1')
  outbox.close()
})
