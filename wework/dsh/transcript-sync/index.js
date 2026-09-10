import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { SqliteSyncOutbox } from './outbox.js'

export const name = 'wework-transcript-sync'
export const inject = [
  'weworkDesktop',
  'weworkPluginRuntime',
  'weworkSecureStorage',
  'weworkTranscriptSource',
  'weworkTranscriptTarget',
]

const PACKAGE_NAME = '@wegent/dsh-transcript-sync'
const SNAPSHOT_INTERVAL = 10
const MAX_ENCRYPTED_SEGMENT_BYTES = 256 * 1024 * 1024 + 33
const PREFERENCES_UNIT = 'portable_preferences'
const PREFERENCES_FIELDS = [
  'appearanceMode',
  'language',
  'terminalContextInjectionEnabled',
  'contextCompactionThreshold',
  'supervisorPrinciples',
  'supervisorModelSelection',
  'supervisorIntervalSeconds',
  'taskCompletionNotificationsEnabled',
  'browserExternalLinkTarget',
  'browserLocalLinkTarget',
  'browserAskBeforeDownload',
  'friendlyTaskTitlesEnabled',
  'friendlyTaskTitleModel',
  'changeRequestStatusEnabled',
  'quickPhrases',
]

export async function apply(ctx) {
  const home = process.env.DSH_HOME ?? '.'
  const state = new SyncState(join(home, 'wework-transcript-sync.json'))
  await state.load()
  const outbox = new SqliteSyncOutbox(join(home, 'wework-transcript-sync-outbox.sqlite3'))
  const secure = ctx.weworkSecureStorage.scope('wework-transcript-sync')
  let clientId = await secure.get('client-id')
  if (typeof clientId !== 'string' || !clientId) {
    clientId = randomUUID()
    await secure.set('client-id', clientId)
  }
  const sync = new WeworkSync({
    apiBaseUrl: resolveApiBaseUrl(process.env),
    clientId,
    desktop: ctx.weworkDesktop,
    outbox,
    source: ctx.weworkTranscriptSource,
    state,
    target: ctx.weworkTranscriptTarget,
  })
  const service = sync.service()
  ctx.weworkPluginRuntime.register(ctx, {
    id: name,
    methods: {
      getSettings: () => ({ enabled: sync.enabled }),
      getStatus: () => service.status(),
      flush: async () => {
        await service.flush()
        return service.status()
      },
      setEnabled: ({ enabled }) => sync.setEnabled(enabled),
    },
  })
  const unsubscribe = ctx.weworkTranscriptSource.subscribe(turn => {
    void sync.enqueue(turn).catch(error => {
      console.error('[wework-transcript-sync] failed to persist transcript turn', error)
    })
  })
  ctx.effect(() => {
    const unprovide = ctx.reflect.provide('weworkTranscriptSync', service)
    return () => {
      unsubscribe()
      unprovide()
      sync.stop()
    }
  }, 'wework-transcript-sync: synchronization')
  void sync.start().catch(error => {
    console.error('[wework-transcript-sync] initial synchronization failed', error)
  })
}

export class WeworkSync {
  constructor({
    apiBaseUrl,
    clientId,
    desktop,
    outbox,
    source,
    state,
    target,
    pollIntervalMs = 5000,
  }) {
    this.apiBaseUrl = apiBaseUrl
    this.environmentApiBaseUrl = apiBaseUrl
    this.clientId = clientId
    this.desktop = desktop
    this.outbox = outbox
    this.source = source
    this.state = state
    this.target = target
    this.pollIntervalMs = pollIntervalMs
    this.enabled = state.value.enabled !== false
    this.active = false
    this.processing = null
    this.timer = null
    this.lastError = null
    this.lastAttemptAt = null
    this.lastSuccessAt = null
    this.failureCount = 0
  }

  async start() {
    this.active = true
    if (!this.enabled) return
    await this.flush()
  }

  stop() {
    this.active = false
    clearTimeout(this.timer)
    this.timer = null
  }

