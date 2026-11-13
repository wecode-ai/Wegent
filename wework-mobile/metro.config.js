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
  if (/(^|\/)MaterialCommunityIcons(?:\.js)?$/.test(moduleName)) {
    return context.resolveRequest(context, paperIconModule, platform)
  }

  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
