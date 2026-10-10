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
import JSZip from 'jszip'

const MARKER_PATTERN = /WEGENT-E2E-CONVERT-[A-Za-z0-9_-]+/
const BASE_PATH = '/mineru'

interface MineruTask {
  marker: string
  failed: boolean
}

const tasks = new Map<string, MineruTask>()
let taskCounter = 0

/** Handle one MinerU request. Returns whether the URL belonged to MinerU. */
export async function handleMineruRequest(
  request: IncomingMessage,
  response: ServerResponse,
  body: string
): Promise<boolean> {
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
    const zip = new JSZip()
    zip.file('result.md', Buffer.from(markdown, 'utf8'))
    zip.file('images/figure.png', PNG_FIXTURE, { createFolders: false })
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
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

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(payload))
}
