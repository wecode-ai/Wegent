import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { measureOutboxStartupPhase, SqliteSyncOutbox } from './outbox.js'

function captureStartupPhases(t, enabled) {
  const previous = process.env.WEWORK_E2E_CORE_CPU_PROFILE
  process.env.WEWORK_E2E_CORE_CPU_PROFILE = enabled
  t.after(() => {
    if (previous === undefined) delete process.env.WEWORK_E2E_CORE_CPU_PROFILE
    else process.env.WEWORK_E2E_CORE_CPU_PROFILE = previous
  })
  const messages = []
  t.mock.method(console, 'info', message => messages.push(message))
  return messages
}

test('outbox diagnostics preserve the disabled production path without logging', t => {
  const messages = captureStartupPhases(t, '0')
  const result = {}
  assert.equal(
    measureOutboxStartupPhase('database-open', () => result),
    result
  )
  const error = new Error('private-path-secret')
  assert.throws(
    () =>
      measureOutboxStartupPhase('pragmas', () => {
        throw error
      }),
    value => value === error
  )
  assert.deepEqual(messages, [])
})

test('measures real SQLite startup phases with only fixed safe metadata', async t => {
  const messages = captureStartupPhases(t, '1')
  const directory = await mkdtemp(join(tmpdir(), 'wework-private-outbox-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'private-auth-secret.sqlite3')
  const outbox = measureOutboxStartupPhase(
    'outbox-initialization',
    () => new SqliteSyncOutbox(path)
  )
  assert.equal(outbox.count(), 0)
  outbox.close()
  const entries = messages.map(message =>
    JSON.parse(message.replace('[startup][transcript-outbox] ', ''))
  )
  assert.deepEqual(
    entries.map(entry => `${entry.phase}:${entry.status}`),
    [
      'outbox-initialization:started',
      'database-open:started',
      'database-open:completed',
      'pragmas:started',
      'pragmas:completed',
      'schema-transaction:started',
      'schema-transaction:completed',
      'outbox-initialization:completed',
    ]
  )
  for (const [index, entry] of entries.entries()) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      entry.status === 'started'
        ? ['monotonicTimeMs', 'phase', 'status']
        : ['durationMs', 'monotonicTimeMs', 'phase', 'status']
    )
    assert.ok(Number.isFinite(entry.monotonicTimeMs))
    if (index) assert.ok(entry.monotonicTimeMs >= entries[index - 1].monotonicTimeMs)
    if (entry.status === 'completed') assert.ok(entry.durationMs >= 0)
  }
  assert.equal(messages.join('\n').includes(path), false)
  assert.equal(messages.join('\n').includes('CREATE TABLE'), false)
  assert.equal(messages.join('\n').includes('secret'), false)
})

test('reports failed startup phases without exposing or replacing the original error', t => {
  const messages = captureStartupPhases(t, '1')
  const error = new Error('private-path-secret SQL credential')
  assert.throws(
    () =>
      measureOutboxStartupPhase('schema-transaction', () => {
        throw error
      }),
    value => value === error
  )
  const entries = messages.map(message =>
    JSON.parse(message.replace('[startup][transcript-outbox] ', ''))
  )
  assert.deepEqual(
    entries.map(entry => entry.status),
    ['started', 'failed']
  )
  assert.ok(entries[1].durationMs >= 0)
  assert.equal(messages.join('\n').includes(error.message), false)
  assert.equal(
    measureOutboxStartupPhase('private-path-secret', () => 42),
    42
  )
  assert.equal(messages.length, 2)
})

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

test('persists a corrected branch point when the cloud parent is behind', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-sync-outbox-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'outbox.sqlite3')
  const outbox = new SqliteSyncOutbox(path)
  const turn = {
    transcriptId: 'shared-transcript',
    taskId: 'local-task',
    title: 'Shared transcript',
    sequence: 16,
    turnId: 'conflicting-turn',
    sessionId: 'local-session',
  }

  outbox.enqueue(turn, 15)
  outbox.fork(outbox.first(), 'fork-stable-id', 11)
  outbox.close()

  const reopened = new SqliteSyncOutbox(path)
  assert.deepEqual(reopened.first(), {
    ...turn,
    transcriptId: 'fork-stable-id',
    baseSequence: 0,
    cloudSequence: 1,
    parentTranscriptId: 'shared-transcript',
    forkedAtSequence: 11,
  })
  reopened.close()
})

