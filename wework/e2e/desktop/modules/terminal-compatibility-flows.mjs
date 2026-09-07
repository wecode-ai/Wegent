import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

import {
  CLOUD_DEVICE_ID,
  DEFAULT_STEP_TIMEOUT_MS,
  assert,
  fetchJson,
  join,
  resultDir,
  withTimeout,
  writeFile,
} from './shared.mjs'

const TERMINAL_SELECTOR = '[data-testid="remote-terminal"]'
const BURST_LINE_COUNT = 12_000
const BURST_LINE_PREFIX = 'WEWORK_BURST_'
const BURST_LINE_SUFFIX = '_0123456789abcdefghijklmnopqrstuvwxyz'
const BURST_LINE_PATTERN = /^WEWORK_BURST_\d{5}_0123456789abcdefghijklmnopqrstuvwxyz$/
const BURST_LINES = Array.from(
  { length: BURST_LINE_COUNT },
  (_, index) => `${BURST_LINE_PREFIX}${String(index + 1).padStart(5, '0')}${BURST_LINE_SUFFIX}`
)
const BURST_BYTES = Buffer.byteLength(`${BURST_LINES.join('\n')}\n`)
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024
const RETAINED_BURST_LINES = 1_000

function markerCommand(marker) {
  const middle = Math.floor(marker.length / 2)
  // The complete marker never occurs in the command echoed by the PTY.
  return `printf '\\n%s%s\\n' '${marker.slice(0, middle)}' '${marker.slice(middle)}'`
}

function burstCommand(marker) {
  return (
    `printf '\\n'; awk 'BEGIN { for (i = 1; i <= ${BURST_LINE_COUNT}; i++) ` +
    `printf "${BURST_LINE_PREFIX}%05d${BURST_LINE_SUFFIX}\\n", i }'; ` +
    `${markerCommand(marker)}\r`
  )
}

function outputLines(text) {
  return text.replaceAll('\r', '').split('\n')
}

async function waitForTerminalOutput(readText, marker, description) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    const text = await readText()
    if (outputLines(text).includes(marker)) return text
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  // Do not dump the PTY buffer: only synthetic markers belong in test diagnostics.
  throw new Error(`${description}: missing completed output line ${marker}`)
}

