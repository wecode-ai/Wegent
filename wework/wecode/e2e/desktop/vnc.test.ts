import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'

const scenarioEntryPath = resolve(import.meta.dirname, 'index.mjs')

interface Scenario {
  authToken: string
  cloudDeviceConfig: Record<string, string>
  diagnostics: () => Record<string, number | string | null>
  handleHttp: (request: unknown, response: unknown, url: URL) => Promise<boolean>
}

async function createScenario(): Promise<Scenario | null> {
  expect(existsSync(scenarioEntryPath)).toBe(true)
  if (!existsSync(scenarioEntryPath)) return null
  const moduleUrl = pathToFileURL(scenarioEntryPath).href
  const { createDesktopScenario } = (await import(/* @vite-ignore */ moduleUrl)) as {
    createDesktopScenario: (options: { uiTimeoutMs: number }) => Scenario
  }
  return createDesktopScenario({ uiTimeoutMs: 120_000 })
}

function response() {
  let body = ''
  let statusCode = 0
  return {
    end(value = '') {
      body += String(value)
    },
    get body() {
      return body
    },
    get statusCode() {
      return statusCode
    },
    writeHead(value: number) {
      statusCode = value
    },
  }
}

describe('Wecode Desktop VNC scenario', () => {
  test('owns the cloud device fixture and advertises the generic desktop capability', async () => {
    const scenario = await createScenario()
    if (!scenario) return
    const result = response()

    const handled = await scenario.handleHttp(
      { headers: {}, method: 'GET' },
      result,
      new URL('http://127.0.0.1/api/devices')
    )

    expect(handled).toBe(true)
    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.items[0]).toMatchObject({
      device_id: 'wework-desktop-e2e-cloud-device',
      device_type: 'cloud',
      runtime_features: {
        desktop: {
          available: true,
          clipboard: 'text',
          protocol: 'rfb',
          transport: 'websocket',
        },
      },
    })
  })

  test('rejects a session request without the HTTP bearer token', async () => {
    const scenario = await createScenario()
    if (!scenario) return
    const result = response()

    const handled = await scenario.handleHttp(
      { headers: { host: '127.0.0.1:43123' }, method: 'POST' },
      result,
      new URL('http://127.0.0.1/api/devices/wework-desktop-e2e-cloud-device/vnc')
    )

    expect(handled).toBe(true)
    expect(result.statusCode).toBe(401)
    expect(JSON.parse(result.body)).toEqual({ error: 'Desktop E2E VNC authorization is missing' })
  })

  test('returns only a short-lived Backend session URL to an authorized request', async () => {
    const scenario = await createScenario()
    if (!scenario) return
    const result = response()

    await scenario.handleHttp(
      {
        headers: {
          authorization: 'Bearer wework-desktop-e2e-cloud-token',
          host: '127.0.0.1:43123',
        },
        method: 'POST',
      },
      result,
      new URL('http://127.0.0.1/api/devices/wework-desktop-e2e-cloud-device/vnc')
    )

    const body = JSON.parse(result.body)
    expect(body).toMatchObject({
      session_id: 'vnc-e2e-1',
      transport: 'websocket',
      type: 'vnc',
    })
    expect(body.url).toBe('ws://127.0.0.1:43123/vnc-proxy/sessions/vnc-e2e-1?ticket=single-use-1')
    expect(JSON.stringify(body)).not.toContain('wework-desktop-e2e-cloud-token')
    expect(JSON.stringify(body)).not.toContain('signature')
  })

  test('exposes deterministic protocol diagnostics', async () => {
    const scenario = await createScenario()
    if (!scenario) return

    expect(scenario.diagnostics()).toEqual({
      vncProtocolError: null,
      vncRfbConnections: 0,
      vncSessionRequests: 0,
      vncSessionRevocations: 0,
    })
  })
})
