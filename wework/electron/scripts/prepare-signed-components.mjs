import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { hashComponentPath } from '../../scripts/lib/component-content-hash.mjs'

const execute = promisify(execFile)
const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function reuseSignedComponent({ source, cacheRoot, identity, policy, sign, verify }) {
  const inputSha256 = await hashComponentPath(source)
  const key = createHash('sha256')
    .update(JSON.stringify({ inputSha256, identity, policy }))
    .digest('hex')
  const root = join(cacheRoot, key)
  const cached = join(root, 'content')
  const metadata = await readFile(join(root, 'metadata.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (metadata !== null) {
    const record = JSON.parse(metadata)
    if (record.key !== key || record.sha256 !== (await hashComponentPath(cached))) {
      throw new Error(`Signed component cache integrity failure: ${key}`)
    }
    await verify(cached)
    await rm(source, { recursive: true, force: true })
    await cp(cached, source, { recursive: true, preserveTimestamps: true })
    return record.sha256
  }
  await sign(source)
  await verify(source)
  const sha256 = await hashComponentPath(source)
  await mkdir(cacheRoot, { recursive: true })
  const temporary = `${root}.${process.pid}.tmp`
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary)
  try {
    await cp(source, join(temporary, 'content'), { recursive: true, preserveTimestamps: true })
    await writeFile(join(temporary, 'metadata.json'), JSON.stringify({ key, sha256 }))
    await rename(temporary, root)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return sha256
}

export async function prepareSignedComponents(environment = process.env) {
  if (process.platform !== 'darwin' || !environment.APPLE_SIGNING_IDENTITY) return
  const identity = environment.APPLE_SIGNING_IDENTITY
  const resources = join(electronRoot, 'resources')
  const manifestPath = join(resources, 'components.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const toolchain = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8'))
  const policy = {
    version: 1,
    platform: 'darwin',
    arch: environment.WEWORK_RELEASE_ARCH || process.arch,
    builder: toolchain.devDependencies['electron-builder'],
    flags: ['--timestamp', '--options', 'runtime'],
  }
  for (const [id, component] of Object.entries(manifest.components)) {
    if (!component.path) continue
    component.sha256 = await reuseSignedComponent({
      source: join(resources, component.path),
      cacheRoot: resolve(
        environment.WEWORK_SIGNED_COMPONENT_CACHE ||
          join(electronRoot, '.cache', 'signed-components')
      ),
      identity,
      policy,
      sign: async source => {
        for (const file of await machOFiles(source)) {
          await execute('codesign', [
            '--force',
            '--sign',
            identity,
            '--timestamp',
            '--options',
            'runtime',
            file,
          ])
        }
      },
      verify: async source => {
        for (const file of await machOFiles(source)) {
          await execute('codesign', ['--verify', '--strict', file])
        }
      },
    })
    console.log(`[components] prepared immutable ${id}: ${component.sha256}`)
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function machOFiles(source) {
  if ((await stat(source)).isDirectory()) {
    const paths = await Promise.all(
      (await readdir(source)).sort().map(name => machOFiles(join(source, name)))
    )
    return paths.flat()
  }
  const handle = await open(source, 'r')
  try {
    const buffer = Buffer.alloc(4)
    const { bytesRead } = await handle.read(buffer, 0, 4, 0)
    return bytesRead === 4 &&
      [
        0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf,
        0xbfbafeca,
      ].includes(buffer.readUInt32BE(0))
      ? [source]
      : []
  } finally {
    await handle.close()
  }
}
