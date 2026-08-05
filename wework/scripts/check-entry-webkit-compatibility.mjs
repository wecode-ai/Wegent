import { parse } from 'acorn'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(scriptDir, '../dist')
const indexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')
const entryMatch = indexHtml.match(/<script[^>]+src="([^"]+\.js)"/)

if (!entryMatch) {
  throw new Error('Unable to find the JavaScript entry bundle in dist/index.html')
}

const foundSyntax = []

for (const assetFile of fs.readdirSync(path.join(distDir, 'assets'))) {
  if (!assetFile.endsWith('.js')) continue

  const assetSource = fs.readFileSync(path.join(distDir, 'assets', assetFile), 'utf8')
  visit(
    parse(assetSource, { ecmaVersion: 'latest', sourceType: 'module', locations: true }),
    assetFile
  )
}

if (foundSyntax.length > 0) {
  throw new Error(`Desktop bundles contain RegExp lookbehind: ${foundSyntax.join(', ')}`)
}

function visit(node, assetFile) {
  if (!node || typeof node !== 'object') return

  if (
    node.type === 'Literal' &&
    node.regex &&
    (node.regex.pattern.includes('(?<=') || node.regex.pattern.includes('(?<!'))
  ) {
    foundSyntax.push(`${assetFile}:${node.loc.start.line}`)
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => visit(child, assetFile))
    else visit(value, assetFile)
  }
}
