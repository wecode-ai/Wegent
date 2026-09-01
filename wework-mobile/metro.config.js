const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
const paperIconModule = path.resolve(__dirname, 'src/components/PaperMaterialIcon.tsx')

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (/(^|\/)MaterialCommunityIcons(?:\.js)?$/.test(moduleName)) {
    return context.resolveRequest(context, paperIconModule, platform)
  }

  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
