const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdtemp, readFile, rm, rmdir } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

// Exercise the same bootstrap binary and protocol used before Electron is ready.
module.exports = async function verifyWindowsMigrationLock(context) {
  if (context.electronPlatformName !== 'win32') return
  const resources = join(context.appOutDir, 'resources')
  const executor = join(resources, 'bin', 'wegent-executor.exe')
  const manifest = JSON.parse(await readFile(join(resources, 'components.json'), 'utf8'))
  const { hashComponentPath } = await import('../../scripts/lib/component-content-hash.mjs')
  const component = manifest.components?.executor
  const digest = await hashComponentPath(join(resources, component.path))
  if (digest !== manifest.components?.executor?.sha256) {
    throw new Error('Packaged Windows migration executor checksum mismatch')
  }
  if (!Array.isArray(manifest.windowsRuntime))
    throw new Error('Packaged Windows app-local runtime metadata is missing')
  for (const file of manifest.windowsRuntime) {
    const { isAbsolute, resolve, sep } = require('node:path')
    const path = resolve(resources, file.path)
    if (isAbsolute(file.path) || !path.startsWith(resolve(resources) + sep))
      throw new Error('Packaged Windows app-local runtime path is invalid')
    const digest = createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
    if (digest !== file.sha256)
      throw new Error(`Packaged Windows app-local runtime checksum mismatch: ${file.path}`)
  }
  const directory = await mkdtemp(join(tmpdir(), 'wework-packaged-migration-'))
  const lockFile = join(directory, 'startup.lock')
  try {
    const result = spawnSync(
      executor,
      ['--workbench-lock', JSON.stringify([lockFile]), '--version', '--workbench-lock-wait'],
      {
        input: '',
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
        },
      }
    )
    if (
      result.error ||
      result.status !== 0 ||
      result.stdout.trim() !== '{"protocol_version":1,"locked":true}'
    ) {
      throw new Error('Packaged Windows migration executor failed the startup lock check')
    }
    console.log('Verified packaged Windows startup migration lock and executor checksum')
  } finally {
    await rm(lockFile, { force: true })
    await rmdir(directory)
  }
}
