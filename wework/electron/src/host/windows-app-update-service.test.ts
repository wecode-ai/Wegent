import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZipArchive } from 'archiver'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WindowsAppUpdateService } from './windows-app-update-service.js'
import { physicalFilesystem } from './physical-filesystem.js'
import { DATA_SCHEMA_VERSION, hashFile, type VersionUpdateFeed } from './version-release.js'

vi.mock('node:child_process', { spy: true })

const { mkdir, mkdtemp, readFile, readdir, rm, writeFile, lstat } = physicalFilesystem.promises

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
})

async function fixture(
  options: {
    missing?: boolean
    extra?: boolean
    zipKind?: 'duplicate' | 'reserved' | 'symlink' | 'oversized'
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'wework-version-update-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const files = {
    'WeWork.exe': 'real version executable fixture',
    'resources/app.asar': 'application fixture',
  }
  const release = {
    schemaVersion: 2,
    version: '0.6.0',
    platform: 'windows',
    arch: 'x64',
    dataSchemaVersion: DATA_SCHEMA_VERSION,
    entryPoint: 'WeWork.exe',
    files: Object.entries(files).map(([path, content]) => ({
      path,
      size: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    })),
  }
  const archive = join(root, 'update.zip')
  const zip = new ZipArchive()
  const stream = createWriteStream(archive)
  const complete = new Promise<void>((resolve, reject) => {
    stream.once('close', resolve)
    stream.once('error', reject)
    zip.once('error', reject)
  })
  zip.pipe(stream)
  zip.append(JSON.stringify(release), { name: 'release.json' })
  for (const [path, content] of Object.entries(files)) {
    if (!options.missing || path !== 'WeWork.exe') zip.append(content, { name: path })
  }
  if (options.extra) zip.append('unlisted executable', { name: 'extra.exe' })
  if (options.zipKind === 'duplicate') zip.append('duplicate', { name: 'resources/APP.ASAR' })
  if (options.zipKind === 'reserved') zip.append('unsafe', { name: 'resources/CON.txt' })
  if (options.zipKind === 'symlink') zip.symlink('resources/linked-file', '../../outside')
  await zip.finalize()
  await complete
  const original = options.zipKind === 'oversized' ? oversizedZip64() : await readFile(archive)
  let payload = original
  let transfers = 0
  let missingFeed = false
  const feed: VersionUpdateFeed = {
    schemaVersion: 2,
    version: '0.6.0',
    platform: 'windows',
    arch: 'x64',
    dataSchemaVersion: DATA_SCHEMA_VERSION,
    url: 'update.zip',
    size: original.length,
    sha512: createHash('sha512').update(original).digest('base64'),
    releaseDate: '2026-10-27T00:00:00Z',
    releaseNotes: 'Reliable updates',
  }
  const server = createServer((request, response) => {
    if (request.url?.includes('-v2.json')) {
      if (missingFeed) {
        response.writeHead(404).end()
        return
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(feed))
    } else if (request.url === '/update.zip') {
      transfers++
      response.end(payload)
    } else response.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No HTTP server address')
  const installation = {
    root: join(root, 'installed'),
    launcher: join(root, 'installed', 'WeWork.exe'),
    version: '0.5.12',
  }
  await mkdir(installation.root)
  const active =
    '{"schemaVersion":2,"active":{"version":"0.5.12","path":"versions/old"},"dataSchemaVersion":1}'
  await writeFile(join(installation.root, 'update-state.json'), active)
  const prepareInstall = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const recoverInstall = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const quit = vi.fn()
  const service = new WindowsAppUpdateService({
    installation,
    arch: 'x64',
    updateBaseUrl: `http://127.0.0.1:${address.port}/`,
    fetch,
    prepareInstall,
    recoverInstall,
    quit,
    launchArgs: [],
    log: vi.fn(),
  })
  return {
    service,
    feed,
    root,
    installation,
    prepareInstall,
    recoverInstall,
    quit,
    active,
    transfers: () => transfers,
    corrupt: () => {
      payload = Buffer.from(original)
      payload[0] ^= 0xff
    },
    truncate: () => {
      payload = original.subarray(0, original.length - 10)
    },
    restore: () => {
      payload = original
    },
    missingFeed: () => {
      missingFeed = true
    },
  }
}

describe('complete Windows version updates over HTTP', () => {
  test('downloads once, verifies a complete candidate, and leaves the active version untouched', async () => {
    const mainAsarFlag = process.noAsar
    const f = await fixture()
    expect(await f.service.check('stable')).toEqual({
      currentVersion: '0.5.12',
      version: '0.6.0',
      body: 'Reliable updates',
    })
    await Promise.all([f.service.download(), f.service.download()])
    expect(f.transfers()).toBe(1)
    expect(f.service.downloadProgress()).toMatchObject({
      phase: 'ready',
      downloadedBytes: f.feed.size,
      totalBytes: f.feed.size,
    })
    const staging = join(f.installation.root, '.updates', 'staging')
    const [id] = await readdir(staging)
    expect(await readFile(join(staging, id, 'WeWork.exe'), 'utf8')).toContain('version executable')
    // Electron's ASAR patch used to hang extraction of this physical file indefinitely.
    const asar = join(staging, id, 'resources', 'app.asar')
    expect((await lstat(asar)).isFile()).toBe(true)
    expect(await readFile(asar, 'utf8')).toBe('application fixture')
    expect(await hashFile(asar, 'sha256')).toBe(
      createHash('sha256').update('application fixture').digest('hex')
    )
    expect(process.noAsar).toBe(mainAsarFlag)
    expect(await readFile(join(f.installation.root, 'update-state.json'), 'utf8')).toBe(f.active)
    expect(f.prepareInstall).not.toHaveBeenCalled()
  })

  test.each(['duplicate', 'reserved', 'symlink', 'oversized'] as const)(
    'isolated worker rejects %s ZIP entries and cleans physical staging files',
    async zipKind => {
      const f = await fixture({ zipKind })
      const mainAsarFlag = process.noAsar
      await f.service.check('stable')
      await expect(f.service.download()).rejects.toThrow(
        zipKind === 'oversized' ? 'Update archive is too large' : /duplicate|symbolic|Unsafe/
      )
      expect(await readdir(join(f.installation.root, '.updates', 'staging'))).toEqual([])
      expect(await readdir(join(f.installation.root, '.updates', 'downloads'))).toEqual([])
      expect(await readFile(join(f.installation.root, 'update-state.json'), 'utf8')).toBe(f.active)
      expect(f.prepareInstall).not.toHaveBeenCalled()
      expect(process.noAsar).toBe(mainAsarFlag)
    }
  )

  test.each(['corrupt', 'truncate'] as const)(
    'keeps the working version on %s downloads and permits a clean retry',
    async failure => {
      const f = await fixture()
      await f.service.check('stable')
      f[failure]()
      await expect(f.service.download()).rejects.toThrow('checksum or size mismatch')
      expect(f.service.downloadProgress().phase).toBe('failed')
      expect(() => f.service.createInstallAction()).toThrow('has not finished downloading')
      expect(await readdir(join(f.installation.root, '.updates', 'downloads'))).toEqual([])
      expect(await readFile(join(f.installation.root, 'update-state.json'), 'utf8')).toBe(f.active)
      f.restore()
      await f.service.download()
      expect(f.service.downloadProgress().phase).toBe('ready')
      expect(f.transfers()).toBe(2)
    }
  )

  test.each([{ missing: true }, { extra: true }])(
    'rejects incomplete or unlisted release files: %j',
    async options => {
      const f = await fixture(options)
      await f.service.check('stable')
      await expect(f.service.download()).rejects.toThrow(/Release file/)
      expect(await readdir(join(f.installation.root, '.updates', 'staging'))).toEqual([])
      expect(f.prepareInstall).not.toHaveBeenCalled()
    }
  )

  test.each([{ arch: 'arm64' }, { dataSchemaVersion: 2 }, { schemaVersion: 1 }])(
    'rejects incompatible feed before downloading: %j',
    async change => {
      const f = await fixture()
      Object.assign(f.feed, change)
      await expect(f.service.check('stable')).rejects.toThrow('Incompatible Windows update feed')
      expect(f.transfers()).toBe(0)
    }
  )

  test('rejects downgrade and stable channel prereleases', async () => {
    const f = await fixture()
    f.feed.version = '0.5.11'
    expect(await f.service.check('stable')).toBeNull()
    f.feed.version = '0.6.0-beta.1'
    expect(await f.service.check('stable')).toBeNull()
    expect(await f.service.check('beta')).toMatchObject({ version: '0.6.0-beta.1' })
  })

  test('rechecks files before shutdown and refuses a modified candidate', async () => {
    const f = await fixture()
    await f.service.check('stable')
    await f.service.download()
    const directory = join(f.installation.root, '.updates', 'staging')
    const [id] = await readdir(directory)
    await writeFile(join(directory, id, 'WeWork.exe'), 'modified')
    await expect(f.service.createInstallAction()()).rejects.toThrow('Release file mismatch')
    expect(f.prepareInstall).not.toHaveBeenCalled()
    expect(f.quit).not.toHaveBeenCalled()
  })

  test('cancels and waits for the real waiting updater before recovering failed shutdown', async () => {
    const f = await fixture()
    await f.service.check('stable')
    await f.service.download()
    const updater = await realWaitingUpdater()
    const failure = new Error('Executor is still running')
    f.prepareInstall.mockImplementation(async () => {
      await updater.ready()
      expect(updater.running()).toBe(true)
      throw failure
    })
    f.recoverInstall.mockImplementation(async () => {
      expect(updater.running()).toBe(false)
    })
    await expect(f.service.createInstallAction()()).rejects.toBe(failure)
    expect(f.recoverInstall).toHaveBeenCalledWith(failure)
    expect(f.quit).not.toHaveBeenCalled()
    expect(await updater.requestExists()).toBe(false)
    expect(await readFile(join(f.installation.root, 'update-state.json'), 'utf8')).toBe(f.active)
  })

  test('a missing native launcher never starts shutdown or recovery', async () => {
    const f = await fixture()
    await f.service.check('stable')
    await f.service.download()
    await expect(f.service.createInstallAction()()).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.prepareInstall).not.toHaveBeenCalled()
    expect(f.recoverInstall).not.toHaveBeenCalled()
    expect(f.quit).not.toHaveBeenCalled()
    expect(await readFile(join(f.installation.root, 'update-state.json'), 'utf8')).toBe(f.active)
  })

  test('detects a real updater exiting during shutdown and recovers without quitting', async () => {
    const f = await fixture()
    await f.service.check('stable')
    await f.service.download()
    const updater = await realWaitingUpdater()
    f.prepareInstall.mockImplementation(async () => {
      await updater.ready()
      await updater.exit()
    })
    await expect(f.service.createInstallAction()()).rejects.toThrow(
      'Native updater exited before installation handoff'
    )
    expect(f.recoverInstall).toHaveBeenCalledOnce()
    expect(f.quit).not.toHaveBeenCalled()
    expect(updater.running()).toBe(false)
    expect(await updater.requestExists()).toBe(false)
  })

  test('hands off to a real updater only after shutdown completes', async () => {
    const f = await fixture()
    await f.service.check('stable')
    await f.service.download()
    const updater = await realWaitingUpdater()
    f.prepareInstall.mockImplementation(async () => {
      await updater.ready()
      expect(updater.running()).toBe(true)
      expect(f.quit).not.toHaveBeenCalled()
    })
    await f.service.createInstallAction()()
    expect(updater.running()).toBe(true)
    expect(f.prepareInstall).toHaveBeenCalledOnce()
    expect(f.quit).toHaveBeenCalledOnce()
    expect(f.recoverInstall).not.toHaveBeenCalled()
    expect(await readFile(join(f.installation.root, 'update-state.json'), 'utf8')).toBe(f.active)
  })

  test('revokes the request and refuses recovery or quit if updater cancellation fails', async () => {
    const f = await fixture()
    await f.service.check('stable')
    await f.service.download()
    const updater = await realWaitingUpdater()
    f.prepareInstall.mockImplementation(async () => {
      const child = await updater.ready()
      vi.spyOn(child, 'kill').mockReturnValue(false)
      throw new Error('Shutdown failed')
    })
    await expect(f.service.createInstallAction()()).rejects.toThrow(
      'Update cancellation could not be confirmed'
    )
    expect(updater.running()).toBe(true)
    expect(f.recoverInstall).not.toHaveBeenCalled()
    expect(f.quit).not.toHaveBeenCalled()
    expect(await updater.requestExists()).toBe(false)
    await expect(f.service.createInstallAction()()).rejects.toThrow('already being installed')
  })

  test('missing channel does not discard an already downloaded complete version', async () => {
    const f = await fixture()
    await f.service.check('stable')
    await f.service.download()
    f.missingFeed()
    expect(await f.service.check('beta')).toBeNull()
    expect(() => f.service.createInstallAction()).not.toThrow()
  })
})

// Only the fixture executable is redirected. HTTP, files and the OS child lifecycle stay real.
async function realWaitingUpdater() {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  let child: ChildProcess | undefined
  let request: string | undefined
  vi.mocked(spawn).mockImplementationOnce((_launcher, args, options) => {
    request = String(args?.[1])
    child = actual.spawn(
      process.execPath,
      [
        '--eval',
        `const fs = require('node:fs'); const request = process.argv[1];
         fs.writeFileSync(request + '.pid', String(process.pid));
         setInterval(() => { if (fs.existsSync(request + '.exit')) process.exit(9) }, 5)`,
        '--',
        request,
      ],
      { ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    )
    const processToStop = child
    cleanup.push(async () => {
      if (processToStop.exitCode !== null || processToStop.signalCode !== null) return
      const stopped = new Promise<void>(resolve => processToStop.once('exit', () => resolve()))
      process.kill(processToStop.pid!, 'SIGKILL')
      await stopped
    })
    return child
  })
  return {
    ready: async () => {
      await vi.waitFor(
        async () => expect(await readFile(`${request}.pid`, 'utf8')).toBe(String(child?.pid)),
        { timeout: 5000 }
      )
      return child!
    },
    running: () => {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return false
      try {
        process.kill(child.pid, 0)
        return true
      } catch {
        return false
      }
    },
    exit: async () => {
      const stopped = new Promise<void>(resolve => child!.once('exit', () => resolve()))
      await writeFile(`${request}.exit`, '')
      await stopped
    },
    requestExists: async () => {
      try {
        await lstat(request!)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
  }
}

// A tiny real ZIP64 central record advertises a 16 GiB+1 expansion. The worker must reject it
// before creating a payload stream; no large allocation or synthetic extraction API is used.
function oversizedZip64(): Buffer {
  const name = Buffer.from('huge.bin')
  const extra = Buffer.alloc(12)
  extra.writeUInt16LE(1, 0)
  extra.writeUInt16LE(8, 2)
  extra.writeBigUInt64LE(BigInt(16 * 1024 ** 3 + 1), 4)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(45, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(2, 18)
  local.writeUInt32LE(0xffffffff, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(extra.length, 28)
  const body = Buffer.concat([local, name, extra, Buffer.from([3, 0])])
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(45, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(2, 20)
  central.writeUInt32LE(0xffffffff, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(extra.length, 30)
  const directory = Buffer.concat([central, name, extra])
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(body.length, 16)
  return Buffer.concat([body, directory, end])
}
import { spawn, type ChildProcess } from 'node:child_process'
