const path = require('node:path')

const { resolveAppUpdateConfiguration } = require('./scripts/app-update-config.cjs')
const { resolveBuildIdentity } = require('./scripts/build-identity.cjs')
const { resolveReleaseVersion } = require('./scripts/release-version.cjs')

const packageMetadata = require('./package.json')
const appUpdateConfiguration = resolveAppUpdateConfiguration(packageMetadata.name)
const updateBaseUrl = appUpdateConfiguration.url
const electronMirror = process.env.WEWORK_ELECTRON_MIRROR?.trim()
const identity = resolveBuildIdentity()
const releaseVersion = resolveReleaseVersion(packageMetadata.version)
const packagePrebuiltMacosRelease =
  process.env.WEWORK_PREPACKAGED_MACOS_RELEASE?.trim().toLowerCase() === 'true'
const skipMacosNotarization =
  process.env.WEWORK_SKIP_MACOS_NOTARIZATION?.trim().toLowerCase() === 'true'
const useCustomMacosNotarization =
  !packagePrebuiltMacosRelease &&
  !skipMacosNotarization &&
  process.env.WEWORK_CUSTOM_MACOS_NOTARIZATION?.trim().toLowerCase() === 'true'

module.exports = {
  appId: identity.identifier,
  productName: identity.productName,
  executableName: identity.executableName,
  extraMetadata: {
    version: releaseVersion,
    weworkUpdateBaseUrl: updateBaseUrl,
    weworkAppId: identity.identifier,
    weworkProductName: identity.productName,
    weworkExecutableName: identity.executableName,
    ...(identity.executorNamespace ? { weworkExecutorNamespace: identity.executorNamespace } : {}),
    ...(identity.backendUrl ? { weworkBackendUrl: identity.backendUrl } : {}),
    ...(identity.socketUrl ? { weworkSocketUrl: identity.socketUrl } : {}),
  },
  directories: {
    buildResources: 'build',
    output: 'release-installer',
  },
  ...(electronMirror
    ? {
        electronDownload: {
          mirror: electronMirror.endsWith('/') ? electronMirror : `${electronMirror}/`,
        },
      }
    : {}),
  files: ['dist/**/*', 'package.json'],
  asar: true,
  asarUnpack: ['**/*.{node,dylib,so,dll}'],
  extraResources: [
    { from: 'resources/harness-runtime', to: 'harness-runtime' },
    { from: 'resources/bin', to: 'bin' },
    { from: 'resources/codex', to: 'codex' },
    { from: 'resources/wework-core-plugins', to: 'wework-core-plugins' },
    { from: 'resources/components.json', to: 'components.json' },
    { from: 'resources/app-update.yml', to: 'app-update.yml' },
    { from: 'resources/bundled-plugins', to: 'bundled-plugins' },
    { from: 'resources/bundled-hooks', to: 'bundled-hooks' },
    { from: '../resources/licenses', to: 'licenses' },
    { from: '../resources/icons', to: 'icons' },
    { from: 'resources/vnc', to: 'vnc' },
  ],
  publish: {
    provider: 'generic',
    url: updateBaseUrl,
  },
  ...(useCustomMacosNotarization
    ? { afterSign: path.resolve(__dirname, 'scripts/notarize-macos.cjs') }
    : {}),
  mac: {
    artifactName: 'WeWork_${version}_macos_${arch}.${ext}',
    category: 'public.app-category.developer-tools',
    electronLanguages: ['en', 'zh_CN'],
    hardenedRuntime: true,
    ...(useCustomMacosNotarization || packagePrebuiltMacosRelease || skipMacosNotarization
      ? { notarize: false }
      : {}),
    icon: path.resolve(__dirname, '../resources/icons/icon.icns'),
    signIgnore: ['/Contents/Resources/wework-core-plugins/'],
    target: ['dmg', 'zip'],
  },
  dmg: {
    sign: false,
  },
  win: {
    artifactName: 'WeWork_${version}_windows-${arch}-setup.${ext}',
    electronLanguages: ['en-US', 'zh-CN'],
    icon: path.resolve(__dirname, '../resources/icons/icon.ico'),
    target: ['nsis'],
  },
  nsis: {
    oneClick: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    include: 'scripts/installer.nsh',
  },
  linux: {
    artifactName: 'WeWork_${version}_linux_${arch}.${ext}',
    category: 'Development',
    electronLanguages: ['en-US', 'zh-CN'],
    target: ['AppImage'],
  },
}
