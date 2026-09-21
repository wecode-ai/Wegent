import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants as zlibConstants, deflateSync, inflateSync } from 'node:zlib'

const CLOUD_DEVICE_NAME = 'Wework Desktop E2E Cloud Device'
const CLOUD_DEVICE_SANDBOX_ID = 'wework-desktop-e2e-sandbox'
const CLOUD_DEVICE_TOKEN = 'wework-desktop-e2e-cloud-token'
const DEFAULT_CLOUD_DEVICE_ID = 'wework-desktop-e2e-cloud-device'
const EXTENDED_CLIPBOARD_FORMAT_TEXT = 1
const EXTENDED_CLIPBOARD_ACTION_CAPS = 1 << 24
const EXTENDED_CLIPBOARD_ACTION_REQUEST = 1 << 25
const EXTENDED_CLIPBOARD_ACTION_NOTIFY = 1 << 27
const EXTENDED_CLIPBOARD_ACTION_PROVIDE = 1 << 28
const VNC_CLIPBOARD_TEXT = 'Wework 剪贴板 😀\nsecond line'

function json(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(`${JSON.stringify(value)}\n`)
}

async function readJsonRequest(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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

function rfbRawFramebufferUpdate() {
  const update = Buffer.alloc(4 + 12 + 4 * 4 * 4)
  update.writeUInt16BE(1, 2)
  update.writeUInt16BE(4, 8)
  update.writeUInt16BE(4, 10)
  update.writeInt32BE(0, 12)
  for (let offset = 16; offset < update.length; offset += 4) {
    update[offset] = 0x35
    update[offset + 1] = 0x7d
    update[offset + 2] = 0xc8
    update[offset + 3] = 0
  }
  return update
}

function rfbServerCutText(data, extended = false) {
  const header = Buffer.alloc(8)
  header[0] = 3
  header.writeInt32BE(extended ? -data.length : data.length, 4)
  return Buffer.concat([header, data])
}

function extendedClipboardFlags(action) {
  const flags = Buffer.alloc(4)
  flags.writeUInt32BE((action | EXTENDED_CLIPBOARD_FORMAT_TEXT) >>> 0)
  return flags
}

function rfbExtendedClipboardCaps() {
  const data = Buffer.alloc(8)
  data.writeUInt32BE(
    (EXTENDED_CLIPBOARD_ACTION_CAPS |
      EXTENDED_CLIPBOARD_ACTION_REQUEST |
      EXTENDED_CLIPBOARD_ACTION_NOTIFY |
      EXTENDED_CLIPBOARD_ACTION_PROVIDE |
      EXTENDED_CLIPBOARD_FORMAT_TEXT) >>>
      0
  )
  return rfbServerCutText(data, true)
}

function rfbExtendedClipboardProvide(text) {
  const textBytes = Buffer.from(`${text.replace(/\r\n|\r|\n/g, '\r\n')}\0`, 'utf8')
  const input = Buffer.alloc(4 + textBytes.length)
  input.writeUInt32BE(textBytes.length)
  textBytes.copy(input, 4)
  const data = Buffer.concat([
    extendedClipboardFlags(EXTENDED_CLIPBOARD_ACTION_PROVIDE),
    deflateSync(input),
  ])
  return rfbServerCutText(data, true)
}

function readExtendedClipboardText(data) {
  const inflated = inflateSync(data.subarray(4), { finishFlush: zlibConstants.Z_SYNC_FLUSH })
  const textLength = inflated.readUInt32BE(0)
  const textBytes = inflated.subarray(4, 4 + textLength)
  const trailingNull = textBytes[textBytes.length - 1] === 0 ? 1 : 0
  return textBytes
    .subarray(0, textBytes.length - trailingNull)
    .toString('utf8')
    .replaceAll('\r\n', '\n')
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
    this.vncSessionRequests = 0
    this.vncSessionRevocations = 0
    this.vncProtocolError = null
    this.vncRfbConnections = 0
    this.vncClientClipboardText = null
    this.vncH264Advertised = false
    this.vncCopyShortcutReceived = false
    this.vncPasteShortcutReceived = false
    this.vncKeyEvents = []
    this.vncClientClipboardAnnounced = false
    this.vncClipboardClientActions = []
    this.vncClipboardCapabilitiesReady = false
    this.vncDeviceClipboardText = VNC_CLIPBOARD_TEXT
    this.vncDeviceClipboardCommands = []
    this.consumedTickets = new Set()
    this.vncSockets = new Set()
    this.server = null
    this.upgradeHandler = null
  }

  attachServer(server) {
    this.server = server
    this.upgradeHandler = (request, socket, head) => this.handleUpgrade(request, socket, head)
    server.on('upgrade', this.upgradeHandler)
  }

  close() {
    if (this.server && this.upgradeHandler) this.server.off('upgrade', this.upgradeHandler)
    for (const socket of this.vncSockets) socket.destroy()
    this.vncSockets.clear()
    this.server = null
    this.upgradeHandler = null
  }

  diagnostics() {
    return {
      vncProtocolError: this.vncProtocolError,
      vncRfbConnections: this.vncRfbConnections,
      vncSessionRequests: this.vncSessionRequests,
      vncSessionRevocations: this.vncSessionRevocations,
      vncClipboardCapabilitiesReady: this.vncClipboardCapabilitiesReady,
      vncClientClipboardAnnounced: this.vncClientClipboardAnnounced,
      vncClipboardClientActions: this.vncClipboardClientActions,
      vncClientClipboardText: this.vncClientClipboardText,
      vncDeviceClipboardCommands: this.vncDeviceClipboardCommands,
      vncDeviceClipboardText: this.vncDeviceClipboardText,
      vncCopyShortcutReceived: this.vncCopyShortcutReceived,
      vncPasteShortcutReceived: this.vncPasteShortcutReceived,
    }
  }

  async handleHttp(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/devices') {
      json(response, 200, {
        items: [
          {
            id: 9002,
            device_id: this.deviceId,
            name: CLOUD_DEVICE_NAME,
            status: 'online',
            is_default: false,
            device_type: 'cloud',
            bind_shell: 'claudecode',
            executor_version: '1.8.5',
            client_ip: '127.0.0.1',
            cloud_config: this.cloudDeviceConfig,
            runtime_features: {
              schemaVersion: 4,
              desktop: {
                version: 1,
                available: true,
                protocol: 'rfb',
                transport: 'websocket',
                clipboard: 'text',
              },
            },
          },
        ],
        total: 1,
      })
      return true
    }

    const sessionPath = `/api/devices/${this.deviceId}/vnc`
    const commandPath = `/api/devices/${this.deviceId}/commands`
    if (request.method === 'POST' && url.pathname === commandPath) {
      if (request.headers.authorization !== `Bearer ${CLOUD_DEVICE_TOKEN}`) {
        json(response, 401, { error: 'Desktop E2E command authorization is missing' })
        return true
      }
      const body = await readJsonRequest(request)
      this.vncDeviceClipboardCommands.push(body.command_key)
      if (body.command_key === 'vnc_clipboard_read') {
        json(response, 200, {
          success: true,
          exit_code: 0,
          stdout: Buffer.from(this.vncDeviceClipboardText, 'utf8').toString('base64'),
          stderr: '',
        })
        return true
      }
      if (body.command_key === 'vnc_clipboard_write') {
        this.vncDeviceClipboardText = Buffer.from(
          body.env?.WEWORK_VNC_CLIPBOARD_BASE64 ?? '',
          'base64'
        ).toString('utf8')
        json(response, 200, { success: true, exit_code: 0, stdout: '', stderr: '' })
        return true
      }
      json(response, 400, { error: `Unexpected command: ${body.command_key}` })
      return true
    }
    if (request.method === 'POST' && url.pathname === sessionPath) {
      if (request.headers.authorization !== `Bearer ${CLOUD_DEVICE_TOKEN}`) {
        json(response, 401, { error: 'Desktop E2E VNC authorization is missing' })
        return true
      }
      this.vncSessionRequests += 1
      const sequence = this.vncSessionRequests
      const sessionId = `vnc-e2e-${sequence}`
      const ticket = `single-use-${sequence}`
      json(response, 200, {
        session_id: sessionId,
        device_id: this.deviceId,
        type: 'vnc',
        path: '',
        url: `ws://${request.headers.host}/vnc-proxy/sessions/${sessionId}?ticket=${ticket}`,
        transport: 'websocket',
        expires_at: '2099-01-01T00:00:00Z',
      })
      return true
    }

    if (
      request.method === 'DELETE' &&
      /^\/api\/devices\/vnc-sessions\/vnc-e2e-\d+$/.test(url.pathname)
    ) {
      this.vncSessionRevocations += 1
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
      response.end()
      return true
    }
    return false
  }

  handleUpgrade(request, socket, head) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const match = url.pathname.match(/^\/vnc-proxy\/sessions\/(vnc-e2e-(\d+))$/)
    const ticket = url.searchParams.get('ticket')
    if (!match || ticket !== `single-use-${match[2]}` || this.consumedTickets.has(ticket)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.consumedTickets.add(ticket)

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
    const sendExtendedClipboard = (action, text) => {
      if (action !== EXTENDED_CLIPBOARD_ACTION_PROVIDE) {
        socket.write(websocketBinaryFrame(rfbServerCutText(extendedClipboardFlags(action), true)))
        return
      }
      socket.write(websocketBinaryFrame(rfbExtendedClipboardProvide(text)))
    }
    const matchesKeyEventTail = expected => {
      const tail = this.vncKeyEvents.slice(-expected.length)
      return (
        tail.length === expected.length &&
        tail.every(
          ([keysym, down], index) => keysym === expected[index][0] && down === expected[index][1]
        )
      )
    }
    const updateClipboardShortcuts = () => {
      const expectedPaste = [
        [0xffe3, 1],
        [0x0076, 1],
        [0x0076, 0],
        [0xffe3, 0],
      ]
      const expectedCopy = [
        [0xffe9, 0],
        [0xffeb, 0],
        [0xffe3, 1],
        [0x0063, 1],
        [0x0063, 0],
        [0xffe3, 0],
      ]
      if (!this.vncPasteShortcutReceived && matchesKeyEventTail(expectedPaste)) {
        this.vncPasteShortcutReceived = true
      }
      if (!this.vncCopyShortcutReceived && matchesKeyEventTail(expectedCopy)) {
        this.vncCopyShortcutReceived = true
        sendExtendedClipboard(EXTENDED_CLIPBOARD_ACTION_NOTIFY)
      }
    }
    const handleConnectedMessage = payload => {
      if (payload[0] === 2) {
        const count = payload.readUInt16BE(2)
        for (let index = 0; index < count; index += 1) {
          if (payload.readInt32BE(4 + index * 4) === 50) this.vncH264Advertised = true
        }
        return
      }
      if (payload[0] === 4 && payload.length === 8) {
        this.vncKeyEvents.push([payload.readUInt32BE(4), payload[1]])
        updateClipboardShortcuts()
        return
      }
      if (payload[0] !== 6 || payload.length < 12) return

      const length = payload.readInt32BE(4)
      if (length >= 0 || payload.length !== 8 + Math.abs(length)) return
      const data = payload.subarray(8)
      const flags = data.readUInt32BE(0)
      const action = flags & 0xff000000
      this.vncClipboardClientActions.push(action)
      if ((action & EXTENDED_CLIPBOARD_ACTION_CAPS) !== 0) {
        this.vncClipboardCapabilitiesReady = true
      } else if (action === EXTENDED_CLIPBOARD_ACTION_REQUEST) {
        sendExtendedClipboard(EXTENDED_CLIPBOARD_ACTION_PROVIDE, VNC_CLIPBOARD_TEXT)
      } else if (action === EXTENDED_CLIPBOARD_ACTION_NOTIFY) {
        this.vncClientClipboardAnnounced = true
      } else if (action === EXTENDED_CLIPBOARD_ACTION_PROVIDE) {
        if (this.vncClientClipboardAnnounced) {
          this.vncClientClipboardText = readExtendedClipboardText(data)
        }
      }
    }
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
          if (frame.opcode !== 2) continue
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
            socket.write(
              Buffer.concat([
                websocketBinaryFrame(rfbServerInit()),
                websocketBinaryFrame(rfbRawFramebufferUpdate()),
                websocketBinaryFrame(rfbExtendedClipboardCaps()),
              ])
            )
            this.vncRfbConnections += 1
            stage = 3
          } else {
            handleConnectedMessage(frame.payload)
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

  async verify(control) {
    await control.command('click', '[data-testid="settings-button"]')
    await control.command('click', '[data-testid="settings-menu-button"]')
    await control.command('waitFor', '[data-testid="wework-settings-page"]', {
      timeoutMs: this.uiTimeoutMs,
    })
    await control.command('click', '[data-testid="settings-nav-connections"]')
    const desktopButton = `[data-testid="connection-vnc-desktop-button-${this.deviceId}"]`
    await control.command('waitFor', desktopButton, { enabled: true, timeoutMs: this.uiTimeoutMs })
    await control.command('nativePress', desktopButton, { key: 'Tab' })
    const parentControlClientId = control.activeControlClientId
    await control.command('click', desktopButton)
    const surfaceStartedAt = Date.now()
    while (
      control.activeControlClientId === parentControlClientId &&
      Date.now() - surfaceStartedAt < this.uiTimeoutMs
    ) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    }
    assert.notEqual(
      control.activeControlClientId,
      parentControlClientId,
      'The isolated VNC Chromium renderer did not register its control client'
    )
    await control.command('waitFor', '[data-testid="vnc-viewer-status"]', {
      timeoutMs: this.uiTimeoutMs,
    })
    const startedAt = Date.now()
    while (this.vncRfbConnections !== 1 && Date.now() - startedAt < this.uiTimeoutMs) {
      if (this.vncProtocolError) throw new Error(this.vncProtocolError)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    }
    assert.equal(this.vncProtocolError, null, 'The noVNC RFB handshake failed')
    assert.equal(this.vncRfbConnections, 1, 'Chromium did not complete the noVNC RFB handshake')
    assert.equal(this.vncSessionRequests, 1, 'The viewer did not request one Backend VNC session')
    await control.command('waitFor', '[data-testid="vnc-viewer"][data-vnc-first-frame="true"]', {
      timeoutMs: this.uiTimeoutMs,
    })
    const capabilityStartedAt = Date.now()
    while (!this.vncClipboardCapabilitiesReady && Date.now() - capabilityStartedAt < 10_000) {
      if (this.vncProtocolError) throw new Error(this.vncProtocolError)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    }
    assert.equal(
      this.vncClipboardCapabilitiesReady,
      true,
      'noVNC did not acknowledge extended clipboard capabilities'
    )
    await control.command('focusMainWindow', 'body')
    await control.command('press', '[data-testid="vnc-viewer"]', { key: 'Meta+C' })
    await control.command('waitFor', '[data-testid="vnc-viewer-clipboard-notice"]', {
      timeoutMs: this.uiTimeoutMs,
    })
    await control.command('click', '[data-testid="vnc-viewer-paste-button"]')
    const clipboardStartedAt = Date.now()
    while (
      (!this.vncPasteShortcutReceived ||
        !this.vncDeviceClipboardCommands.includes('vnc_clipboard_write')) &&
      Date.now() - clipboardStartedAt < this.uiTimeoutMs
    ) {
      if (this.vncProtocolError) throw new Error(this.vncProtocolError)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    }
    assert.equal(this.vncH264Advertised, true, 'noVNC did not advertise H.264 in Electron')
    assert.equal(
      this.vncCopyShortcutReceived,
      true,
      'The macOS copy shortcut did not send remote Control+C'
    )
    assert.equal(
      this.vncDeviceClipboardText,
      VNC_CLIPBOARD_TEXT,
      'The Executor UTF-8 clipboard round trip changed the text'
    )
    assert.deepEqual(
      this.vncDeviceClipboardCommands,
      ['vnc_clipboard_read', 'vnc_clipboard_write'],
      'The viewer did not read and write through the device clipboard bridge'
    )
    assert.equal(
      this.vncPasteShortcutReceived,
      true,
      'The clipboard action did not send remote Control+V'
    )
  }
}

export function createVncDesktopScenario({ deviceId = DEFAULT_CLOUD_DEVICE_ID, uiTimeoutMs } = {}) {
  return new VncDesktopScenario({ deviceId, uiTimeoutMs })
}
