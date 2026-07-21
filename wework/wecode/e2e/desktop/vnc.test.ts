import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'

const scenarioEntryPath = resolve(import.meta.dirname, 'index.mjs')

interface Scenario {
  authToken: string
  cloudDeviceConfig: {
    deviceId: string
    deviceName: string
    sandboxId: string
  }
  diagnostics: () => {
    vncConfigRequests: number
    vncProtocolError: string | null
    vncRfbConnections: number
  }
  handleHttp: (request: unknown, response: unknown, url: URL) => Promise<boolean>
}

async function createScenario(): Promise<Scenario | null> {
  expect(existsSync(scenarioEntryPath)).toBe(true)
  if (!existsSync(scenarioEntryPath)) return null

  const moduleUrl = pathToFileURL(scenarioEntryPath).href
  const { createDesktopScenario } = (await import(/* @vite-ignore */ moduleUrl)) as {
    createDesktopScenario: (options: { uiTimeoutMs: number }) => Scenario
  }
  return createDesktopScenario({
    uiTimeoutMs: 120_000,
  })
}

function response() {
  let body = ''
  let statusCode = 0
  const headers: Record<string, string> = {}

  return {
    end(value = '') {
      body += String(value)
    },
    get body() {
      return body
    },
    get headers() {
      return headers
    },
    get statusCode() {
      return statusCode
    },
    writeHead(value: number, nextHeaders: Record<string, string>) {
      statusCode = value
      Object.assign(headers, nextHeaders)
    },
  }
}

describe('Wecode Desktop VNC scenario', () => {
  test('provides the unchanged cloud-device identity and desktop token', async () => {
    const scenario = await createScenario()
    if (!scenario) return

    expect(scenario.authToken).toBe('wework-desktop-e2e-cloud-token')
    expect(scenario.cloudDeviceConfig).toEqual({
      sandboxId: 'wework-desktop-e2e-sandbox',
      deviceId: 'wework-desktop-e2e-cloud-device',
      deviceName: 'Wework Desktop E2E Cloud Device',
    })
  })

  test('rejects a configuration request without the desktop bearer token', async () => {
    const scenario = await createScenario()
    if (!scenario) return
    const result = response()

    const handled = await scenario.handleHttp(
      { headers: {}, method: 'GET' },
      result,
      new URL('http://127.0.0.1/api/cloud-devices/wework-desktop-e2e-cloud-device/vnc-config')
    )

    expect(handled).toBe(true)
    expect(result.statusCode).toBe(401)
    expect(JSON.parse(result.body)).toEqual({ error: 'Desktop E2E VNC authorization is missing' })
  })

  test('owns the cloud device fixture used by the desktop flow', async () => {
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
    expect(JSON.parse(result.body)).toEqual({
      items: [
        {
          id: 9002,
          device_id: 'wework-desktop-e2e-cloud-device',
          name: 'Wework Desktop E2E Cloud Device',
          status: 'online',
          is_default: false,
          device_type: 'cloud',
          bind_shell: 'claudecode',
          executor_version: '1.8.5',
          client_ip: '127.0.0.1',
          cloud_config: {
            sandboxId: 'wework-desktop-e2e-sandbox',
            deviceId: 'wework-desktop-e2e-cloud-device',
            deviceName: 'Wework Desktop E2E Cloud Device',
          },
        },
      ],
      total: 1,
    })
  })

  test('returns the unchanged VNC configuration to an authorized request', async () => {
    const scenario = await createScenario()
    if (!scenario) return
    const result = response()

    const handled = await scenario.handleHttp(
      {
        headers: { authorization: 'Bearer wework-desktop-e2e-cloud-token' },
        method: 'GET',
      },
      result,
      new URL('http://127.0.0.1/api/cloud-devices/wework-desktop-e2e-cloud-device/vnc-config')
    )

    expect(handled).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(JSON.parse(result.body)).toEqual({
      wss_url: 'wss://unused.example.test/vnc',
      signature: 'unused-signature',
      sandbox_id: 'wework-desktop-e2e-sandbox',
    })
    expect(scenario.diagnostics().vncConfigRequests).toBe(1)
  })

  test('exposes deterministic protocol diagnostics', async () => {
    const scenario = await createScenario()
    if (!scenario) return

    expect(scenario.diagnostics()).toEqual({
      vncConfigRequests: 0,
      vncProtocolError: null,
      vncRfbConnections: 0,
    })
  })
})
