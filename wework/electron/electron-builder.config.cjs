const path = require('node:path')

const { resolveBuildIdentity } = require('./scripts/build-identity.cjs')

const updateBaseUrl =
  process.env.WEWORK_UPDATE_BASE_URL ||
  'https://github.com/wecode-ai/Wegent/releases/download/wework-updater'
const identity = resolveBuildIdentity()
const useCustomMacosNotarization =
  process.env.WEWORK_CUSTOM_MACOS_NOTARIZATION?.trim().toLowerCase() === 'true'
const onlineUpdateBuild = process.env.WEWORK_ONLINE_UPDATE_BUILD?.trim().toLowerCase() === 'true'
const onlineUpdateIncludesComponents =
  process.env.WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS?.trim().toLowerCase() === 'true'
const artifactPrefix = onlineUpdateBuild ? 'WeWorkHostUpdate' : 'WeWork'
const managedComponentResources = [
  { from: 'resources/harness-runtime', to: 'harness-runtime' },
  { from: 'resources/bin', to: 'bin' },
  { from: 'resources/codex', to: 'codex' },
  { from: 'resources/wework-core-plugins', to: 'wework-core-plugins' },
  { from: 'resources/wework-app-static', to: 'wework-app-static' },
  { from: 'resources/bundled-plugins', to: 'bundled-plugins' },
]

module.exports = {
  appId: identity.identifier,
  productName: identity.productName,
  executableName: identity.executableName,
  compression: onlineUpdateBuild ? 'store' : 'normal',
  extraMetadata: {
    name: identity.packageName,
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
    output: onlineUpdateBuild ? 'release-online-update' : 'release-installer',
  },
  files: ['dist/**/*', 'package.json'],
  asar: true,
  asarUnpack: ['**/*.{node,dylib,so,dll}'],
  extraResources: [
    ...(!onlineUpdateBuild || onlineUpdateIncludesComponents ? managedComponentResources : []),
    { from: 'resources/components.json', to: 'components.json' },
    { from: '../resources/licenses', to: 'licenses' },
    { from: '../resources/icons', to: 'icons' },
    { from: '../../LICENSE', to: 'LICENSE' },
  ],
  publish: {
    provider: 'generic',
    url: updateBaseUrl,
  },
  ...(useCustomMacosNotarization
    ? { afterSign: path.resolve(__dirname, 'scripts/notarize-macos.cjs') }
    : {}),
  mac: {
    artifactName: `${artifactPrefix}_\${version}_macos_\${arch}.\${ext}`,
    category: 'public.app-category.developer-tools',
    electronLanguages: ['en', 'zh_CN'],
    hardenedRuntime: true,
    ...(useCustomMacosNotarization ? { notarize: false } : {}),
    icon: path.resolve(__dirname, '../resources/icons/icon.icns'),
    signIgnore: process.env.APPLE_SIGNING_IDENTITY
      ? managedComponentResources.map(resource => '/Contents/Resources/' + resource.to + '/')
      : ['/Contents/Resources/wework-core-plugins/'],
    target: onlineUpdateBuild ? ['zip'] : ['dmg', 'zip'],
  },
  dmg: {
    sign: false,
  },
  win: {
    artifactName: `${artifactPrefix}_\${version}_windows_\${arch}-setup.\${ext}`,
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
    artifactName: `${artifactPrefix}_\${version}_linux_\${arch}.\${ext}`,
    category: 'Development',
    electronLanguages: ['en-US', 'zh-CN'],
    target: ['AppImage'],
  },
}
