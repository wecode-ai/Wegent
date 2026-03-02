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

// WebSocket server for VNC proxy (noServer mode - we handle upgrades manually)
const vncWss = new WebSocket.Server({ noServer: true });

/**
 * Handle VNC WebSocket proxy connection.
 *
 * 1. Extracts deviceId from path and token from query string
 * 2. Fetches VNC config from backend (wss_url + signature)
 * 3. Opens upstream connection to Nevis VNC WebSocket
 * 4. Bidirectionally proxies binary data between client and upstream
 */
function handleVncProxy(req, socket, head) {
  const { pathname, query } = parse(req.url, true);
  const match = pathname.match(/^\/vnc-proxy\/([^/]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }

  const deviceId = decodeURIComponent(match[1]);
  const token = query.token;

  if (!token) {
    socket.destroy();
    return;
  }

  // Fetch VNC config from backend
  const configUrl = `${BACKEND_URL}/api/cloud-devices/${encodeURIComponent(deviceId)}/vnc-config`;
  const http = configUrl.startsWith('https') ? require('https') : require('http');

  const configReq = http.get(configUrl, {
    headers: { 'Authorization': `Bearer ${token}` },
  }, (configRes) => {
    let body = '';
    configRes.on('data', (chunk) => { body += chunk; });
    configRes.on('end', () => {
      if (configRes.statusCode !== 200) {
        console.error(`[VNC Proxy] Backend config error: ${configRes.statusCode} ${body}`);
        socket.destroy();
        return;
      }

      let config;
      try {
        config = JSON.parse(body);
      } catch {
        console.error('[VNC Proxy] Invalid config JSON from backend');
        socket.destroy();
        return;
      }

      const { wss_url, signature } = config;
      if (!wss_url || !signature) {
        console.error('[VNC Proxy] Missing wss_url or signature in config');
        socket.destroy();
        return;
      }

      // Connect to upstream Nevis VNC WebSocket
      const upstream = new WebSocket(wss_url, {
        headers: { 'X-Signature': signature },
        perMessageDeflate: false,
      });

      upstream.on('open', () => {
        console.log(`[VNC Proxy] Upstream connected for device=${deviceId}`);

        // Accept the client WebSocket upgrade
        vncWss.handleUpgrade(req, socket, head, (clientWs) => {
          // Forward client -> upstream
          clientWs.on('message', (data) => {
            if (upstream.readyState === WebSocket.OPEN) {
              upstream.send(data);
            }
          });

          // Forward upstream -> client
          upstream.on('message', (data) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(data);
            }
          });

          // Clean close propagation
          clientWs.on('close', () => {
            if (upstream.readyState === WebSocket.OPEN) {
              upstream.close();
            }
          });

          upstream.on('close', () => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.close();
            }
          });

          // Error handling
          clientWs.on('error', (err) => {
            console.error(`[VNC Proxy] Client error: ${err.message}`);
            upstream.close();
          });

          upstream.on('error', (err) => {
            console.error(`[VNC Proxy] Upstream error: ${err.message}`);
            clientWs.close();
          });
        });
      });

      upstream.on('error', (err) => {
        console.error(`[VNC Proxy] Upstream connection failed: ${err.message}`);
        socket.destroy();
      });
    });
  });

  configReq.on('error', (err) => {
    console.error(`[VNC Proxy] Config request failed: ${err.message}`);
    socket.destroy();
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

  // Handle WebSocket upgrade requests
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url, true);

    // Proxy Socket.IO WebSocket connections
    if (pathname.startsWith('/socket.io')) {
      console.log(`[Proxy WS Upgrade] ${req.url}`);
      proxy.ws(req, socket, head);
    } else if (pathname.startsWith('/vnc-proxy/')) {
      // VNC WebSocket proxy
      handleVncProxy(req, socket, head);
    } else {
      // Close other WebSocket connections
      socket.destroy();
    }
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
    console.log(`[Server] VNC proxy: /vnc-proxy/{deviceId} -> Nevis VNC WebSocket`);
  });
});
