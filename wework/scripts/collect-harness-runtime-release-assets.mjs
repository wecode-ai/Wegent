import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function collectHarnessRuntimeReleaseAssets(inputDirectory, outputDirectory, catalog) {
  const input = resolve(inputDirectory)
  const output = resolve(outputDirectory)
  await mkdir(output, { recursive: true })
  const descriptors =
    catalog?.runtimes ??
    (await Promise.all(
      (await readdir(input))
        .filter(name => /^harness-runtime-.+\.json$/.test(name))
        .sort()
        .map(async name => JSON.parse(await readFile(join(input, name), 'utf8')))
    ))
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    throw new Error(`Harness Runtime assets are unavailable: ${input}`)
  }
  for (const descriptor of descriptors) await collectRuntime(input, output, descriptor)
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
  const [input, output, catalogPath] = process.argv.slice(2)
  if (!input || !output) {
    throw new Error(
      'Usage: collect-harness-runtime-release-assets.mjs <runtime-assets> <output-directory> [runtime-catalog]'
    )
  }
  await collectHarnessRuntimeReleaseAssets(
    input,
    output,
    catalogPath ? JSON.parse(await readFile(catalogPath, 'utf8')) : undefined
  )
}