  service() {
    return Object.freeze({
      status: () => ({
        clientId: this.clientId,
        configured: Boolean(this.apiBaseUrl),
        enabled: this.enabled,
        pendingTurns: this.outbox.count(),
        transcripts: Object.keys(this.state.value.transcripts).length,
        syncing: Boolean(this.processing),
        lastError: this.lastError,
        lastAttemptAt: this.lastAttemptAt,
        lastSuccessAt: this.lastSuccessAt,
      }),
      list: () => structuredClone(Object.values(this.state.value.transcripts)),
      flush: () => this.flush(),
      setEnabled: enabled => this.setEnabled(enabled),
    })
  }

  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean')
      throw new Error('Transcript synchronization requires a boolean')
    if (this.enabled === enabled) return { enabled }
    this.enabled = enabled
    this.state.value.enabled = enabled
    await this.state.save()
    if (!enabled) {
      clearTimeout(this.timer)
      this.timer = null
      return { enabled }
    }
    this.lastError = null
    this.schedule(0)
    return { enabled }
  }

  async enqueue(turn) {
    const target = this.outbox.target(turn)
    const knownSequence = this.state.value.transcripts[target]?.currentSequence ?? 0
    this.outbox.enqueue(turn, knownSequence)
    if (this.enabled) this.schedule(0)
  }

  flush() {
    if (!this.enabled) return Promise.resolve()
    if (this.processing) return this.processing
    const operation = async () => {
      this.lastAttemptAt = new Date().toISOString()
      if (!this.enabled) return false
      if (!(await this.ensureApiBaseUrl())) return false
      const failures = []
      for (const phase of [
        () => this.flushPending(),
        () => this.pullTranscripts(),
        () => this.syncPreferences(),
      ]) {
        if (!this.enabled) break
        try {
          await phase()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Wework cloud synchronization phases failed')
      }
      return this.enabled
    }
    this.processing = operation()
      .then(completed => {
        if (!completed) return
        this.failureCount = 0
        this.lastError = null
        this.lastSuccessAt = new Date().toISOString()
      })
      .catch(error => {
        this.failureCount += 1
        this.lastError = error instanceof Error ? error.message : String(error)
        console.error('[wework-transcript-sync] synchronization failed', error)
        throw error
      })
      .finally(() => {
        this.processing = null
        this.schedule(this.retryDelay())
      })
    return this.processing
  }

  async flushPending() {
    const failures = []
    for (const sessionId of this.outbox.sessionIds()) {
      try {
        await this.flushPendingSession(sessionId)
      } catch (error) {
        if (error?.code === 'transcript_task_missing') {
          const discarded = this.outbox.discardSession(sessionId)
          console.warn('[wework-transcript-sync] discarded orphaned transcript session', {
            sessionId,
            discarded,
          })
          continue
        }
        if (error?.code === 'transcript_turn_missing') {
          failures.push(error)
          console.error('[wework-transcript-sync] transcript session is blocked', {
            sessionId,
            error,
          })
          continue
        }
        throw error
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Some transcript sessions could not be exported')
    }
  }

  async flushPendingSession(sessionId) {
    let pending
    while (this.enabled && (pending = this.outbox.firstForSession(sessionId))) {
      await this.flushPendingTurn(pending)
    }
  }

  async flushPendingTurn(turn) {
    const summarized = await this.source.summarize(turn)
    const lease = await this.acquireLease(turn)
    if (lease.currentSequence !== turn.baseSequence) {
      await this.reconcileOrForkPendingTurn(turn, lease)
      return
    }
    const snapshot = turn.cloudSequence === 1 || turn.cloudSequence % SNAPSHOT_INTERVAL === 0
    const encryption = await this.transcriptEncryption(turn.transcriptId)
    let segment
    let released = false
    try {
      segment = await this.source.read(turn, {
        baseSequence: turn.cloudSequence - 1,
        sequence: turn.cloudSequence,
        snapshot,
        encryptionKey: encryption.key,
        summary: summarized.payload,
      })
      await this.uploadPendingSegment(turn, segment, lease)
    } catch (error) {
      await this.releaseLease(turn, lease)
      released = true
      if (isSequenceConflict(error)) {
        this.forkPendingTurn(turn)
        return
      }
      throw error
    } finally {
      await removeSegmentFile(segment)
    }
    if (!released) await this.releaseLease(turn, lease)
    await this.acknowledgeNativeTurn({ ...turn, rolloutEnd: segment.rolloutEnd })
    this.outbox.acknowledge(turn)
  }

  acquireLease(turn) {
    return this.request(
      `/wework-transcripts/${encodeURIComponent(turn.transcriptId)}/lease`,
      'POST',
      {
        clientId: this.clientId,
        ttlSeconds: 300,
        title: turn.title || '',
        ...(turn.parentTranscriptId
          ? {
              parentTranscriptId: turn.parentTranscriptId,
              forkedAtSequence: turn.forkedAtSequence,
            }
          : {}),
      }
    )
  }

  async reconcileOrForkPendingTurn(turn, lease) {
    const delivered = await this.reconcilePendingSegment(turn)
    await this.releaseLease(turn, lease)
    if (!delivered) {
      this.forkPendingTurn(turn, Math.min(turn.baseSequence, lease.currentSequence))
      return
    }
    await this.acknowledgeNativeTurn(delivered)
    this.outbox.acknowledge(turn)
  }

  async acknowledgeNativeTurn(turn) {
    await this.target.acknowledge(turn)
    this.recordTranscriptCursor(turn.transcriptId, turn.cloudSequence, {
      parentTranscriptId: turn.parentTranscriptId ?? null,
      forkedAtSequence: turn.forkedAtSequence ?? null,
      title: turn.title || '',
    })
    await this.state.save()
  }

  async uploadPendingSegment(turn, segment, lease) {
    const descriptor = {
      clientId: this.clientId,
      baseSequence: turn.cloudSequence - 1,
      fencingToken: lease.fencingToken,
      title: turn.title || '',
      sequence: turn.cloudSequence,
      sha256: segment.sha256,
      sizeBytes: segment.sizeBytes,
      format: segment.format,
    }
    await this.request(
      `/wework-transcripts/${encodeURIComponent(turn.transcriptId)}/segments`,
      'POST',
      {
        ...descriptor,
        turnId: turn.turnId,
        summary: segmentSummary(turn, segment),
      },
      {
        file: {
          path: segment.path,
          name: 'segment.tgz.aes256gcm',
          contentType: 'application/octet-stream',
        },
      }
    )
  }

  async reconcilePendingSegment(turn) {
    const encodedTranscriptId = encodeURIComponent(turn.transcriptId)
    const [transcript, summaries] = await Promise.all([
      this.request(`/wework-transcripts/${encodedTranscriptId}`),
      this.request(
        `/wework-transcripts/${encodedTranscriptId}/turns?after=${turn.cloudSequence - 1}&limit=1`
      ),
    ])
    const existing = transcript.archives?.find(archive => archive.toSequence === turn.cloudSequence)
    const existingSummary = summaries.turns?.find(
      candidate => candidate.sequence === turn.cloudSequence
    )
    if (!existing || !existingSummary) return null
    const encryption = await this.transcriptEncryption(turn.transcriptId)
    const snapshot = turn.cloudSequence === 1 || turn.cloudSequence % SNAPSHOT_INTERVAL === 0
    const segment = await this.source.read(turn, {
      baseSequence: turn.cloudSequence - 1,
      sequence: turn.cloudSequence,
      snapshot,
      encryptionKey: encryption.key,
    })
    try {
      if (
        existing?.sha256 === segment.sha256 &&
        existing?.format === segment.format &&
        existing?.sizeBytes === segment.sizeBytes &&
        existingSummary?.turnId === turn.turnId &&
        stableJson(existingSummary.payload) === stableJson(segmentSummary(turn, segment))
      ) {
        return { ...turn, rolloutEnd: segment.rolloutEnd }
      }
      return null
    } finally {
      await unlink(segment.path).catch(error => {
        if (error?.code !== 'ENOENT') throw error
      })
    }
  }

  releaseLease(turn, lease) {
    return this.request(
      `/wework-transcripts/${encodeURIComponent(turn.transcriptId)}/lease/release`,
      'POST',
      {
        clientId: this.clientId,
        fencingToken: lease.fencingToken,
      }
    )
  }

  async transcriptEncryption(transcriptId) {
    const encryption = await this.request(
      `/wework-transcripts/${encodeURIComponent(transcriptId)}/encryption-key`
    )
    if (
      encryption?.algorithm !== 'aes-256-gcm' ||
      typeof encryption?.key !== 'string' ||
      !encryption.key
    ) {
      throw new Error('Backend returned an unsupported transcript encryption key')
    }
    return encryption
  }

  forkPendingTurn(turn, forkedAtSequence = turn.baseSequence) {
    const transcriptId = `fork-${createHash('sha256')
      .update(`${this.clientId}\u0000${turn.transcriptId}\u0000${turn.turnId}`)
      .digest('hex')}`
    this.outbox.fork(turn, transcriptId, forkedAtSequence)
  }

  async pullTranscripts() {
    if (!this.enabled) return
    const response = await this.request('/wework-transcripts?includeArchived=true')
    for (const transcript of response.items ?? []) {
      if (!this.enabled) return
      const current = this.state.value.transcripts[transcript.transcriptId]
      this.state.value.transcripts[transcript.transcriptId] = {
        ...transcript,
        downloadedThrough: current?.downloadedThrough ?? 0,
        downloadedArchiveIds: current?.downloadedArchiveIds ?? [],
      }
      if (this.outbox.hasPendingTranscript(transcript.transcriptId)) continue
      const targetStatus = await this.target.status(transcript)
      if (!targetStatus?.available) continue
      let after = targetStatus.importedThrough ?? 0
      if (after < transcript.currentSequence) {
        const archives = restorableSegments(transcript.archives ?? [], transcript.currentSequence)
        if (archives.length) {
          const encryption = await this.transcriptEncryption(transcript.transcriptId)
          const directory = await mkdtemp(join(tmpdir(), 'wework-transcript-'))
          try {
            const segments = []
            for (const archive of archives) {
              if (!this.enabled) return
              if (
                !Number.isInteger(archive.sizeBytes) ||
                archive.sizeBytes < 1 ||
                archive.sizeBytes > MAX_ENCRYPTED_SEGMENT_BYTES
              ) {
                throw new Error('Transcript archive has an invalid encrypted size')
              }
              const path = join(directory, `${archive.toSequence}.tgz.aes256gcm`)
              await this.request(
                `/wework-transcripts/${encodeURIComponent(transcript.transcriptId)}/archives/${archive.id}/download`,
                'GET',
                undefined,
                {
                  downloadPath: path,
                  downloadSizeBytes: archive.sizeBytes,
                }
              )
              segments.push({
                path,
                sha256: archive.sha256,
                sequence: archive.toSequence,
                format: archive.format,
              })
            }
            const imported = await this.target.restore(transcript, segments, {
              encryptionKey: encryption.key,
            })
            if (imported?.available) after = imported.importedThrough
          } finally {
            await rm(directory, { recursive: true, force: true })
          }
        }
      }
      this.state.value.transcripts[transcript.transcriptId] = {
        ...transcript,
        downloadedThrough: after,
        downloadedArchiveIds: (transcript.archives ?? [])
          .filter(archive => archive.toSequence <= after)
          .map(archive => archive.id),
      }
    }
    await this.state.save()
  }

  recordTranscriptCursor(transcriptId, downloadedThrough, metadata) {
    const current = this.state.value.transcripts[transcriptId] ?? {}
    this.state.value.transcripts[transcriptId] = {
      ...current,
      ...metadata,
      transcriptId,
      downloadedThrough: Math.max(current.downloadedThrough ?? 0, downloadedThrough),
      downloadedArchiveIds: current.downloadedArchiveIds ?? [],
    }
  }

  async syncPreferences() {
    if (!this.enabled) return
    const path = `/v1/dsh-plugin-storage/units/${PREFERENCES_UNIT}/load?package=${encodeURIComponent(PACKAGE_NAME)}`
    const descriptor = { version: 1, tables: [], has_global: true }
    const remote = await this.request(path, 'POST', descriptor)
    const local = portablePreferences(await this.desktop.preferences.get())
    const localHash = stableJson(local)
    const cloud = remote.global
    const baseline = this.state.value.preferencesHash
    const localChanged = baseline !== null && localHash !== baseline
    const cloudChanged = cloud?.hash && cloud.hash !== baseline
    if (cloud?.value && (!localChanged || cloudChanged)) {
      await this.desktop.preferences.update(cloud.value)
      this.state.value.preferencesHash = cloud.hash
      await this.state.save()
      return
    }
    if (!cloud || this.state.value.preferencesHash !== localHash) {
      await this.request(
        `/v1/dsh-plugin-storage/units/${PREFERENCES_UNIT}/global?package=${encodeURIComponent(PACKAGE_NAME)}`,
        'PUT',
        {
          ...descriptor,
          value: {
            hash: localHash,
            value: local,
            clientId: this.clientId,
            updatedAt: new Date().toISOString(),
          },
        }
      )
      this.state.value.preferencesHash = localHash
      await this.state.save()
    }
  }

  async request(path, method = 'GET', body, transfer = {}) {
    if (!this.enabled) throw new Error('Transcript synchronization is disabled')
    if (!this.apiBaseUrl) throw new Error('Cloud backend is not configured')
    const response = await this.desktop.weworkSync.request({
      apiBaseUrl: this.apiBaseUrl,
      path,
      method,
      ...(body === undefined ? {} : { body }),
      ...transfer,
    })
    if (response.status < 200 || response.status >= 300) {
      const detail = response.body?.detail
      const message =
        (typeof detail?.message === 'string' && detail.message) ||
        (typeof detail === 'string' && detail) ||
        `Cloud request failed (${response.status})`
      throw new SyncRequestError(message, response.status, detail?.code)
    }
    this.lastError = null
    return response.body
  }

  async ensureApiBaseUrl() {
    const preferences = await this.desktop.preferences?.get?.()
    this.apiBaseUrl =
      resolveCloudConnectionApiBaseUrl(preferences?.cloudConnection) ?? this.environmentApiBaseUrl
    if (!this.apiBaseUrl) {
      this.lastError = null
      return false
    }
    return true
  }

  retryDelay() {
    if (!this.failureCount) return this.pollIntervalMs
    return Math.min(this.pollIntervalMs * 2 ** (this.failureCount - 1), 60_000)
  }

  schedule(delayMs = this.pollIntervalMs) {
    if (!this.active || !this.enabled || this.timer || this.processing) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch(() => {})
    }, delayMs)
  }
}

