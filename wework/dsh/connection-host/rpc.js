import { timingSafeEqual } from 'node:crypto'
export async function handleConnectionRpc(req, res, token, request) {
  const authorization = req.headers.authorization
  const expected = Buffer.from(`Bearer ${token}`)
  const actual = Buffer.from(typeof authorization === 'string' ? authorization : '')
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)
  let status = 200
  let response
  try {
    if (!loopback || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      status = 403
      throw connectionError('forbidden', 'Forbidden')
    }
    if (req.method !== 'POST') {
      status = 405
      throw connectionError('invalid_method', 'POST is required')
    }
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk)
      if (size > 1024 * 1024)
        throw connectionError('request_too_large', 'Connection request is too large')
      chunks.push(Buffer.from(chunk))
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    response = { ok: true, result: await request(body) }
  } catch (error) {
    if (status === 200) status = 400
    response = {
      ok: false,
      error: { code: error.code ?? 'connection_failed', message: error.message },
    }
  }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(response))
}

function connectionError(code, message) {
  return Object.assign(new Error(message), { code })
}
