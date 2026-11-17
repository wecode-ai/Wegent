const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
const repositoryRoot = path.resolve(__dirname, '..')
const paperIconModule = path.resolve(__dirname, 'src/components/PaperMaterialIcon.tsx')

// Mobile has its own pnpm workspace but imports the PC client's shared source.
config.watchFolders = [...config.watchFolders, repositoryRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(repositoryRoot, 'node_modules'),
]

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // NodeNext imports name emitted JavaScript; Metro consumes the shared TypeScript source.
  if (
    moduleName === './model-configuration-contract.js' &&
    context.originModulePath ===
      path.join(repositoryRoot, 'wework/electron/src/host/model-configuration-validation.ts')
  ) {
    return context.resolveRequest(
      context,
      path.join(repositoryRoot, 'wework/electron/src/host/model-configuration-contract.ts'),
      platform
    )
  }

  // Shared PC hooks must use the same React instance as the native renderer.
  if (moduleName === 'react' || moduleName.startsWith('react/')) {
    return context.resolveRequest(
      context,
      require.resolve(moduleName, { paths: [__dirname] }),
      platform
    )
  }

  if (/(^|\/)MaterialCommunityIcons(?:\.js)?$/.test(moduleName)) {
    return context.resolveRequest(context, paperIconModule, platform)
  }

  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
