import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { requestJson } from './harness-app-fixture.mjs'
import { TransportFaultProxy } from './transport-fault-proxy.mjs'
import { runChecked, repoDir, join } from './shared.mjs'

function multipartUpload(body, contentType) {
  const boundary = contentType.match(/boundary=([^;]+)/u)?.[1]
  assert.ok(boundary, 'Transcript upload must include a multipart boundary')
  const part = name => {
    const header = body.indexOf(Buffer.from(`name="${name}"`))
    assert.notEqual(header, -1, `Transcript upload must include ${name}`)
    const start = body.indexOf(Buffer.from('\r\n\r\n'), header) + 4
    const end = body.indexOf(Buffer.from(`\r\n--${boundary}`), start)
    assert.ok(start >= 4 && end > start, 'Transcript multipart field is malformed')
    return body.subarray(start, end)
  }
  return { metadata: JSON.parse(part('metadata').toString('utf8')), file: part('file') }
}

/** Observe real Backend state and lose one real acknowledgement after deleting its MinIO object. */
export class TranscriptBackendEvidence {
  constructor(cloud) {
    this.cloud = cloud
    this.transcripts = new Map()
    this.objects = new Map()
    this.archives = new Map()
    this.leases = new Map()
    this.segmentUploadCounts = new Map()
    this.requestLog = []
    this.firstCommitResponseDropped = false
    this.proxy = new TransportFaultProxy(cloud.backendUrl)
    this.proxy.rule = (entry, request) => {
      this.requestLog.push(`${entry.method} ${entry.path}`)
      const match = entry.path.match(/^\/api\/wework-transcripts\/([^/]+)\/segments$/u)
      if (entry.method !== 'POST' || !match) return null
      const transcriptId = decodeURIComponent(match[1])
      this.activeTranscriptId ??= transcriptId
      const chunks = []
      let size = 0
      request.on('data', chunk => {
        size += chunk.length
        if (size <= 257 * 1024 * 1024) chunks.push(chunk)
        else this.failure ??= new Error('Transcript upload exceeds the production segment budget')
      })
      request.once('end', () => {
        try {
          assert.ifError(this.failure)
          const { metadata, file } = multipartUpload(
            Buffer.concat(chunks),
            String(request.headers['content-type'] ?? '')
          )
          assert.equal(file.byteLength, metadata.sizeBytes)
          assert.equal(createHash('sha256').update(file).digest('hex'), metadata.sha256)
          const id = `${transcriptId}-${metadata.sequence}-${metadata.sha256}`
          this.segmentUploadCounts.set(id, (this.segmentUploadCounts.get(id) ?? 0) + 1)
        } catch (error) {
          this.failure ??= error
        }
      })
      if (!this.firstCommit) {
        this.firstCommit = entry
        return 'hold-response'
      }
      return null
    }
  }

  request(path, options) {
    return requestJson(this.cloud.backendUrl, this.cloud.authToken, path, options)
  }

  async start() {
    await this.proxy.start()
    return this
  }

  async refresh() {
    assert.ifError(this.failure)
    const list = await this.request('/api/wework-transcripts')
    this.leases.clear()
    for (const item of list.items) {
      await this.refreshTranscript(item.transcriptId)
    }
    if (this.firstCommit?.readHeldResponse?.() && !this.firstCommitResponseDropped) {
      assert.equal(this.firstCommit.status, 200, 'The real first segment must commit successfully')
      // The held response can arrive after this refresh's earlier metadata read.
      await this.refreshTranscript(this.activeTranscriptId)
      const archive = this.transcripts.get(this.activeTranscriptId)?.archives[0]
      assert.ok(archive, 'The real committed snapshot must exist before its response is lost')
      await this.deleteObject(archive.objectId)
      assert.equal(this.firstCommit.dropHeldResponse(), true)
      this.firstCommitResponseDropped = true
    }
  }

  async refreshTranscript(transcriptId) {
    const path = `/api/wework-transcripts/${encodeURIComponent(transcriptId)}`
    const detail = await this.request(path)
    const turns = await this.request(`${path}/turns?limit=500`)
    const transcript = this.transcripts.get(transcriptId) ?? {}
    Object.assign(transcript, detail, { turns: turns.turns })
    this.transcripts.set(transcriptId, transcript)
    if (detail.writerLeaseExpiresAt && Date.parse(detail.writerLeaseExpiresAt) > Date.now())
      this.leases.set(transcriptId, detail.writerClientId)
    for (const archive of detail.archives) {
      const id = `${transcriptId}-${archive.toSequence}-${archive.sha256}`
      archive.objectId = id
      this.archives.set(id, { transcriptId, ...archive })
      if (this.objects.has(id)) continue
      const response = await fetch(
        `${this.cloud.backendUrl}${path}/archives/${archive.id}/download`,
        {
          headers: { Authorization: `Bearer ${this.cloud.authToken}` },
        }
      )
      if (response.status === 404) continue
      assert.ok(response.ok, `Real transcript archive download failed: ${response.status}`)
      this.objects.set(id, Buffer.from(await response.arrayBuffer()))
    }
  }

  async deleteObject(id) {
    const archive = this.archives.get(id)
    assert.ok(archive, 'Only an observed test transcript object can be removed')
    const rows = await this.cloud.queryDatabase(
      'SELECT a.storage_key FROM wework_transcript_archives a JOIN wework_transcripts t ON t.id = a.transcript_db_id WHERE t.user_id = %s AND t.transcript_id = %s AND a.to_sequence = %s AND a.sha256 = %s',
      [1, archive.transcriptId, archive.toSequence, archive.sha256]
    )
    assert.equal(rows.length, 1)
    await runChecked(
      'uv',
      [
        'run',
        'python',
        '-c',
        'import os; from app.services.wework_transcript_storage import wework_transcript_storage as s; s.client.remove_object(s.bucket, os.environ["WEWORK_E2E_TRANSCRIPT_OBJECT_KEY"])',
      ],
      {
        cwd: join(repoDir, 'backend'),
        env: { ...this.cloud.backendEnv, WEWORK_E2E_TRANSCRIPT_OBJECT_KEY: rows[0].storage_key },
      }
    )
    this.objects.delete(id)
  }

  async stop() {
    await this.proxy.stop()
    assert.ifError(this.failure)
  }
}
