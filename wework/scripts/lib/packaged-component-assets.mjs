import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { create } from 'tar'
import { hashComponentPath } from './component-content-hash.mjs'
import { componentReleaseScope, MANAGED_COMPONENT_IDS } from '../desktop-component-release.mjs'
import { extractRuntimeArchive } from './extract-runtime-archive.mjs'

export function deliveredPackagePaths(installerRoot, platform, arch) {
  const directories = {
    macos: { arm64: 'mac-arm64', x64: 'mac' },
    windows: { arm64: 'win-arm64-unpacked', x64: 'win-unpacked' },
    linux: { arm64: 'linux-arm64-unpacked', x64: 'linux-unpacked' },
  }
  const directory = directories[platform]?.[arch]
  if (!directory) throw new Error(`Unsupported delivered package: ${platform}/${arch}`)
  const appRoot = join(installerRoot, directory, ...(platform === 'macos' ? ['WeWork.app'] : []))
  return {
    appRoot,
    resourcesRoot: join(
      appRoot,
      ...(platform === 'macos' ? ['Contents', 'Resources'] : ['resources'])
    ),
  }
}

/** Archive the signed files shipped in the application, never mutable build inputs. */
export async function preparePackagedComponentAssets({
  resourcesRoot,
  version,
  platform,
  arch,
  output,
}) {
  const packaged = JSON.parse(await readFile(join(resourcesRoot, 'components.json'), 'utf8'))
  if (
    packaged.schemaVersion !== 1 ||
    packaged.appVersion !== version ||
    !/^[0-9a-f]{40,64}$/.test(packaged.sourceSha)
  )
    throw new Error('Delivered component manifest does not match the release')
  await mkdir(output, { recursive: true })
  const components = {}
  for (const id of MANAGED_COMPONENT_IDS) {
    const component = packaged.components?.[id]
    if (
      typeof component?.path !== 'string' ||
      !component.path ||
      typeof component.version !== 'string' ||
      !component.version.trim() ||
      !/^[0-9a-f]{64}$/.test(component.sha256)
    )
      throw new Error(`Packaged component metadata is incomplete: ${id}`)
    if (
      componentReleaseScope(id) === 'version' &&
      component.version !== `wework-${packaged.sourceSha.slice(0, 12)}`
    )
      throw new Error(`Packaged component version does not match the release: ${id}`)
    components[id] = await archiveComponent({
      component,
      id,
      resourcesRoot,
      platform,
      arch,
      output,
    })
  }
  const manifest = {
    schemaVersion: 1,
    appVersion: packaged.appVersion,
    sourceSha: packaged.sourceSha,
    platform,
    arch,
    components,
  }
  await writeFile(
    join(output, `components-${platform}-${arch}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  return manifest
}

async function archiveComponent({ component, id, resourcesRoot, platform, arch, output }) {
  const sourcePath = resolve(resourcesRoot, component.archive?.path ?? component.path)
  if (!sourcePath.startsWith(resolve(resourcesRoot) + sep))
    throw new Error(`Packaged component path escapes the application: ${id}`)
  const source = await stat(sourcePath)
  if (!source.isDirectory() && !source.isFile())
    throw new Error(`Component source is unavailable: ${sourcePath}`)
  const temporary = join(output, `.component-${id}.tar.gz`)
  let contentSha256
  let entryPath
  if (component.archive) {
    const archive = component.archive
    if (
      !source.isFile() ||
      !Number.isSafeInteger(archive.bytes) ||
      archive.bytes <= 0 ||
      source.size !== archive.bytes ||
      !/^[a-f0-9]{64}$/.test(archive.sha256) ||
      (await hashComponentPath(sourcePath)) !== archive.sha256
    )
      throw new Error(`Packaged component archive integrity mismatch: ${id}`)
    const checked = await mkdtemp(join(output, `.verify-${id}-`))
    try {
      await extractRuntimeArchive(sourcePath, checked)
      contentSha256 = await hashComponentPath(checked)
      if (contentSha256 !== component.sha256)
        throw new Error(`Packaged component checksum mismatch: ${id}`)
    } finally {
      await rm(checked, { recursive: true, force: true })
    }
    await cp(sourcePath, temporary)
    entryPath = '.'
  } else {
    contentSha256 = await hashComponentPath(sourcePath)
    if (contentSha256 !== component.sha256)
      throw new Error(`Packaged component checksum mismatch: ${id}`)
    await create(
      {
        cwd: source.isDirectory() ? sourcePath : dirname(sourcePath),
        file: temporary,
        gzip: true,
        mtime: new Date(0),
        portable: true,
      },
      source.isDirectory() ? ['.'] : [basename(sourcePath)]
    )
    entryPath = source.isDirectory() ? '.' : basename(sourcePath)
  }
  const archiveSha256 = await hashComponentPath(temporary)
  const assetName = `WeworkComponent_${id}_${archiveSha256}_${platform}_${arch}.tar.gz`
  await rename(temporary, join(output, assetName))
  return {
    version: component.version,
    contentSha256,
    archiveSha256,
    assetName,
    releaseScope: componentReleaseScope(id),
    entryPath,
  }
}
