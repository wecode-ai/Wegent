import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

export class LocalPluginObjectStorage {
  constructor() {
    this.buckets = new Set()
    this.objects = new Map()
    this.uploads = new Map()
  }

  async start() {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(error => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined)
          return
        }
        response.writeHead(error instanceof URIError ? 400 : 500)
        response.end()
      })
    })
    await new Promise((resolvePromise, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolvePromise)
    })
    this.port = this.server.address().port
    this.endpoint = `http://127.0.0.1:${this.port}`
  }

  async handle(request, response) {
    const url = new URL(request.url ?? '/', this.endpoint)
    const [bucket = '', ...objectParts] = url.pathname.split('/').filter(Boolean)
    const objectKey = decodeURIComponent(objectParts.join('/'))
    const storageKey = `${bucket}/${objectKey}`
    if (url.searchParams.has('uploads') || url.searchParams.has('uploadId')) {
      await this.multipart(request, response, url, storageKey)
      return
    }
    if (!objectKey) {
      if (request.method === 'HEAD') {
        response.writeHead(
          this.buckets.has(bucket) ? 200 : 404,
          this.buckets.has(bucket)
            ? {}
            : {
                'x-minio-error-code': 'NoSuchBucket',
                'x-minio-error-desc': 'Bucket does not exist',
              }
        )
        response.end()
        return
      }
      if (request.method === 'PUT') {
        this.buckets.add(bucket)
        response.writeHead(200)
        response.end()
        return
      }
    }
    if (request.method === 'PUT') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      this.buckets.add(bucket)
      this.objects.set(storageKey, Buffer.concat(chunks))
      response.writeHead(200, {
        ETag: `"${createHash('md5').update(this.objects.get(storageKey)).digest('hex')}"`,
      })
      response.end()
      return
    }
    const object = this.objects.get(storageKey)
    if (!object) {
      response.writeHead(404, {
        'Content-Type': 'application/xml',
        'x-minio-error-code': 'NoSuchKey',
        'x-minio-error-desc': 'Object does not exist',
      })
      response.end('<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>')
      return
    }
    if (request.method === 'HEAD') {
      response.writeHead(200, {
        'Content-Length': String(object.length),
        'Last-Modified': new Date().toUTCString(),
        ETag: '"e2e"',
      })
      response.end()
      return
    }
    if (request.method === 'GET') {
      response.writeHead(200, {
        'Content-Length': String(object.length),
        'Content-Type': 'application/zip',
      })
      response.end(object)
      return
    }
    if (request.method === 'DELETE') {
      this.objects.delete(storageKey)
      response.writeHead(204)
      response.end()
      return
    }
    response.writeHead(405)
    response.end()
  }

  async multipart(request, response, url, storageKey) {
    const xml = body => {
      response.writeHead(200, { 'Content-Type': 'application/xml' })
      response.end(body)
    }
    const error = code => {
      response.writeHead(400, { 'Content-Type': 'application/xml' })
      response.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`)
    }
    if (request.method === 'POST' && url.searchParams.has('uploads')) {
      const id = randomUUID()
      this.uploads.set(id, { storageKey, parts: new Map() })
      xml(
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`
      )
      return
    }
    const id = url.searchParams.get('uploadId')
    const upload = this.uploads.get(id)
    if (!upload || upload.storageKey !== storageKey) return error('NoSuchUpload')
    if (request.method === 'DELETE') {
      this.uploads.delete(id)
      response.writeHead(204)
      response.end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    if (request.method === 'PUT') {
      const part = Number(url.searchParams.get('partNumber'))
      if (!Number.isSafeInteger(part) || part < 1 || part > 10000) return error('InvalidPart')
      const etag = createHash('md5').update(body).digest('hex')
      upload.parts.set(part, { body, etag })
      response.writeHead(200, { ETag: `"${etag}"` })
      response.end()
      return
    }
    if (request.method !== 'POST') return error('InvalidRequest')
    const parts = [...body.toString().matchAll(/<Part>([\s\S]*?)<\/Part>/g)]
    const completed = []
    for (const [index, match] of parts.entries()) {
      const number = Number(match[1].match(/<PartNumber>(\d+)<\/PartNumber>/)?.[1])
      const etag = match[1]
        .match(/<ETag>(.*?)<\/ETag>/)?.[1]
        ?.replaceAll('&quot;', '')
        .replaceAll('"', '')
      const part = upload.parts.get(number)
      if (number !== index + 1 || !part || part.etag !== etag) return error('InvalidPart')
      completed.push(part.body)
    }
    if (!completed.length) return error('InvalidPart')
    const object = Buffer.concat(completed)
    this.objects.set(storageKey, object)
    this.uploads.delete(id)
    const etag = createHash('md5').update(object).digest('hex')
    xml(
      `<CompleteMultipartUploadResult><Location>${this.endpoint}</Location><Bucket>e2e</Bucket><Key>e2e</Key><ETag>"${etag}"</ETag></CompleteMultipartUploadResult>`
    )
  }

  async stop() {
    if (!this.server) return
    await new Promise(resolvePromise => {
      this.server.close(resolvePromise)
      this.server.closeAllConnections?.()
    })
  }
}
