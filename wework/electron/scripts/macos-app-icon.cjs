const path = require('node:path')

// Register the existing artwork as a catalog icon so macOS does not wrap the
// already rounded ICNS image in another background. Keep the ICNS for consumers
// that read standalone icons, including the DMG and older macOS releases.
module.exports = {
  icon: path.resolve(__dirname, '../../resources/icons/icon.icns'),
  assetCatalog: path.resolve(__dirname, '../resources/macos/Assets.car'),
  extendInfo: { CFBundleIconName: 'Wework' },
  async prepare(context) {
    if (context.electronPlatformName !== 'darwin') return
    const { compileMacosAppIcon } = await import('./compile-macos-app-icon.mjs')
    await compileMacosAppIcon()
  },
}
