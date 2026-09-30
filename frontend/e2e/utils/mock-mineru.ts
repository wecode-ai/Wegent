/**
 * Mock MinerU document-parsing service for E2E testing.
 *
 * MinerU is the external document-parsing model the knowledge_doc_converter
 * worker calls to turn PDF/DOCX bytes into Markdown. Everything else in the
 * conversion chain is real: the product entry, the Celery worker, the backend
 * callback endpoints, the database state machine and the remote index. Only
 * this external parsing service is simulated, with the same HTTP contract:
 *
 *   POST {base}/tasks            multipart upload -> {"task_id": "..."}
 *   GET  {base}/tasks/{id}       -> {"status": "completed"|"failed"}
 *   GET  {base}/tasks/{id}/result -> ZIP archive containing a .md file
 *
 * The uploaded bytes must contain a marker (`WEGENT-E2E-CONVERT-<token>`); it is
 * echoed into the converted Markdown so the scenario can prove the converted
 * body - not the source bytes - reached the index. A marker containing `FAIL`
 * makes the task fail, which lets the scenario drive the conversion-failure
 * path without a second service.
 */

import type { IncomingMessage, ServerResponse } from 'http'

const MARKER_PATTERN = /WEGENT-E2E-CONVERT-[A-Za-z0-9_-]+/
const BASE_PATH = '/mineru'

interface MineruTask {
  marker: string
  failed: boolean
}

const tasks = new Map<string, MineruTask>()
let taskCounter = 0

/** Handle one MinerU request. Returns whether the URL belonged to MinerU. */
export function handleMineruRequest(
  request: IncomingMessage,
  response: ServerResponse,
  body: string
): boolean {
  const url = request.url || '/'
  if (!url.startsWith(BASE_PATH)) return false
  const path = url.slice(BASE_PATH.length) || '/'

  if (path === '/tasks' && request.method === 'POST') {
    const marker = body.match(MARKER_PATTERN)?.[0] || 'WEGENT-E2E-CONVERT-unknown'
    const taskId = `mineru-task-${++taskCounter}`
    tasks.set(taskId, { marker, failed: marker.includes('FAIL') })
    writeJson(response, 200, { task_id: taskId })
    return true
  }

  const statusMatch = /^\/tasks\/([^/]+)$/.exec(path)
  if (statusMatch && request.method === 'GET') {
    const task = tasks.get(statusMatch[1])
    if (!task) {
      response.writeHead(404).end('unknown mineru task')
      return true
    }
    writeJson(
      response,
      200,
      task.failed
        ? { status: 'failed', message: 'mock mineru parse failure' }
        : { status: 'completed' }
    )
    return true
  }

  const resultMatch = /^\/tasks\/([^/]+)\/result$/.exec(path)
  if (resultMatch && request.method === 'GET') {
    const task = tasks.get(resultMatch[1])
    if (!task) {
      response.writeHead(404).end('unknown mineru task')
      return true
    }
    const markdown = [
      '# 转换后的文档',
      '',
      `唯一断言标记：${task.marker}`,
      '',
      '![](images/figure.png)',
      '',
    ].join('\n')
    const archive = buildZip([
      { name: 'result.md', content: Buffer.from(markdown, 'utf8') },
      { name: 'images/figure.png', content: PNG_FIXTURE },
    ])
    response.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(archive.length),
    })
    response.end(archive)
    return true
  }

  response.writeHead(404).end('unknown mineru route')
  return true
}

/** The smallest valid PNG, so the archive carries a real image entry. */
const PNG_FIXTURE = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex'
)

interface ZipEntry {
  name: string
  content: Buffer
}

/** Build a store-only (no compression) ZIP archive. */
function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.content)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(entry.content.length, 18)
    localHeader.writeUInt32LE(entry.content.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, name, entry.content)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(entry.content.length, 20)
    centralHeader.writeUInt32LE(entry.content.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, name)

    offset += localHeader.length + name.length + entry.content.length
  }

  const central = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, central, end])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

function crc32(content: Buffer): number {
  let crc = 0xffffffff
  for (const byte of content) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(payload))
}
