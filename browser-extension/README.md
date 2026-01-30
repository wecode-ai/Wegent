# Wegent Browser Extension

A browser extension that allows you to send web content to Wegent AI chat and add pages to your knowledge base.

## Features

- **Send to Chat**: Select text or extract full page content and send it to Wegent AI with a question
- **Add to Knowledge Base**: Save web content directly to your Wegent knowledge base for future reference
- **Right-click Menu**: Quick access through context menu when selecting text
- **Cross-browser Support**: Works on Chrome, Edge, and Safari

## Installation

### Chrome / Edge

1. Build the extension:
   ```bash
   cd browser-extension
   npm install
   npm run build:chrome
   ```

2. Load in Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `dist/chrome` folder

### Safari

⚠️ **Safari cannot directly load the `dist/chrome` directory.** Safari Web Extensions require an Xcode project wrapper.

1. Build and convert to Safari Xcode project:
   ```bash
   cd browser-extension
   npm install
   npm run build:safari
   ```

2. Open the generated Xcode project:
   ```bash
   open safari/WegentExtension/Wegent/Wegent.xcodeproj
   ```

3. In Xcode:
   - Configure signing (select your development team)
   - Build and run (⌘R)

4. Enable in Safari:
   - Safari → Settings → Extensions → Enable "Wegent"

See [safari/README.md](./safari/README.md) for detailed Safari-specific instructions.

## Usage

### Login

1. Click the Wegent icon in your browser toolbar
2. Enter your Wegent server URL (e.g., `https://wegent.example.com`)
3. Sign in with your username and password

### Send to Chat

1. Select text on any webpage (or use "Full Page" mode)
2. Click the Wegent icon
3. Type your question about the content
4. Click "Send and Open Chat" to start a conversation

**Via Context Menu:**
- Select text on a webpage
- Right-click and select "Send to Wegent Chat"

### Add to Knowledge Base

1. Select text or extract full page content
2. Click the Wegent icon
3. Expand "Add to Knowledge Base" section
4. Select your target knowledge base
5. Click "Add to Knowledge Base"

**Via Context Menu:**
- Select text on a webpage
- Right-click and select "Add to Wegent Knowledge Base"

### Settings

Click the gear icon in the header to access settings:
- **Server URL**: Configure your Wegent server address
- **Default Extraction Mode**: Choose between "Selected Text" or "Full Page"

## Development

### Prerequisites

- Node.js 18+
- npm or yarn

### Setup

```bash
cd browser-extension
npm install
```

### Development Build

```bash
npm run dev
```

### Production Build

```bash
# Chrome/Edge
npm run build:chrome

# Safari (requires additional Xcode setup)
npm run build:safari
```

### Project Structure

```
browser-extension/
├── shared/                  # Shared code between browsers
│   ├── api/                 # Wegent API client
│   ├── extractor/           # Web content extraction
│   ├── storage/             # Cross-browser storage
│   └── utils/               # Utility functions
├── chrome/                  # Chrome/Edge extension
│   ├── popup/               # React popup UI
│   ├── service-worker.ts    # Background script
│   ├── content-script.ts    # Content extraction
│   └── manifest.json        # Extension manifest
├── safari/                  # Safari extension wrapper
└── dist/                    # Build output
```

## Tech Stack

- **Build**: Vite + TypeScript
- **UI**: React 18 + Tailwind CSS
- **Content Extraction**: @mozilla/readability + Turndown
- **Cross-browser**: webextension-polyfill
- **WebSocket**: socket.io-client

## Design

The extension follows Wegent's Calm UI design principles:
- **Primary Color**: Teal (#14B8A6)
- **Low saturation, low contrast**: Easy on the eyes
- **Minimal shadows**: Clean, flat design
- **Generous whitespace**: Uncluttered interface

## License

Apache-2.0
