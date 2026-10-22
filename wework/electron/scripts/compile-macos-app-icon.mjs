import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { acquireProcessLock } from '../../scripts/lib/process-lock.mjs'
import macosAppIcon from './macos-app-icon.cjs'

export async function compileMacosAppIcon({
  icon = macosAppIcon.icon,
  assetCatalog = macosAppIcon.assetCatalog,
} = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('Compiling the macOS app icon requires macOS and Xcode')
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'wework-app-icon-'))
  const metadataPath = join(dirname(assetCatalog), 'app-icon.json')
  let releaseLock
  try {
    await mkdir(dirname(assetCatalog), { recursive: true })
    releaseLock = await acquireProcessLock(`${assetCatalog}.lock`)
    const compiledCatalog = await buildCatalog(temporaryRoot, icon)
    const bytes = await readFile(compiledCatalog)
    const sha256 = data => createHash('sha256').update(data).digest('hex')
    const metadata = {
      iconName: macosAppIcon.extendInfo.CFBundleIconName,
      sourceSha256: sha256(await readFile(icon)),
      catalogSha256: sha256(bytes),
    }
    // Publish complete files before either parallel release build can consume them.
    await writeFile(`${assetCatalog}.tmp`, bytes)
    await rename(`${assetCatalog}.tmp`, assetCatalog)
    await writeFile(`${metadataPath}.tmp`, `${JSON.stringify(metadata, null, 2)}\n`)
    await rename(`${metadataPath}.tmp`, metadataPath)
    return { assetCatalog, metadataPath }
  } finally {
    await releaseLock?.()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function buildCatalog(temporaryRoot, icon) {
  const iconName = macosAppIcon.extendInfo.CFBundleIconName
  const catalog = join(temporaryRoot, 'Assets.xcassets')
  const iconset = join(temporaryRoot, 'Wework.iconset')
  const appiconset = join(catalog, `${iconName}.appiconset`)
  const output = join(temporaryRoot, 'output')
  await mkdir(catalog)
  await mkdir(output)
  execFileSync('iconutil', ['-c', 'iconset', icon, '-o', iconset])
  await rename(iconset, appiconset)
  const info = { version: 1, author: 'xcode' }
  const images = [16, 32, 128, 256, 512].flatMap(size =>
    [1, 2].map(scale => ({
      idiom: 'mac',
      size: `${size}x${size}`,
      scale: `${scale}x`,
      filename: `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`,
    }))
  )
  await writeFile(join(catalog, 'Contents.json'), JSON.stringify({ info }))
  await writeFile(join(appiconset, 'Contents.json'), JSON.stringify({ images, info }))
  execFileSync(
    'xcrun',
    [
      'actool',
      catalog,
      '--compile',
      output,
      '--app-icon',
      iconName,
      '--output-partial-info-plist',
      join(output, 'Info.plist'),
      '--platform',
      'macosx',
      '--target-device',
      'mac',
      '--minimum-deployment-target',
      '10.13',
      '--output-format',
      'human-readable-text',
    ],
    { stdio: 'inherit' }
  )
  const compiledCatalog = join(output, 'Assets.car')
  execFileSync('xcrun', ['assetutil', '--validate-file', compiledCatalog])
  return compiledCatalog
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await compileMacosAppIcon()
}
