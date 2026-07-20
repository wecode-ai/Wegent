import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const CLOUD_DEVICE_NAME = 'Wework Desktop E2E Cloud Device'
const CLOUD_DEVICE_SANDBOX_ID = 'wework-desktop-e2e-sandbox'
const CLOUD_DEVICE_TOKEN = 'wework-desktop-e2e-cloud-token'

function json(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(`${JSON.stringify(value)}\n`)
}

function websocketBinaryFrame(payload) {
  const data = Buffer.from(payload)
  assert.ok(data.length < 126, 'Desktop E2E RFB frame unexpectedly requires extended length')
  return Buffer.concat([Buffer.from([0x82, data.length]), data])
}

function consumeWebSocketFrames(buffer) {
  const frames = []
  let offset = 0
  while (buffer.length - offset >= 2) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    let payloadLength = second & 0x7f
    let headerLength = 2
    if (payloadLength === 126) {
      if (buffer.length - offset < 4) break
      payloadLength = buffer.readUInt16BE(offset + 2)
      headerLength = 4
    } else if (payloadLength === 127) {
      if (buffer.length - offset < 10) break
      const extendedLength = buffer.readBigUInt64BE(offset + 2)
      assert.ok(extendedLength <= BigInt(Number.MAX_SAFE_INTEGER), 'WebSocket frame is too large')
      payloadLength = Number(extendedLength)
      headerLength = 10
    }

    const masked = Boolean(second & 0x80)
    const maskLength = masked ? 4 : 0
    const frameLength = headerLength + maskLength + payloadLength
    if (buffer.length - offset < frameLength) break

    const maskOffset = offset + headerLength
    const payloadOffset = maskOffset + maskLength
    const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + payloadLength))
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4)
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4]
      }
    }
    frames.push({ opcode: first & 0x0f, payload })
    offset += frameLength
  }
  return { frames, remaining: buffer.subarray(offset) }
}

function rfbServerInit() {
  const name = Buffer.from('Wework Desktop E2E VNC')
  const header = Buffer.alloc(24)
  header.writeUInt16BE(4, 0)
  header.writeUInt16BE(4, 2)
  header[4] = 32
  header[5] = 24
  header[6] = 0
  header[7] = 1
  header.writeUInt16BE(255, 8)
  header.writeUInt16BE(255, 10)
  header.writeUInt16BE(255, 12)
  header[14] = 16
  header[15] = 8
  header[16] = 0
  header.writeUInt32BE(name.length, 20)
  return Buffer.concat([header, name])
}

