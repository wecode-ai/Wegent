// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * VNC WebSocket proxy handler for server.cjs
 *
 * This module provides VNC WebSocket proxy functionality for cloud devices.
 * Used in development proxy mode (npm run dev:proxy).
 *
 * Architecture:
 * 1. Client connects to /vnc-proxy/{deviceId}?token=jwt
 * 2. Fetch VNC config (wss_url + signature) from backend
 * 3. Connect to upstream Nevis VNC WebSocket
 * 4. Bidirectionally proxy binary data between client and upstream
 */

const { parse } = require('url')
const WebSocket = require('ws')

/**
 * Create VNC WebSocket proxy handler.
 *
 * @param {string} backendUrl - Backend API URL (e.g., http://localhost:8000)
 * @returns {Object} - { wss: WebSocket.Server, handleUpgrade: Function }
 */
function createVncProxy(backendUrl) {
  // WebSocket server in noServer mode - we handle upgrades manually
  const wss = new WebSocket.Server({ noServer: true })

  /**
   * Handle VNC WebSocket proxy connection.
   *
   * @param {http.IncomingMessage} req - HTTP upgrade request
   * @param {net.Socket} socket - Network socket
   * @param {Buffer} head - First packet of upgraded stream
   */
  function handleUpgrade(req, socket, head) {
    const { pathname, query } = parse(req.url, true)
    const match = pathname.match(/^\/vnc-proxy\/([^/]+)$/)
    if (!match) {
      socket.destroy()
      return
    }

    const deviceId = decodeURIComponent(match[1])
    const token = query.token

    if (!token) {
      socket.destroy()
      return
    }

    // Fetch VNC config from backend
    const configUrl = `${backendUrl}/api/cloud-devices/${encodeURIComponent(deviceId)}/vnc-config`
    const http = configUrl.startsWith('https') ? require('https') : require('http')

    const configReq = http.get(
      configUrl,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      configRes => {
        let body = ''
        configRes.on('data', chunk => {
          body += chunk
        })
        configRes.on('end', () => {
          if (configRes.statusCode !== 200) {
            console.error(`[VNC Proxy] Backend config error: ${configRes.statusCode} ${body}`)
            socket.destroy()
            return
          }

          let config
          try {
            config = JSON.parse(body)
          } catch {
            console.error('[VNC Proxy] Invalid config JSON from backend')
            socket.destroy()
            return
          }

          const { wss_url, signature } = config
          if (!wss_url || !signature) {
            console.error('[VNC Proxy] Missing wss_url or signature in config')
            socket.destroy()
            return
          }

          // Connect to upstream Nevis VNC WebSocket
          const upstream = new WebSocket(wss_url, {
            headers: { 'X-Signature': signature },
            perMessageDeflate: false,
          })

          upstream.on('open', () => {
            console.log(`[VNC Proxy] Upstream connected for device=${deviceId}`)

            // Accept the client WebSocket upgrade
            wss.handleUpgrade(req, socket, head, clientWs => {
              // Forward client -> upstream
              clientWs.on('message', data => {
                if (upstream.readyState === WebSocket.OPEN) {
                  upstream.send(data)
                }
              })

              // Forward upstream -> client
              upstream.on('message', data => {
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(data)
                }
              })

              // Clean close propagation
              clientWs.on('close', () => {
                if (upstream.readyState === WebSocket.OPEN) {
                  upstream.close()
                }
              })

              upstream.on('close', () => {
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.close()
                }
              })

              // Error handling
              clientWs.on('error', err => {
                console.error(`[VNC Proxy] Client error: ${err.message}`)
                upstream.close()
              })

              upstream.on('error', err => {
                console.error(`[VNC Proxy] Upstream error: ${err.message}`)
                clientWs.close()
              })
            })
          })

          upstream.on('error', err => {
            console.error(`[VNC Proxy] Upstream connection failed: ${err.message}`)
            socket.destroy()
          })
        })
      }
    )

    configReq.on('error', err => {
      console.error(`[VNC Proxy] Config request failed: ${err.message}`)
      socket.destroy()
    })
  }

  return {
    wss,
    handleUpgrade,
  }
}

module.exports = { createVncProxy }