async function recordEvidence(name, evidence) {
  await writeFile(
    join(resultDir, `terminal-compatibility-${name}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8'
  )
}

export async function verifyRemoteTerminalRemainsResponsiveAfterOutputBurst(control, name) {
  const endMarker = `WEWORK_BURST_END_${randomUUID().replaceAll('-', '')}`
  const afterMarker = `WEWORK_AFTER_BURST_${randomUUID().replaceAll('-', '')}`
  assert.ok(BURST_BYTES > 512 * 1024, 'The burst must exceed the v2 replay limit')
  const readText = () => control.command('getTerminalText', TERMINAL_SELECTOR)
  await control.command('terminalInput', TERMINAL_SELECTOR, { value: burstCommand(endMarker) })
  const text = await waitForTerminalOutput(readText, endMarker, 'Remote xterm burst stalled')
  const renderedLines = outputLines(text).filter(line => BURST_LINE_PATTERN.test(line))
  // xterm retains 2,000 scrollback lines; verify an exact ordered suffix, not all 12,000.
  assert.deepEqual(
    renderedLines.slice(-RETAINED_BURST_LINES),
    BURST_LINES.slice(-RETAINED_BURST_LINES),
    'Remote xterm lost, duplicated, or reordered the retained burst output'
  )
  await control.command('terminalInput', TERMINAL_SELECTOR, {
    value: `${markerCommand(afterMarker)}\r`,
  })
  await waitForTerminalOutput(readText, afterMarker, 'Remote xterm input stalled after the burst')
  await recordEvidence(name, {
    status: 'passed',
    transport: 'real-electron-xterm-backend-rust-executor-pty',
    generatedLines: BURST_LINE_COUNT,
    generatedBytes: BURST_BYTES,
    retainedLinesVerified: RETAINED_BURST_LINES,
    completionMarkerObserved: true,
    commandAfterBurstObserved: true,
  })
}

async function terminalCall(socket, event, payload) {
  const reply = await socket.timeout(DEFAULT_STEP_TIMEOUT_MS).emitWithAck(event, payload)
  assert.equal(reply?.success, true, `${event} failed: ${reply?.error ?? 'invalid reply'}`)
  return reply
}

async function connectTerminal(socket) {
  let onConnect
  let onError
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        onConnect = resolve
        onError = () => reject(new Error('The real terminal Socket.IO connection failed'))
        socket.once('connect', onConnect)
        socket.once('connect_error', onError)
        socket.connect()
      }),
      DEFAULT_STEP_TIMEOUT_MS,
      'The real terminal Socket.IO connection timed out'
    )
  } finally {
    socket.off('connect', onConnect)
    socket.off('connect_error', onError)
  }
}

// A legacy wire client is not an archived Wework or Executor binary. All server-side
// work below uses the production Backend and Rust Executor started by the runner.
export async function verifyTerminalWireCompatibility(
  cloudEnvironment,
  { requestedVersion, expectedVersion, name }
) {
  // Prebuilt CI shards have no workspace node_modules; use their bundled client.
  const { io } = createRequire(
    new URL('../../../../packages/chat-core/package.json', import.meta.url)
  )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
  const created = await fetchJson(
    `${cloudEnvironment.backendUrl}/api/devices/${encodeURIComponent(CLOUD_DEVICE_ID)}/terminal`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloudEnvironment.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: cloudEnvironment.workspacePath }),
    }
  )
  assert.ok(created.session_id, 'The real Executor did not create a terminal session')
  const sessionId = created.session_id
  const consumerId = `e2e_${randomUUID().replaceAll('-', '')}`
  const socket = io(`${cloudEnvironment.socketUrl}/terminal`, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token: cloudEnvironment.authToken },
    autoConnect: false,
    forceNew: true,
    reconnection: false,
  })
  let sessionVersion = null
  let wireError = null
  let text = ''
  let outputBytes = 0
  let outputEvents = 0
  let ackEvents = 0
  let lastSequence = 0
  let ackChain = Promise.resolve()
  let closed = false
  const controlPayload = () => ({
    session_id: sessionId,
    ...(sessionVersion === 2 ? { consumer_id: consumerId } : {}),
  })
  const acknowledge = sequence => {
    ackChain = ackChain
      .then(async () => {
        await terminalCall(socket, 'terminal:ack', {
          session_id: sessionId,
          consumer_id: consumerId,
          sequence,
        })
        ackEvents += 1
      })
      .catch(error => {
        wireError = error
      })
  }
  socket.on('terminal:output', payload => {
    try {
      assert.equal(payload.session_id, sessionId, 'Output leaked from a different terminal')
      assert.equal(typeof payload.data, 'string')
      if (expectedVersion === 1) {
        assert.equal('consumer_id' in payload, false, 'Legacy output exposed a v2 consumer')
        assert.equal('sequence' in payload, false, 'Legacy output exposed a v2 sequence')
        assert.equal(payload.protocol_version ?? 1, 1)
      } else {
        assert.equal(payload.consumer_id, consumerId)
        assert.equal(payload.sequence, lastSequence + 1, 'v2 output was not contiguous')
        lastSequence = payload.sequence
        // Initial output can race the attach reply. Authorize before sending ACKs.
        if (sessionVersion !== null) acknowledge(lastSequence)
      }
      outputBytes += Buffer.byteLength(payload.data)
      assert.ok(outputBytes <= OUTPUT_LIMIT_BYTES, 'Terminal exceeded the test output bound')
      outputEvents += 1
      text += payload.data
    } catch (error) {
      wireError = error
    }
  })
  const readText = () => {
    if (wireError) throw wireError
    return text
  }
  const input = value =>
    terminalCall(socket, 'terminal:input', { ...controlPayload(), data: value })
  try {
    await connectTerminal(socket)
    const attached = await terminalCall(socket, 'terminal:attach', {
      session_id: sessionId,
      ...(requestedVersion !== undefined ? { protocol_version: requestedVersion } : {}),
      ...(requestedVersion === 2 ? { consumer_id: consumerId, last_acked_sequence: 0 } : {}),
    })
    sessionVersion = attached.protocol_version ?? 1
    assert.equal(sessionVersion, expectedVersion, 'The terminal negotiated the wrong protocol')
    if (sessionVersion === 2 && lastSequence > 0) acknowledge(lastSequence)

    const readyMarker = `WEWORK_READY_${randomUUID().replaceAll('-', '')}`
    await input(`stty -echo; ${markerCommand(readyMarker)}\r`)
    await waitForTerminalOutput(readText, readyMarker, 'The real PTY did not accept input')
    await terminalCall(socket, 'terminal:resize', { ...controlPayload(), rows: 33, cols: 111 })
    await input("printf '\\nWEWORK_SIZE='; stty size\r")
    await waitForTerminalOutput(readText, 'WEWORK_SIZE=33 111', 'PTY resize did not propagate')

    const endMarker = `WEWORK_BURST_END_${randomUUID().replaceAll('-', '')}`
    await input(burstCommand(endMarker))
    const burstText = await waitForTerminalOutput(
      readText,
      endMarker,
      'Real terminal burst stalled'
    )
    assert.ok(BURST_BYTES > 512 * 1024, 'The burst must exceed the v2 replay limit')
    assert.deepEqual(
      outputLines(burstText).filter(line => BURST_LINE_PATTERN.test(line)),
      BURST_LINES,
      'The real PTY burst lost, duplicated, or reordered output'
    )
    await ackChain
    readText()

    const afterMarker = `WEWORK_AFTER_BURST_${randomUUID().replaceAll('-', '')}`
    await input(`${markerCommand(afterMarker)}\r`)
    await waitForTerminalOutput(readText, afterMarker, 'PTY input stalled after the burst')
    await ackChain
    readText()

    // A new socket must preserve the PTY's first negotiated version as well.
    socket.disconnect()
    await connectTerminal(socket)
    const resumed = await terminalCall(socket, 'terminal:attach', {
      ...controlPayload(),
      protocol_version: sessionVersion,
      ...(sessionVersion === 2 ? { last_acked_sequence: lastSequence } : {}),
    })
    assert.equal(resumed.protocol_version ?? 1, sessionVersion)
    const changed = await socket.timeout(DEFAULT_STEP_TIMEOUT_MS).emitWithAck('terminal:attach', {
      session_id: sessionId,
      protocol_version: sessionVersion === 1 ? 2 : 1,
      ...(sessionVersion === 1 ? { consumer_id: consumerId, last_acked_sequence: 0 } : {}),
    })
    assert.equal(typeof changed?.error, 'string', 'An attached terminal changed protocol')
    assert.notEqual(changed.success, true)

    const reconnectMarker = `WEWORK_RECONNECTED_${randomUUID().replaceAll('-', '')}`
    await input(`${markerCommand(reconnectMarker)}\r`)
    await waitForTerminalOutput(readText, reconnectMarker, 'PTY did not recover after reconnect')
    await ackChain
    readText()
    assert.ok(expectedVersion === 1 ? ackEvents === 0 : ackEvents > 0)
    await terminalCall(socket, 'terminal:close', controlPayload())
    closed = true
    const reattach = await socket.timeout(DEFAULT_STEP_TIMEOUT_MS).emitWithAck('terminal:attach', {
      ...controlPayload(),
      protocol_version: sessionVersion,
      ...(sessionVersion === 2 ? { last_acked_sequence: lastSequence } : {}),
    })
    assert.equal(typeof reattach?.error, 'string', 'A closed terminal remained attachable')
    assert.notEqual(reattach.success, true)
    await recordEvidence(name, {
      status: 'passed',
      transport: 'real-socketio-backend-rust-executor-pty',
      requestedVersion: requestedVersion ?? 'absent',
      sessionVersion,
      burstBytesVerified: BURST_BYTES,
      burstLinesVerified: BURST_LINE_COUNT,
      outputEvents,
      ackEvents,
      resizeVerified: true,
      reconnectVerified: true,
      protocolPinned: true,
      commandAfterBurstObserved: true,
      closedSessionRejected: true,
    })
  } finally {
    try {
      if (!closed && socket.connected && sessionVersion !== null) {
        await terminalCall(socket, 'terminal:close', controlPayload())
      }
    } finally {
      socket.disconnect()
      socket.removeAllListeners()
      await ackChain
    }
  }
}