async function waitForSnapshot(control, predicate, message, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (predicate(snapshot)) return snapshot
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

class VncDesktopScenario {
  constructor({ deviceId, uiTimeoutMs }) {
    this.deviceId = deviceId
    this.uiTimeoutMs = uiTimeoutMs
    this.authToken = CLOUD_DEVICE_TOKEN
    this.cloudDeviceConfig = {
      sandboxId: CLOUD_DEVICE_SANDBOX_ID,
      deviceId,
      deviceName: CLOUD_DEVICE_NAME,
    }
    this.vncConfigRequests = 0
    this.vncProtocolError = null
    this.vncRfbConnections = 0
    this.vncSockets = new Set()
    this.server = null
    this.upgradeHandler = null
  }

  attachServer(server) {
    this.server = server
    this.upgradeHandler = (request, socket, head) => {
      this.handleUpgrade(request, socket, head)
    }
    server.on('upgrade', this.upgradeHandler)
  }

  close() {
    if (this.server && this.upgradeHandler) {
      this.server.off('upgrade', this.upgradeHandler)
    }
    for (const socket of this.vncSockets) socket.destroy()
    this.vncSockets.clear()
    this.server = null
    this.upgradeHandler = null
  }

  diagnostics() {
    return {
      vncConfigRequests: this.vncConfigRequests,
      vncProtocolError: this.vncProtocolError,
      vncRfbConnections: this.vncRfbConnections,
    }
  }

  async handleHttp(request, response, url) {
    if (
      request.method !== 'GET' ||
      url.pathname !== `/api/cloud-devices/${this.deviceId}/vnc-config`
    ) {
      return false
    }

    if (request.headers.authorization !== `Bearer ${CLOUD_DEVICE_TOKEN}`) {
      json(response, 401, { error: 'Desktop E2E VNC authorization is missing' })
      return true
    }
    this.vncConfigRequests += 1
    json(response, 200, {
      wss_url: 'wss://unused.example.test/vnc',
      signature: 'unused-signature',
      sandbox_id: CLOUD_DEVICE_SANDBOX_ID,
    })
    return true
  }

  handleUpgrade(request, socket, head) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (
      url.pathname !== `/vnc-proxy/${this.deviceId}` ||
      url.searchParams.get('token') !== CLOUD_DEVICE_TOKEN
    ) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n')
    )
    this.vncSockets.add(socket)
    socket.once('close', () => this.vncSockets.delete(socket))
    socket.once('error', () => this.vncSockets.delete(socket))

    let buffered = Buffer.from(head)
    let stage = 0
    const handleData = chunk => {
      try {
        buffered = Buffer.concat([buffered, chunk])
        const decoded = consumeWebSocketFrames(buffered)
        buffered = decoded.remaining
        for (const frame of decoded.frames) {
          if (frame.opcode === 8) {
            socket.end()
            return
          }
          if (frame.opcode !== 1 && frame.opcode !== 2) continue
          if (stage === 0) {
            assert.match(frame.payload.toString('ascii'), /^RFB 003\.00[378]\n$/)
            socket.write(websocketBinaryFrame(Buffer.from([1, 1])))
            stage = 1
          } else if (stage === 1) {
            assert.equal(frame.payload[0], 1, 'noVNC did not select None security')
            socket.write(websocketBinaryFrame(Buffer.from([0, 0, 0, 0])))
            stage = 2
          } else if (stage === 2) {
            assert.equal(frame.payload.length, 1, 'noVNC sent an invalid ClientInit message')
            socket.write(websocketBinaryFrame(rfbServerInit()))
            this.vncRfbConnections += 1
            stage = 3
          }
        }
      } catch (error) {
        this.vncProtocolError = error instanceof Error ? error.message : String(error)
        socket.destroy()
      }
    }
    socket.on('data', handleData)
    socket.write(websocketBinaryFrame(Buffer.from('RFB 003.008\n', 'ascii')))
    if (buffered.length > 0) handleData(Buffer.alloc(0))
  }

  async waitForConnection(control) {
    const startedAt = Date.now()
    let lastState = null
    while (Date.now() - startedAt < this.uiTimeoutMs) {
      if (this.vncProtocolError) {
        throw new Error(`The noVNC RFB handshake failed: ${this.vncProtocolError}`)
      }
      if (this.vncRfbConnections === 1) {
        try {
          const rawState = await control.command('evalEmbeddedBrowserJson', 'workspace-browser', {
            timeoutMs: 5_000,
            value:
              "({ connected: document.documentElement.dataset.vncConnected ?? '', title: document.title })",
          })
          lastState = JSON.parse(rawState)
          if (
            lastState?.connected === 'true' &&
            String(lastState.title ?? '').includes(CLOUD_DEVICE_SANDBOX_ID)
          ) {
            return lastState
          }
        } catch (error) {
          lastState = { error: error instanceof Error ? error.message : String(error) }
        }
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    }
    throw new Error(
      `The native VNC page did not emit its connected state after the authenticated RFB handshake: ${JSON.stringify(lastState)}`
    )
  }

  async verify(control) {
    await control.command('prepareEmbeddedBrowserRelabelRegression', '')
    await control.command('click', '[data-testid="settings-button"]')
    await control.command('click', '[data-testid="settings-menu-button"]')
    await control.command('waitFor', '[data-testid="wework-settings-page"]', {
      timeoutMs: this.uiTimeoutMs,
    })
    await control.command('click', '[data-testid="settings-nav-connections"]')
    await control.command('waitFor', `[data-testid="connection-vnc-button-${this.deviceId}"]`, {
      enabled: true,
      timeoutMs: this.uiTimeoutMs,
    })
    await control.command('click', `[data-testid="connection-vnc-button-${this.deviceId}"]`)
    await control.command(
      'waitFor',
      '[data-testid="right-workspace-browser-tab"][aria-selected="true"]',
      { timeoutMs: this.uiTimeoutMs }
    )
    await control.command('waitFor', '[data-testid="workspace-browser-panel"]:not(.hidden)', {
      timeoutMs: this.uiTimeoutMs,
    })
    await control.command(
      'waitFor',
      '[data-testid="workspace-browser-url-input"][value*="/vnc.html?"][value*="sessionId="]:not([value*="token"]):not([value*="wsUrl"])',
      { timeoutMs: this.uiTimeoutMs }
    )
    const vncState = await this.waitForConnection(control)
    await control.command('waitFor', '[data-testid="right-workspace-browser-tab"]', {
      text: CLOUD_DEVICE_SANDBOX_ID,
      timeoutMs: this.uiTimeoutMs,
    })
    const browserSnapshot = await waitForSnapshot(
      control,
      snapshot => !snapshot.testIds.includes('wework-settings-page'),
      'Opening the cloud desktop did not leave settings',
      this.uiTimeoutMs
    )
    assert.equal(
      browserSnapshot.testIds.includes('workspace-browser-panel'),
      true,
      'Opening the cloud desktop did not show the built-in browser panel'
    )
    assert.equal(
      this.vncConfigRequests,
      1,
      'Opening the cloud desktop did not make exactly one real VNC configuration request'
    )
    assert.equal(this.vncProtocolError, null, 'The noVNC RFB handshake failed')
    assert.equal(
      this.vncRfbConnections,
      1,
      'The native VNC page did not complete exactly one authenticated RFB handshake'
    )
    assert.equal(vncState.connected, 'true', 'The noVNC connect event did not reveal the desktop')
    assert.match(
      vncState.title,
      new RegExp(CLOUD_DEVICE_SANDBOX_ID),
      'The connected VNC page did not identify its sandbox'
    )
    await control.command('click', '[data-testid="right-workspace-browser-tab-close-button"]')
    await waitForSnapshot(
      control,
      snapshot => !snapshot.testIds.includes('right-workspace-browser-tab'),
      'The VNC browser tab did not close after verification',
      this.uiTimeoutMs
    )
    await control.command('closeEmbeddedBrowser', 'workspace-browser-regression-owner')
  }
}

export function createVncDesktopScenario(options) {
  return new VncDesktopScenario(options)
}
