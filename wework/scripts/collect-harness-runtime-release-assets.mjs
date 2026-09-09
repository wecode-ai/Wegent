import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extract } from 'tar'

const CORE_COMPONENT_PATTERN = /^WeworkComponent_coreDsh_.+\.tar\.gz$/

export async function collectHarnessRuntimeReleaseAssets(inputDirectory, outputDirectory) {
  const input = resolve(inputDirectory)
  const output = resolve(outputDirectory)
  await mkdir(output, { recursive: true })
  const componentArchives = (await readdir(input))
    .filter(name => CORE_COMPONENT_PATTERN.test(name))
    .sort()
  if (componentArchives.length === 0) {
    throw new Error(`Core DSH component assets are unavailable: ${input}`)
  }
  for (const archive of componentArchives) {
    await collectComponentArchive(join(input, archive), output)
  }
}

async function collectComponentArchive(archive, output) {
  const temporary = await mkdtemp(join(tmpdir(), 'wework-harness-runtime-release-'))
  try {
    await extract({ cwd: temporary, file: archive, strict: true })
    const catalog = JSON.parse(await readFile(join(temporary, 'runtimes.json'), 'utf8'))
    if (!Array.isArray(catalog.runtimes) || catalog.runtimes.length === 0) {
      throw new Error(`Harness Runtime catalog is invalid: ${archive}`)
    }
    for (const descriptor of catalog.runtimes) {
      await collectRuntime(temporary, output, descriptor)
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function collectRuntime(sourceRoot, output, descriptor) {
  const assetName = descriptor?.assetName
  if (typeof assetName !== 'string' || basename(assetName) !== assetName) {
    throw new Error('Harness Runtime asset name is invalid')
  }
  const source = join(sourceRoot, assetName)
  const metadata = await stat(source)
  const archiveSha256 = await fileSha256(source)
  if (descriptor.archiveSha256 !== archiveSha256 || descriptor.archiveBytes !== metadata.size) {
    throw new Error(`Harness Runtime asset does not match its descriptor: ${assetName}`)
  }
  await writeImmutableFile(join(output, assetName), await readFile(source))
  await writeImmutableFile(
    join(output, assetName.replace(/\.tar\.gz$/, '.json')),
    Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`)
  )
}

async function writeImmutableFile(target, content) {
  try {
    const existing = await readFile(target)
    if (!existing.equals(content)) {
      throw new Error(`Conflicting immutable Harness Runtime asset: ${target}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await writeFile(target, content, { flag: 'wx' })
  }
}

async function fileSha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) {
    throw new Error(
      'Usage: collect-harness-runtime-release-assets.mjs <release-assets> <output-directory>'
    )
  }
  await collectHarnessRuntimeReleaseAssets(input, output)
}
