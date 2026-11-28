import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { expect, test } from 'vitest'
import { ModelDiagnosticsServer } from './model-diagnostics-server.js'
import { PreferencesStore } from './preferences-store.js'

test('preserves consenting error bodies and cancels delivery when saving a refusal fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-model-diagnostics-'))
  const store = new PreferencesStore(directory)
  const diagnostics = new ModelDiagnosticsServer(store)
  const received: unknown[] = []
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received.push(JSON.parse(Buffer.concat(chunks).toString()))
    if (received.length === 1) response.end()
  })
  try {
    receiver.listen(0, '127.0.0.1')
    await once(receiver, 'listening')
    const address = receiver.address()
    if (!address || typeof address === 'string') throw new Error('Missing test receiver')
    const { WEWORK_MODEL_DIAGNOSTICS_URL: url, WEWORK_MODEL_DIAGNOSTICS_TOKEN: token } =
      await diagnostics.start()
    const body = '{  "error": "quota" }\n'
    const send = (authorization = `Bearer ${token}`) =>
      fetch(url!, {
        method: 'POST',
        headers: { authorization },
        body: JSON.stringify({
          $ai_model: 'kimi',
          http_status: 429,
          response_body: body,
          response_body_encoding: 'utf-8',
        }),
      })
    expect((await send('Bearer wrong-token')).status).toBe(401)
    await send()
    expect(received).toEqual([])

    const destination = { host: `http://127.0.0.1:${address.port}`, projectKey: 'test' }
    await store.update({
      detailedTelemetryEnabled: true,
      detailedTelemetryDestination: destination,
    })
    await send()
    expect(received).toEqual([])

    await store.update({ telemetryEnabled: true, detailedTelemetryEnabled: false })
    await send()
    expect(received).toEqual([])

    await store.update({
      detailedTelemetryEnabled: true,
      detailedTelemetryDestination: { ...destination, host: `http://localhost:${address.port}` },
    })
    await send()
    expect(received).toEqual([])

    await store.update({
      detailedTelemetryEnabled: true,
      detailedTelemetryDestination: destination,
    })
    await send()
    expect(received).toEqual([
      expect.objectContaining({
        api_key: 'test',
        event: 'model_http_error',
        properties: expect.objectContaining({
          $ai_model: 'kimi',
          http_status: 429,
          response_body: body,
          response_body_encoding: 'utf-8',
        }),
      }),
    ])

    const nextRequest = once(receiver, 'request')
    const pending = send()
    const [, inFlight] = await nextRequest
    const disconnected = once(inFlight, 'close')
    const preferences = join(directory, 'app-preferences.json')
    await mkdir(`${preferences}.${process.pid}.tmp`)
    await expect(store.update({ detailedTelemetryEnabled: false })).rejects.toThrow()
    expect(JSON.parse(await readFile(preferences, 'utf8')).detailedTelemetryEnabled).toBe(true)
    await disconnected
    await pending
    const countAtRevocation = received.length
    await send()
    expect(received).toHaveLength(countAtRevocation)
  } finally {
    diagnostics.stop()
    receiver.closeAllConnections()
    receiver.close()
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
