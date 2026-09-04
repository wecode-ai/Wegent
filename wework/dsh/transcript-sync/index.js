import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'wework-transcript-sync'
export const inject = ['weworkDesktop', 'weworkSecureStorage', 'weworkTranscriptSource']

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
  const state = new SyncState(join(process.env.DSH_HOME ?? '.', 'wework-transcript-sync.json'))
  await state.load()
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
    state,
  })
  const unsubscribe = ctx.weworkTranscriptSource.subscribe(turn => {
    void sync.enqueue(turn).catch(() => {})
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
  constructor({ apiBaseUrl, clientId, desktop, state, pollIntervalMs = 5000 }) {
    this.apiBaseUrl = apiBaseUrl
    this.clientId = clientId
    this.desktop = desktop
    this.state = state
    this.pollIntervalMs = pollIntervalMs
    this.active = false
    this.processing = Promise.resolve()
    this.timer = null
    this.lastError = null
  }

  async start() {
    this.active = true
    try {
      await this.flush()
    } finally {
      this.schedule()
    }
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
        pendingTurns: this.state.value.pending.length,
        transcripts: Object.keys(this.state.value.transcripts).length,
        lastError: this.lastError,
      }),
      list: () => structuredClone(Object.values(this.state.value.transcripts)),
      flush: () => this.flush(),
    })
  }

  enqueue(turn) {
    return this.serial(async () => {
      if (
        !this.state.value.pending.some(
          item => item.transcriptId === turn.transcriptId && item.sequence === turn.sequence
        )
      ) {
        this.state.value.pending.push(structuredClone(turn))
        await this.state.save()
      }
      if (await this.ensureApiBaseUrl()) await this.flushPending()
    })
  }

  flush() {
    return this.serial(async () => {
      if (!(await this.ensureApiBaseUrl())) return
      await this.flushPending()
      await this.pullTranscripts()
      await this.syncPreferences()
    })
  }

  serial(action) {
    const next = this.processing.then(action, action)
    this.processing = next.catch(error => {
      this.lastError = error instanceof Error ? error.message : String(error)
      console.error('[wework-transcript-sync] synchronization failed', error)
    })
    return next
  }

  async flushPending() {
    this.state.value.pending.sort(
      (left, right) =>
        left.transcriptId.localeCompare(right.transcriptId) || left.sequence - right.sequence
    )
    while (this.state.value.pending.length) {
      const turn = this.state.value.pending[0]
      const lease = await this.request(
        `/wework-transcripts/${encodeURIComponent(turn.transcriptId)}/lease`,
        'POST',
        {
          clientId: this.clientId,
          ttlSeconds: 300,
          title: turn.title || '',
        }
      )
      await this.request(
        `/wework-transcripts/${encodeURIComponent(turn.transcriptId)}/turns`,
        'POST',
        {
          clientId: this.clientId,
          baseSequence: turn.sequence - 1,
          fencingToken: lease.fencingToken,
          title: turn.title || '',
          turns: [
            {
              turnId: turn.turnId,
              sequence: turn.sequence,
              payload: { ...turn.payload, taskId: turn.taskId },
            },
          ],
        }
      )
      await this.request(
        `/wework-transcripts/${encodeURIComponent(turn.transcriptId)}/lease/release`,
        'POST',
        {
          clientId: this.clientId,
          fencingToken: lease.fencingToken,
        }
      )
      this.state.value.pending.shift()
      await this.state.save()
    }
  }

  async pullTranscripts() {
    const response = await this.request('/wework-transcripts?includeArchived=true')
    for (const transcript of response.items ?? []) {
      const current = this.state.value.transcripts[transcript.transcriptId]
      const downloadedArchiveIds = new Set(current?.downloadedArchiveIds ?? [])
      const turns = [...(current?.turns ?? [])]
      for (const archive of transcript.archives ?? []) {
        if (downloadedArchiveIds.has(archive.id)) continue
        let archiveAfter = archive.fromSequence - 1
        while (archiveAfter < archive.toSequence) {
          const page = await this.request(
            `/wework-transcripts/${encodeURIComponent(transcript.transcriptId)}/archives/${archive.id}/turns?after=${archiveAfter}&limit=1000`
          )
          if (!page.turns?.length) break
          turns.push(...page.turns)
          archiveAfter = page.turns.at(-1).sequence
          if (!page.hasMore) break
        }
        if (archiveAfter >= archive.toSequence) downloadedArchiveIds.add(archive.id)
      }
      let after = Math.max(current?.downloadedThrough ?? 0, transcript.archivedThroughSequence ?? 0)
      while (after < transcript.currentSequence) {
        const page = await this.request(
          `/wework-transcripts/${encodeURIComponent(transcript.transcriptId)}/turns?after=${after}&limit=500`
        )
        if (!page.turns?.length) break
        turns.push(...page.turns)
        after = page.turns.at(-1).sequence
        if (!page.hasMore) break
      }
      this.state.value.transcripts[transcript.transcriptId] = {
        ...transcript,
        downloadedThrough: after,
        downloadedArchiveIds: [...downloadedArchiveIds],
        turns: dedupeTurns(turns),
      }
    }
    await this.state.save()
  }

  async syncPreferences() {
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
      throw new Error(message)
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

  schedule() {
    if (!this.active) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
        .catch(() => {})
        .finally(() => this.schedule())
    }, this.pollIntervalMs)
  }
}

class SyncState {
  constructor(path) {
    this.path = path
    this.value = { version: 1, pending: [], transcripts: {}, preferencesHash: null }
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'))
      if (value?.version === 1) this.value = value
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

function dedupeTurns(turns) {
  return [...new Map(turns.map(turn => [turn.sequence, turn])).values()].sort(
    (left, right) => left.sequence - right.sequence
  )
}
