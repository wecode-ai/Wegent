import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class SqliteSyncOutbox {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.database = new DatabaseSync(path)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS session_routes (
        session_id TEXT PRIMARY KEY,
        transcript_id TEXT NOT NULL,
        parent_transcript_id TEXT,
        forked_at_sequence INTEGER,
        acknowledged_sequence INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_turns (
        turn_id TEXT PRIMARY KEY,
        transcript_id TEXT NOT NULL,
        local_sequence INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        executor_turn_id TEXT,
        title TEXT NOT NULL,
        base_sequence INTEGER NOT NULL,
        cloud_sequence INTEGER NOT NULL,
        parent_transcript_id TEXT,
        forked_at_sequence INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (session_id, local_sequence)
      );
      CREATE INDEX IF NOT EXISTS pending_turns_delivery_order
        ON pending_turns (created_at, session_id, local_sequence);
    `)
    const pendingColumns = this.database
      .prepare('PRAGMA table_info(pending_turns)')
      .all()
      .map(column => column.name)
    if (!pendingColumns.includes('executor_turn_id')) {
      this.database.exec('ALTER TABLE pending_turns ADD COLUMN executor_turn_id TEXT')
    }
    this.selectRoute = this.database.prepare(`
      SELECT
        session_id,
        transcript_id,
        parent_transcript_id,
        forked_at_sequence,
        acknowledged_sequence
      FROM session_routes
      WHERE session_id = ?
    `)
    this.insertRoute = this.database.prepare(`
      INSERT INTO session_routes (
        session_id,
        transcript_id,
        acknowledged_sequence,
        updated_at
      ) VALUES (?, ?, ?, ?)
    `)
    this.advanceRoute = this.database.prepare(`
      UPDATE session_routes
      SET acknowledged_sequence = MAX(acknowledged_sequence, ?), updated_at = ?
      WHERE session_id = ?
    `)
    this.selectLastPending = this.database.prepare(`
      SELECT cloud_sequence
      FROM pending_turns
      WHERE session_id = ?
      ORDER BY local_sequence DESC
      LIMIT 1
    `)
    this.insert = this.database.prepare(`
      INSERT OR IGNORE INTO pending_turns (
        turn_id,
        transcript_id,
        local_sequence,
        session_id,
        task_id,
        executor_turn_id,
        title,
        base_sequence,
        cloud_sequence,
        parent_transcript_id,
        forked_at_sequence,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.selectFirst = this.database.prepare(`
      SELECT
        turn_id,
        transcript_id,
        local_sequence,
        session_id,
        task_id,
        executor_turn_id,
        title,
        base_sequence,
        cloud_sequence,
        parent_transcript_id,
        forked_at_sequence
      FROM pending_turns
      ORDER BY created_at, session_id, local_sequence
      LIMIT 1
    `)
    this.selectSessionPending = this.database.prepare(`
      SELECT turn_id
      FROM pending_turns
      WHERE session_id = ?
      ORDER BY local_sequence
    `)
    this.updateForkRoute = this.database.prepare(`
      UPDATE session_routes
      SET
        transcript_id = ?,
        parent_transcript_id = ?,
        forked_at_sequence = ?,
        acknowledged_sequence = 0,
        updated_at = ?
      WHERE session_id = ?
    `)
    this.updateForkTurn = this.database.prepare(`
      UPDATE pending_turns
      SET
        transcript_id = ?,
        base_sequence = ?,
        cloud_sequence = ?,
        parent_transcript_id = ?,
        forked_at_sequence = ?
      WHERE turn_id = ?
    `)
    this.remove = this.database.prepare('DELETE FROM pending_turns WHERE turn_id = ?')
    this.selectCount = this.database.prepare('SELECT COUNT(*) AS count FROM pending_turns')
    this.selectAll = this.database.prepare(`
      SELECT
        turn_id,
        transcript_id,
        local_sequence,
        session_id,
        task_id,
        executor_turn_id,
        title,
        base_sequence,
        cloud_sequence,
        parent_transcript_id,
        forked_at_sequence
      FROM pending_turns
      ORDER BY created_at, session_id, local_sequence
    `)
  }

  target(turn) {
    return rowToRoute(this.selectRoute.get(turn.sessionId))?.transcriptId ?? turn.transcriptId
  }

  enqueue(turn, knownSequence = 0) {
    let route = rowToRoute(this.selectRoute.get(turn.sessionId))
    if (!route) {
      this.insertRoute.run(turn.sessionId, turn.transcriptId, knownSequence, Date.now())
      route = rowToRoute(this.selectRoute.get(turn.sessionId))
    } else if (route.transcriptId === turn.transcriptId) {
      this.advanceRoute.run(knownSequence, Date.now(), turn.sessionId)
      route.acknowledgedSequence = Math.max(route.acknowledgedSequence, knownSequence)
    }
    const last = this.selectLastPending.get(turn.sessionId)
    const baseSequence = last ? last.cloud_sequence : route.acknowledgedSequence
    this.insert.run(
      turn.turnId,
      route.transcriptId,
      turn.sequence,
      turn.sessionId,
      turn.taskId,
      turn.executorTurnId ?? null,
      turn.title || '',
      baseSequence,
      baseSequence + 1,
      route.parentTranscriptId ?? null,
      route.forkedAtSequence ?? null,
      Date.now()
    )
  }

  first() {
    return rowToTurn(this.selectFirst.get())
  }

  fork(turn, transcriptId) {
    const pending = this.selectSessionPending.all(turn.sessionId)
    const start = pending.findIndex(item => item.turn_id === turn.turnId)
    if (start < 0) throw new Error(`Pending transcript turn is unavailable: ${turn.turnId}`)
    this.transaction(() => {
      this.updateForkRoute.run(
        transcriptId,
        turn.transcriptId,
        turn.baseSequence,
        Date.now(),
        turn.sessionId
      )
      for (const [index, item] of pending.slice(start).entries()) {
        this.updateForkTurn.run(
          transcriptId,
          index,
          index + 1,
          turn.transcriptId,
          turn.baseSequence,
          item.turn_id
        )
      }
    })
  }

  acknowledge(turn) {
    this.transaction(() => {
      this.advanceRoute.run(turn.cloudSequence, Date.now(), turn.sessionId)
      this.remove.run(turn.turnId)
    })
  }

  count() {
    return Number(this.selectCount.get().count)
  }

  list() {
    return this.selectAll.all().map(rowToTurn)
  }

  close() {
    this.database.close()
  }

  transaction(action) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      action()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

export class MemorySyncOutbox {
  constructor(turns = []) {
    this.turns = turns.map(turn => locator(turn, turn.baseSequence ?? 0))
    this.routes = new Map()
    for (const turn of this.turns) {
      this.routes.set(turn.sessionId, {
        transcriptId: turn.transcriptId,
        parentTranscriptId: turn.parentTranscriptId,
        forkedAtSequence: turn.forkedAtSequence,
        acknowledgedSequence: turn.baseSequence,
      })
    }
  }

  target(turn) {
    return this.routes.get(turn.sessionId)?.transcriptId ?? turn.transcriptId
  }

  enqueue(turn, knownSequence = 0) {
    if (this.turns.some(item => item.turnId === turn.turnId)) return
    let route = this.routes.get(turn.sessionId)
    if (!route) {
      route = {
        transcriptId: turn.transcriptId,
        acknowledgedSequence: knownSequence,
      }
      this.routes.set(turn.sessionId, route)
    } else if (route.transcriptId === turn.transcriptId) {
      route.acknowledgedSequence = Math.max(route.acknowledgedSequence, knownSequence)
    }
    const last = this.turns
      .filter(item => item.sessionId === turn.sessionId)
      .sort((left, right) => right.sequence - left.sequence)[0]
    const baseSequence = last?.cloudSequence ?? route.acknowledgedSequence
    this.turns.push({
      ...locator(turn, baseSequence),
      transcriptId: route.transcriptId,
      ...(route.parentTranscriptId
        ? {
            parentTranscriptId: route.parentTranscriptId,
            forkedAtSequence: route.forkedAtSequence,
          }
        : {}),
    })
  }

  first() {
    return this.turns[0] ? structuredClone(this.turns[0]) : null
  }

  fork(turn, transcriptId) {
    const sessionTurns = this.turns
      .filter(item => item.sessionId === turn.sessionId)
      .sort((left, right) => left.sequence - right.sequence)
    const start = sessionTurns.findIndex(item => item.turnId === turn.turnId)
    if (start < 0) throw new Error(`Pending transcript turn is unavailable: ${turn.turnId}`)
    this.routes.set(turn.sessionId, {
      transcriptId,
      parentTranscriptId: turn.transcriptId,
      forkedAtSequence: turn.baseSequence,
      acknowledgedSequence: 0,
    })
    for (const [index, item] of sessionTurns.slice(start).entries()) {
      Object.assign(item, {
        transcriptId,
        baseSequence: index,
        cloudSequence: index + 1,
        parentTranscriptId: turn.transcriptId,
        forkedAtSequence: turn.baseSequence,
      })
    }
  }

  acknowledge(turn) {
    const route = this.routes.get(turn.sessionId)
    if (route) route.acknowledgedSequence = Math.max(route.acknowledgedSequence, turn.cloudSequence)
    const index = this.turns.findIndex(item => item.turnId === turn.turnId)
    if (index >= 0) this.turns.splice(index, 1)
  }

  count() {
    return this.turns.length
  }

  list() {
    return structuredClone(this.turns)
  }

  close() {}
}

function rowToTurn(row) {
  if (!row) return null
  return {
    turnId: row.turn_id,
    transcriptId: row.transcript_id,
    sequence: row.local_sequence,
    sessionId: row.session_id,
    taskId: row.task_id,
    title: row.title,
    baseSequence: row.base_sequence,
    cloudSequence: row.cloud_sequence,
    ...(row.executor_turn_id ? { executorTurnId: row.executor_turn_id } : {}),
    ...(row.parent_transcript_id
      ? {
          parentTranscriptId: row.parent_transcript_id,
          forkedAtSequence: row.forked_at_sequence,
        }
      : {}),
  }
}

function rowToRoute(row) {
  if (!row) return null
  return {
    sessionId: row.session_id,
    transcriptId: row.transcript_id,
    parentTranscriptId: row.parent_transcript_id,
    forkedAtSequence: row.forked_at_sequence,
    acknowledgedSequence: row.acknowledged_sequence,
  }
}

function locator(turn, baseSequence) {
  return {
    turnId: turn.turnId,
    transcriptId: turn.transcriptId,
    sequence: turn.sequence,
    sessionId: turn.sessionId,
    taskId: turn.taskId,
    title: turn.title || '',
    baseSequence,
    cloudSequence: baseSequence + 1,
    ...(turn.executorTurnId ? { executorTurnId: turn.executorTurnId } : {}),
    ...(turn.parentTranscriptId
      ? {
          parentTranscriptId: turn.parentTranscriptId,
          forkedAtSequence: turn.forkedAtSequence,
        }
      : {}),
  }
}
