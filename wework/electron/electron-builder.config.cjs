const path = require('node:path')

const updateBaseUrl =
  process.env.WEWORK_UPDATE_BASE_URL ||
  'https://github.com/wecode-ai/Wegent/releases/download/wework-updater'

module.exports = {
  appId: 'io.wecode.wework',
  productName: 'WeWork',
  directories: {
    buildResources: 'build',
    output: 'release-installer',
  },
  files: ['dist/**/*', 'package.json'],
  asar: true,
  asarUnpack: ['**/*.node'],
  extraResources: [
    { from: 'resources/harness-runtime', to: 'harness-runtime' },
    { from: 'resources/node-runtime', to: 'node-runtime' },
    { from: 'resources/bin', to: 'bin' },
    { from: 'resources/bundled-plugins', to: 'bundled-plugins' },
    { from: '../resources/icons', to: 'icons' },
  ],
  publish: {
    provider: 'generic',
    url: updateBaseUrl,
  },
  mac: {
    artifactName: 'WeWork_${version}_macos_${arch}.${ext}',
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    icon: path.resolve(__dirname, '../resources/icons/icon.icns'),
    target: ['dmg', 'zip'],
  },
  dmg: {
    sign: false,
  },
  win: {
    artifactName: 'WeWork_${version}_windows_${arch}-setup.${ext}',
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
    target: ['AppImage'],
  },
}
