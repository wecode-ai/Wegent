import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
  ctx.weworkPluginRuntime.register(ctx, {
    id: name,
    methods: {
      getSettings: () => ({ enabled: sync.enabled }),
      setEnabled: ({ enabled }) => sync.setEnabled(enabled),
    },
  })
  const unsubscribe = ctx.weworkTranscriptSource.subscribe(turn => {
    void sync.enqueue(turn).catch(error => {
      console.error('[wework-transcript-sync] failed to persist transcript turn', error)
    })
  })
  ctx.effect(() => {
    const unprovide = ctx.reflect.provide('weworkTranscriptSync', sync.service())
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
        lastError: this.lastError,
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
      if (!this.enabled) return
      if (!(await this.ensureApiBaseUrl())) return
      if (!this.enabled) return
      await this.flushPending()
      if (!this.enabled) return
      await this.pullTranscripts()
      if (!this.enabled) return
      await this.syncPreferences()
    }
    this.processing = operation()
      .then(result => {
        this.failureCount = 0
        return result
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
    let pending
    while (this.enabled && (pending = this.outbox.first())) {
      const turn = await this.source.read(pending)
      const lease = await this.request(
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
      if (lease.currentSequence < turn.baseSequence) {
        throw new Error('Cloud transcript sequence moved behind the local causal base')
      }
      if (lease.currentSequence !== turn.baseSequence) {
        const delivered = await this.reconcilePendingTurn(turn)
        await this.releaseLease(turn, lease)
        if (delivered) {
          await this.acknowledgeNativeTurn(turn)
          this.outbox.acknowledge(turn)
        } else {
          this.forkPendingTurn(turn)
        }
        continue
      }
      try {
        await this.appendPendingTurn(turn, lease)
      } catch (error) {
        if (!isSequenceConflict(error)) throw error
        const delivered = await this.reconcilePendingTurn(turn)
        await this.releaseLease(turn, lease)
        if (delivered) {
          await this.acknowledgeNativeTurn(turn)
          this.outbox.acknowledge(turn)
        } else {
          this.forkPendingTurn(turn)
        }
        continue
      }
      await this.releaseLease(turn, lease)
      await this.acknowledgeNativeTurn(turn)
      this.outbox.acknowledge(turn)
    }
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

  appendPendingTurn(turn, lease) {
    return this.request(
      `/wework-transcripts/${encodeURIComponent(turn.transcriptId)}/turns`,
      'POST',
      {
        clientId: this.clientId,
        baseSequence: turn.cloudSequence - 1,
        fencingToken: lease.fencingToken,
        title: turn.title || '',
        turns: [
          {
            turnId: turn.turnId,
            sequence: turn.cloudSequence,
            payload: pendingTurnPayload(turn),
          },
        ],
      }
    )
  }

  async reconcilePendingTurn(turn) {
    const response = await this.request(
      `/wework-transcripts/${encodeURIComponent(turn.transcriptId)}/turns?after=${turn.baseSequence}&limit=500`
    )
    const existing = response.turns?.find(candidate => candidate.turnId === turn.turnId)
    if (existing) {
      if (stableJson(existing.payload) !== stableJson(pendingTurnPayload(turn))) {
        throw new Error('Cloud transcript turn identity has conflicting content')
      }
      return true
    }
    return false
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

  forkPendingTurn(turn) {
    const transcriptId = `fork-${createHash('sha256')
      .update(`${this.clientId}\u0000${turn.transcriptId}\u0000${turn.turnId}`)
      .digest('hex')}`
    this.outbox.fork(turn, transcriptId)
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
      const targetStatus = await this.target.status(transcript)
      if (!targetStatus?.available) continue
      let after = targetStatus.importedThrough ?? 0
      const downloadedArchiveIds = new Set(
        (transcript.archives ?? [])
          .filter(archive => archive.toSequence <= after)
          .map(archive => archive.id)
      )
      for (const archive of transcript.archives ?? []) {
        if (!this.enabled) return
        if (downloadedArchiveIds.has(archive.id)) continue
        if (archive.toSequence <= after) {
          downloadedArchiveIds.add(archive.id)
          continue
        }
        let archiveAfter = archive.fromSequence - 1
        while (archiveAfter < archive.toSequence) {
          if (!this.enabled) return
          const page = await this.request(
            `/wework-transcripts/${encodeURIComponent(transcript.transcriptId)}/archives/${archive.id}/turns?after=${archiveAfter}&limit=1000`
          )
          if (!page.turns?.length) break
          const imported = await this.target.import(transcript, page.turns)
          if (!imported?.available) break
          archiveAfter = imported.importedThrough
          after = Math.max(after, archiveAfter)
          if (!page.hasMore) break
        }
        if (archiveAfter >= archive.toSequence) downloadedArchiveIds.add(archive.id)
      }
      while (after < transcript.currentSequence) {
        if (!this.enabled) return
        const page = await this.request(
          `/wework-transcripts/${encodeURIComponent(transcript.transcriptId)}/turns?after=${after}&limit=500`
        )
        if (!page.turns?.length) break
        const imported = await this.target.import(transcript, page.turns)
        if (!imported?.available) break
        after = imported.importedThrough
        if (!page.hasMore) break
      }
      this.state.value.transcripts[transcript.transcriptId] = {
        ...transcript,
        downloadedThrough: after,
        downloadedArchiveIds: [...downloadedArchiveIds],
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

  async request(path, method = 'GET', body) {
    if (!this.enabled) throw new Error('Transcript synchronization is disabled')
    if (!this.apiBaseUrl) throw new Error('Cloud backend is not configured')
    const response = await this.desktop.weworkSync.request({
      apiBaseUrl: this.apiBaseUrl,
      path,
      method,
      ...(body === undefined ? {} : { body }),
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
    if (this.apiBaseUrl) return true
    const preferences = await this.desktop.preferences.get()
    this.apiBaseUrl = resolveCloudConnectionApiBaseUrl(preferences.cloudConnection)
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

function pendingTurnPayload(turn) {
  return { ...turn.payload, taskId: turn.taskId }
}

function isSequenceConflict(error) {
  return (
    error instanceof SyncRequestError &&
    (error.code === 'sequence_conflict' || error.code === 'turn_conflict')
  )
}
