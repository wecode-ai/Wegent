import assert from 'node:assert/strict'

/** Use the isolated Electron session for authenticated Runtime requests. */
export async function fetchLocalRuntime(control, url, init = {}) {
  const { signal, ...request } = init
  signal?.throwIfAborted()
  const result = JSON.parse(
    await control.command('fetchLocalRuntime', 'body', {
      value: JSON.stringify({ url: String(url), ...request }),
      ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
      preserveResultAcrossClientReplacement: true,
    })
  )
  signal?.throwIfAborted()
  const emptyBody = request.method === 'HEAD' || [204, 205, 304].includes(result.status)
  return new Response(emptyBody ? null : result.body, {
    status: result.status,
    headers: result.headers,
  })
}

export async function fetchLocalRuntimeJson(control, url, init = {}) {
  const response = await fetchLocalRuntime(control, url, init)
  const body = await response.json()
  assert.equal(response.ok, true, `${init.method ?? 'GET'} ${url} failed: ${JSON.stringify(body)}`)
  return body
}

/** Invoke a native capability through the real authenticated renderer HTTP boundary. */
export async function invokeLocalHost(control, capability, params = {}, { timeoutMs } = {}) {
  const origin = await control.command('getLocationOrigin', 'body')
  const body = await fetchLocalRuntimeJson(control, `${origin}/wework/electron-host/v1/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability, params }),
    timeoutMs,
  })
  assert.equal(body.ok, true, `${capability} failed: ${body.error?.message}`)
  return body.result
}