class SyncRequestError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'SyncRequestError'
    this.status = status
    this.code = typeof code === 'string' ? code : null
  }
}

class SyncState {
  constructor(path) {
    this.path = path
    this.value = { version: 4, enabled: true, transcripts: {}, preferencesHash: null }
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'))
      if (value?.version === 2 || value?.version === 3 || value?.version === 4) {
        this.value = {
          version: 4,
          enabled: value.enabled !== false,
          transcripts: Object.fromEntries(
            Object.entries(value.transcripts ?? {}).map(([transcriptId, transcript]) => {
              const { turns: _obsoleteTurns, ...metadata } = transcript
              return [
                transcriptId,
                {
                  ...metadata,
                  downloadedThrough: value.version >= 3 ? (transcript.downloadedThrough ?? 0) : 0,
                  downloadedArchiveIds:
                    value.version >= 3 ? (transcript.downloadedArchiveIds ?? []) : [],
                },
              ]
            })
          ),
          preferencesHash: value.preferencesHash ?? null,
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
  }
}

export function resolveApiBaseUrl(environment) {
  const value = [
    environment.WEWORK_BACKEND_URL,
    environment.WEGENT_BACKEND_URL,
    environment.VITE_WEGENT_BACKEND_URL,
  ].find(candidate => typeof candidate === 'string' && candidate.trim())
  if (!value) return null
  const url = new URL(value.trim())
  const segments = url.pathname.split('/').filter(Boolean)
  const apiIndex = segments.indexOf('api')
  const prefix =
    apiIndex >= 0
      ? segments.slice(0, apiIndex).join('/')
      : url.pathname.split('/').filter(Boolean).join('/')
  url.pathname = `/${[prefix, 'api'].filter(Boolean).join('/')}`
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function resolveCloudConnectionApiBaseUrl(connection) {
  if (!connection || typeof connection !== 'object') return null
  return resolveApiBaseUrl({
    WEWORK_BACKEND_URL: connection.apiBaseUrl ?? connection.backendUrl,
  })
}

export function portablePreferences(preferences) {
  return Object.fromEntries(
    PREFERENCES_FIELDS.flatMap(field => {
      if (!Object.hasOwn(preferences, field)) return []
      if (field !== 'quickPhrases') return [[field, preferences[field]]]
      const phrases = Array.isArray(preferences.quickPhrases)
        ? preferences.quickPhrases.map(({ attachmentPaths: _paths, ...phrase }) => phrase)
        : []
      return [[field, phrases]]
    })
  )
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function segmentSummary(turn, segment) {
  return {
    ...segment.summary,
    taskId: turn.taskId,
  }
}

function isSequenceConflict(error) {
  return (
    error instanceof SyncRequestError &&
    ['sequence_conflict', 'segment_conflict', 'turn_conflict'].includes(error.code)
  )
}

async function removeSegmentFile(segment) {
  if (!segment?.path) return
  await unlink(segment.path).catch(error => {
    if (error?.code !== 'ENOENT') throw error
  })
}

function restorableSegments(archives, currentSequence) {
  const ordered = archives
    .filter(archive => archive.toSequence <= currentSequence)
    .sort((left, right) => left.toSequence - right.toSequence)
  const snapshotIndex = ordered.findLastIndex(archive => archive.format?.includes('snapshot'))
  if (snapshotIndex < 0) return []
  const selected = ordered.slice(snapshotIndex)
  let expected = selected[0].toSequence
  for (const archive of selected) {
    if (archive.toSequence !== expected) return []
    expected += 1
  }
  return selected.at(-1)?.toSequence === currentSequence ? selected : []
}
