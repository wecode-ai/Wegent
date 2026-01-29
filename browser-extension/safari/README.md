# Safari Extension

This directory contains the Safari Web Extension wrapper for the Wegent browser extension.

## Building for Safari

Safari Web Extensions require an Xcode project wrapper. To create the Safari version:

### Prerequisites

- macOS with Xcode 14+
- Safari 16+

### Steps

1. Build the Chrome extension first:
   ```bash
   cd browser-extension
   npm install
   npm run build:chrome
   ```

2. Convert to Safari extension using Safari's conversion tool:
   ```bash
   xcrun safari-web-extension-converter dist/chrome --project-location safari/WegentExtension
   ```

3. Open the generated Xcode project:
   ```bash
   open safari/WegentExtension/Wegent.xcodeproj
   ```

4. In Xcode:
   - Update the bundle identifier to `io.wecode.wegent.safari-extension`
   - Configure signing and capabilities
   - Build and run

### Manual Setup (Alternative)

If you prefer to create the project manually:

1. Create a new Safari Web Extension project in Xcode
2. Copy the contents from `dist/chrome` to the `Resources` folder
3. Update `manifest.json` for Safari compatibility
4. Configure the project settings

## Safari-specific Considerations

### Manifest Differences

Safari Web Extensions use Manifest V2 with some V3 features. The conversion tool handles most differences, but you may need to adjust:

- Background scripts (service workers are supported in Safari 16.4+)
- Permission declarations
- Content Security Policy

### Testing

1. Enable Developer menu in Safari Preferences
2. Allow unsigned extensions in Develop menu
3. Enable the extension in Safari Extensions preferences

## Distribution

For App Store distribution:
1. Create an App ID in Apple Developer Portal
2. Configure the Xcode project with proper certificates
3. Submit through App Store Connect

For direct distribution:
1. Export the extension as a `.safariextz` file
2. Notarize with Apple for macOS
