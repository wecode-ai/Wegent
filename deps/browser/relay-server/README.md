# CDP Relay Server

A standalone Chrome DevTools Protocol (CDP) relay server that bridges communication between a Chrome extension and CDP clients (like Playwright).

## Architecture

```
┌─────────────────────┐
│   Chrome Browser    │
│  (chrome.debugger)  │
└──────────┬──────────┘
           │ CDP commands/events
           ▼
┌─────────────────────┐
│   Chrome Extension  │
│   (background.js)   │
└──────────┬──────────┘
           │ WebSocket (ws://127.0.0.1:PORT/extension)
           ▼
┌─────────────────────┐
│   Relay Server      │  ← This package
└──────────┬──────────┘
           │ WebSocket (/cdp endpoint)
           ▼
┌─────────────────────┐
│   CDP Client        │  ← Playwright, etc.
└─────────────────────┘
```

## Quick Start

### 1. Start Relay Server

```bash
cd ~/dev/git/browser/relay-server
npm install
npm start
```

### 2. Load Chrome Extension

1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select: `~/dev/git/browser/relay-server/chrome-extension`

### 3. Attach to Tab

Click the extension icon on any tab. Badge shows:
- **ON**: Attached
- **...**: Connecting
- **!**: Error

## Programmatic Usage

```typescript
import { ensureRelayServer, stopRelayServer, getRelayAuthHeaders } from 'cdp-relay-server';

// Start the relay server
const relay = await ensureRelayServer({
  cdpUrl: 'http://127.0.0.1:9224'
});

console.log(`Relay server running at ${relay.baseUrl}`);
console.log(`CDP WebSocket URL: ${relay.cdpWsUrl}`);
console.log(`Extension connected: ${relay.extensionConnected()}`);

// Get auth headers for CDP client connections
const headers = getRelayAuthHeaders(relay.cdpWsUrl);

// Stop the server
await relay.stop();
// or
await stopRelayServer({ cdpUrl: 'http://127.0.0.1:18792' });
```

## Endpoints

- `GET /` - Health check (returns "OK")
- `GET /extension/status` - Extension connection status
- `GET /json/version` - CDP version info
- `GET /json/list` - List connected targets
- `GET /json/activate/:targetId` - Activate a target
- `GET /json/close/:targetId` - Close a target
- `WS /extension` - WebSocket endpoint for Chrome extension
- `WS /cdp` - WebSocket endpoint for CDP clients (requires auth header)

## Security

- Only accepts connections from loopback addresses (127.0.0.1, ::1)
- CDP client connections require an auth token via `x-cdp-relay-token` header
- Extension connections must have `chrome-extension://` origin

## License

MIT
