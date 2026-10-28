import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { create } from 'tar'

export async function portableDesktopRelease({
  appRoot,
  version,
  platform,
  arch,
  executableName = 'WeWork',
  output,
  fixture = false,
}) {
  const stage = await mkdtemp(join(tmpdir(), 'wework-portable-release-'))
  try {
    const directory = platform === 'macos' ? basename(appRoot) : 'application'
    await cp(appRoot, join(stage, directory), { recursive: true, verbatimSymlinks: true })
    const executable =
      platform === 'macos'
        ? `${directory}/Contents/MacOS/${executableName}`
        : `${directory}/${executableName}${platform === 'windows' ? '.exe' : ''}`
    const resources =
      platform === 'macos' ? `${directory}/Contents/Resources` : `${directory}/resources`
    const packaged = JSON.parse(await readFile(join(stage, resources, 'components.json'), 'utf8'))
    if (packaged.appVersion !== version)
      throw new Error('Portable package version does not match its component manifest')
    const { dataSchema, readableDataSchemas } = packaged
    if (
      !Number.isSafeInteger(dataSchema) ||
      dataSchema < 1 ||
      !Array.isArray(readableDataSchemas) ||
      !readableDataSchemas.includes(dataSchema)
    )
      throw new Error('Portable package data compatibility is invalid')
    await stat(join(stage, executable))
    await writeFile(
      join(stage, 'wework-release.json'),
      JSON.stringify({
        schemaVersion: 1,
        version,
        executable,
        resources,
        fixture,
        dataSchema,
        sourceSha: packaged.sourceSha,
      })
    )
    await mkdir(output, { recursive: true })
    const path = join(output, `WeWorkRelease_${version}_${platform}_${arch}.tar.gz`)
    await create({ cwd: stage, file: path, gzip: true, portable: true }, [
      'wework-release.json',
      directory,
    ])
    return {
      path,
      name: basename(path),
      version,
      platform,
      arch,
      sha256: await hashReleaseAsset(path),
      bytes: (await stat(path)).size,
      sourceSha: packaged.sourceSha,
      dataSchema,
      readableDataSchemas,
      fixture,
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

export async function hashReleaseAsset(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}
