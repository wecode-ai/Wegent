# Safari Extension

This directory contains the Safari Web Extension wrapper for the Wegent browser extension.

## ⚠️ Important: Safari Extension Loading

**Safari cannot directly load the `dist/chrome` or `dist/safari` directory like Chrome can.**

Safari Web Extensions require an Xcode project wrapper. You must use Apple's `safari-web-extension-converter` tool to convert the Chrome extension into a Safari-compatible Xcode project.

## Building for Safari

### Prerequisites

- macOS with Xcode 14+
- Safari 16+
- Command Line Tools installed (`xcode-select --install`)

### Quick Build (Recommended)

Run the following command from the `browser-extension` directory:

```bash
npm run build:safari
```

This will:
1. Build the Chrome extension to `dist/chrome`
2. Convert it to a Safari Xcode project at `safari/WegentExtension`

### Manual Steps

If you prefer to run the steps manually:

1. Build the Chrome extension first:
   ```bash
   cd browser-extension
   npm install
   npm run build:chrome
   ```

2. Convert to Safari extension using Safari's conversion tool:
   ```bash
   xcrun safari-web-extension-converter dist/chrome \
     --project-location safari/WegentExtension \
     --app-name Wegent \
     --bundle-identifier io.wecode.wegent \
     --no-prompt
   ```

3. Open the generated Xcode project:
   ```bash
   open safari/WegentExtension/Wegent/Wegent.xcodeproj
   ```

### Xcode Configuration

In Xcode:
1. Select the project in the navigator
2. Update the bundle identifier if needed (default: `io.wecode.wegent`)
3. Configure signing:
   - Select your development team
   - Enable "Automatically manage signing"
4. Build and run (⌘R)

## Testing in Safari

1. Enable Developer menu in Safari:
   - Safari → Settings → Advanced → "Show Develop menu in menu bar"

2. Allow unsigned extensions:
   - Develop → Allow Unsigned Extensions

3. Enable the extension:
   - Safari → Settings → Extensions → Enable "Wegent"

## Troubleshooting

### "Cannot load extension" error
- Make sure you're loading the Xcode-built app, not the raw `dist/chrome` directory
- Safari requires extensions to be packaged as macOS apps

### Extension not appearing in Safari
- Run the app from Xcode at least once
- Check Safari → Settings → Extensions

### Service worker issues
- Safari 16.4+ supports service workers in extensions
- For older Safari versions, the converter may create a background page instead

## Distribution

### For Development
- Build and run from Xcode
- Allow unsigned extensions in Safari Developer menu

### For App Store
1. Create an App ID in Apple Developer Portal
2. Configure the Xcode project with proper certificates
3. Archive and submit through App Store Connect

### For Direct Distribution
1. Export the app as a signed `.app` bundle
2. Notarize with Apple for macOS distribution