test('permanently discards one turn while later turns keep syncing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-sync-outbox-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'outbox.sqlite3')
  const outbox = new SqliteSyncOutbox(path)

  outbox.enqueue({
    transcriptId: 'orphaned-transcript',
    taskId: 'orphaned-task',
    title: 'Orphaned',
    sequence: 1,
    turnId: 'orphaned-turn-1',
    sessionId: 'orphaned-session',
  })
  outbox.enqueue({
    transcriptId: 'orphaned-transcript',
    taskId: 'orphaned-task',
    title: 'Orphaned',
    sequence: 2,
    turnId: 'orphaned-turn-2',
    sessionId: 'orphaned-session',
  })
  outbox.enqueue({
    transcriptId: 'retained-transcript',
    taskId: 'retained-task',
    title: 'Retained',
    sequence: 1,
    turnId: 'retained-turn-1',
    sessionId: 'retained-session',
  })

  assert.deepEqual(outbox.sessionIds(), ['orphaned-session', 'retained-session'])
  const discardedTurn = outbox.firstForSession('orphaned-session')
  assert.equal(discardedTurn.turnId, 'orphaned-turn-1')
  assert.equal(outbox.hasPendingTranscript('orphaned-transcript'), true)
  assert.equal(outbox.hasPendingTranscript('missing-transcript'), false)
  const queryPlan = outbox.database
    .prepare('EXPLAIN QUERY PLAN SELECT 1 FROM pending_turns WHERE transcript_id = ? LIMIT 1')
    .get('orphaned-transcript')
  assert.match(queryPlan.detail, /pending_turns_transcript/u)
  assert.equal(outbox.discardTurn(discardedTurn), true)
  assert.equal(outbox.hasPendingTranscript('orphaned-transcript'), true)
  assert.equal(outbox.count(), 2)
  assert.deepEqual(outbox.firstForSession('orphaned-session'), {
    transcriptId: 'orphaned-transcript',
    taskId: 'orphaned-task',
    title: 'Orphaned',
    sequence: 2,
    turnId: 'orphaned-turn-2',
    sessionId: 'orphaned-session',
    baseSequence: 0,
    cloudSequence: 1,
  })

  assert.equal(
    outbox.enqueue({
      transcriptId: 'orphaned-transcript',
      taskId: 'orphaned-task',
      title: 'Replayed',
      sequence: 1,
      turnId: 'orphaned-turn-1',
      sessionId: 'orphaned-session',
    }),
    false
  )
  assert.equal(
    outbox.enqueue({
      transcriptId: 'orphaned-transcript',
      taskId: 'orphaned-task',
      title: 'Later',
      sequence: 3,
      turnId: 'orphaned-turn-3',
      sessionId: 'orphaned-session',
    }),
    true
  )
  assert.equal(outbox.count(), 3)
  outbox.close()

  const reopened = new SqliteSyncOutbox(path)
  assert.equal(
    reopened.enqueue({
      transcriptId: 'orphaned-transcript',
      taskId: 'orphaned-task',
      title: 'Replayed after restart',
      sequence: 1,
      turnId: 'orphaned-turn-1',
      sessionId: 'orphaned-session',
    }),
    false
  )
  reopened.enqueue({
    transcriptId: 'orphaned-transcript',
    taskId: 'orphaned-task',
    title: 'Later after restart',
    sequence: 4,
    turnId: 'orphaned-turn-4',
    sessionId: 'orphaned-session',
  })
  assert.equal(reopened.count(), 4)
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

test('rolls back partial schema initialization and closes the failed connection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-sync-outbox-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'outbox.sqlite3')
  const legacy = new DatabaseSync(path)
  legacy.exec(
    "CREATE TABLE pending_turns (turn_id TEXT PRIMARY KEY); INSERT INTO pending_turns VALUES ('existing-turn')"
  )
  legacy.close()

  assert.throws(() => new SqliteSyncOutbox(path), /no such column/)

  const reopened = new DatabaseSync(path)
  try {
    assert.equal(reopened.prepare('PRAGMA synchronous').get().synchronous, 2)
    assert.equal(reopened.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    assert.equal(
      reopened
        .prepare(
          "SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('session_routes', 'discarded_turns')"
        )
        .get().count,
      0
    )
    assert.equal(
      reopened.prepare('SELECT turn_id FROM pending_turns').get().turn_id,
      'existing-turn'
    )
    reopened.exec('BEGIN EXCLUSIVE; ROLLBACK')
  } finally {
    reopened.close()
  }
})
