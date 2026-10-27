const path = require('node:path')

module.exports = async function afterSign(context) {
  if (context.electronPlatformName === 'win32') {
    const { finalizeWindowsVersionPackage } = await import('./windows-version-package.mjs')
    const launcherPath = path.join(context.appOutDir, 'resources', 'bin', 'wework-launcher.exe')
    // electron-builder does not sign executables copied through extraResources.
    // Sign once before hashing, then use identical bytes for the stable launcher.
    await context.packager.signAndEditResources(launcherPath, context.arch, context.outDir)
    await finalizeWindowsVersionPackage({
      appOutDir: context.appOutDir,
      version: context.packager.appInfo.version,
      arch: context.arch === 1 ? 'x64' : String(context.arch),
      executableName: context.packager.appInfo.productFilename,
      launcherPath,
    })
  } else if (
    context.electronPlatformName === 'darwin' &&
    process.env.WEWORK_CUSTOM_MACOS_NOTARIZATION?.trim().toLowerCase() === 'true'
  ) {
    await require('./notarize-macos.cjs')(context)
  }
}
