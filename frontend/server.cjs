// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom Next.js server with WebSocket proxy support
 *
 * This server proxies Socket.IO WebSocket connections through Next.js,
 * allowing the frontend to use a single origin for both HTTP and WebSocket.
 *
 * Usage:
 *   Development: npm run dev:proxy
 *   Production:  npm run start:proxy
 */

const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const httpProxy = require('http-proxy');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);

// Backend URL for proxying API and WebSocket requests
const BACKEND_URL = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

console.log(`[Server] Starting in ${dev ? 'development' : 'production'} mode`);
console.log(`[Server] Backend URL: ${BACKEND_URL}`);

// Initialize Next.js app
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Create HTTP proxy for WebSocket and API requests
const proxy = httpProxy.createProxyServer({
  target: BACKEND_URL,
  ws: true, // Enable WebSocket proxying
  changeOrigin: true,
  // Increase timeout for long-running connections
  proxyTimeout: 0,
  timeout: 0,
});

// Handle proxy errors
proxy.on('error', (err, req, res) => {
  console.error('[Proxy] Error:', err.message);
  if (res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
  }
});

// Log proxy requests in development
if (dev) {
  proxy.on('proxyReq', (proxyReq, req) => {
    console.log(`[Proxy] ${req.method} ${req.url} -> ${BACKEND_URL}`);
  });

  proxy.on('proxyReqWs', (proxyReq, req) => {
    console.log(`[Proxy WS] ${req.url} -> ${BACKEND_URL}`);
  });
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    const { pathname } = parsedUrl;

    // Proxy Socket.IO polling requests (HTTP long-polling fallback)
    if (pathname.startsWith('/socket.io')) {
      proxy.web(req, res);
      return;
    }

    // Proxy API requests to backend
    // Note: This replaces the Next.js rewrites for /api/* paths
    if (pathname.startsWith('/api/') && !pathname.startsWith('/api/chat/') && !pathname.startsWith('/api/subtasks/')) {
      // Let Next.js handle /api/chat/* and /api/subtasks/* routes (deprecated SSE routes)
      // All other /api/* routes are proxied to backend
      proxy.web(req, res);
      return;
    }

    // Let Next.js handle all other requests
    handle(req, res, parsedUrl);
  });

  // WebSocket server for VNC proxy (noServer mode - no listening port)
  const vncWss = new WebSocket.Server({ noServer: true });

  /**
   * Fetch VNC config from backend API for a given device.
   * Returns { wss_url, signature, sandbox_id } or throws on error.
   */
  function fetchVncConfig(deviceId, token) {
    return new Promise((resolve, reject) => {
      const url = `${BACKEND_URL}/api/cloud-devices/${encodeURIComponent(deviceId)}/vnc-config`;
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
        timeout: 10000,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Backend returned ${res.statusCode}: ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Invalid JSON from backend: ${body}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Backend request timeout')); });
    });
  }

  // Handle WebSocket upgrade requests
  server.on('upgrade', (req, socket, head) => {
    const { pathname, query } = parse(req.url, true);

    // Proxy Socket.IO WebSocket connections
    if (pathname.startsWith('/socket.io')) {
      console.log(`[Proxy WS Upgrade] ${req.url}`);
      proxy.ws(req, socket, head);
      return;
    }

    // VNC WebSocket proxy: /vnc-proxy/{deviceId}?token=jwt
    const vncMatch = pathname.match(/^\/vnc-proxy\/([^/]+)$/);
    if (vncMatch) {
      const deviceId = decodeURIComponent(vncMatch[1]);
      const token = query.token;

      if (!token) {
        console.error('[VNC Proxy] Missing token parameter');
        socket.destroy();
        return;
      }

      console.log(`[VNC Proxy] Upgrade request for device: ${deviceId}`);

      fetchVncConfig(deviceId, token)
        .then((config) => {
          console.log(`[VNC Proxy] Connecting to upstream: ${config.wss_url}`);

          // Open upstream WebSocket to Nevis VNC
          const upstream = new WebSocket(config.wss_url, {
            headers: {
              'X-Signature': config.signature,
            },
            // Reduce buffering for real-time VNC
            perMessageDeflate: false,
          });

          upstream.on('open', () => {
            console.log(`[VNC Proxy] Upstream connected for device: ${deviceId}`);

            // Accept the client upgrade
            vncWss.handleUpgrade(req, socket, head, (client) => {
              // Bidirectional binary forwarding
              client.on('message', (data) => {
                if (upstream.readyState === WebSocket.OPEN) {
                  upstream.send(data);
                }
              });

              upstream.on('message', (data) => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(data);
                }
              });

              // Clean close propagation
              client.on('close', (code, reason) => {
                console.log(`[VNC Proxy] Client closed (device: ${deviceId})`);
                if (upstream.readyState === WebSocket.OPEN) {
                  upstream.close(1000, 'Client disconnected');
                }
              });

              upstream.on('close', (code, reason) => {
                console.log(`[VNC Proxy] Upstream closed (device: ${deviceId})`);
                if (client.readyState === WebSocket.OPEN) {
                  client.close(1000, 'Upstream disconnected');
                }
              });

              // Error handling
              client.on('error', (err) => {
                console.error(`[VNC Proxy] Client error (device: ${deviceId}):`, err.message);
                if (upstream.readyState === WebSocket.OPEN) upstream.close();
              });

              upstream.on('error', (err) => {
                console.error(`[VNC Proxy] Upstream error (device: ${deviceId}):`, err.message);
                if (client.readyState === WebSocket.OPEN) client.close();
              });
            });
          });

          upstream.on('error', (err) => {
            console.error(`[VNC Proxy] Failed to connect upstream (device: ${deviceId}):`, err.message);
            socket.destroy();
          });
        })
        .catch((err) => {
          console.error(`[VNC Proxy] Config fetch failed (device: ${deviceId}):`, err.message);
          socket.destroy();
        });

      return;
    }

    // Close unhandled WebSocket connections
    socket.destroy();
  });

  // Handle server errors
  server.on('error', (err) => {
    console.error('[Server] Error:', err);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`[Server] Ready on http://${hostname}:${port}`);
    console.log(`[Server] Socket.IO proxy: /socket.io/* -> ${BACKEND_URL}/socket.io/*`);
    console.log(`[Server] API proxy: /api/* -> ${BACKEND_URL}/api/*`);
    console.log(`[Server] VNC proxy: /vnc-proxy/{deviceId} -> Nevis VNC (via backend config)`);
  });
});
