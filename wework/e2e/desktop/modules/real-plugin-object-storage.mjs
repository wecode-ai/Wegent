import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { reservePort } from '../port-reservation.mjs'
import { stopProcess } from '../process-lifecycle.mjs'

// Reuse docker-compose.e2e.yml's MinIO version, pinned to its multiarch manifest.
const MINIO_IMAGE =
  'bitnamilegacy/minio@sha256:8935e75fa5d11295c17171e4aa49efe390a1193cd7f12e4d21b92af9ffef09d7'
const MINIO_CONTAINER_BINARY = '/opt/bitnami/minio/bin/minio'
const OWNER_LABEL = 'wework.e2e.minio.owner'
const READY_TIMEOUT_MS = 30_000
const execFileAsync = promisify(execFile)
const RUN_DIRECTORY = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/

/** A real MinIO server owned exclusively by one isolated desktop E2E run. */
export class RealPluginObjectStorage {
  constructor({ resultDir }) {
    assert.ok(
      typeof resultDir === 'string' &&
        isAbsolute(resultDir) &&
        RUN_DIRECTORY.test(basename(resultDir)),
      'Real plugin storage requires an isolated desktop E2E result directory'
    )
    this.resultDir = resolve(resultDir)
    this.accessKey = 'desktop-e2e-access-key'
    this.secretKey = 'desktop-e2e-secret-key'
    this.owner = randomUUID()
    this.containerName = `wework-e2e-minio-${process.pid}-${this.owner}`
  }

  environment() {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('MINIO_'))
    )
    return {
      ...environment,
      MINIO_ROOT_USER: this.accessKey,
      MINIO_ROOT_PASSWORD: this.secretKey,
      MINIO_BROWSER: 'off',
      MINIO_UPDATE: 'off',
    }
  }

  redact(text) {
    return String(text)
      .replaceAll(this.accessKey, '[redacted]')
      .replaceAll(this.secretKey, '[redacted]')
  }

  async docker(args) {
    try {
      return await execFileAsync('docker', args, {
        env: this.environment(),
        encoding: 'utf8',
        timeout: READY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      })
    } catch (error) {
      throw new Error(
        `Real MinIO docker ${args[0]} failed: ${this.redact(error.stderr || error.message)}`
      )
    }
  }

  async start() {
    assert.ok(!this.directory, 'A real plugin storage instance may only be started once')
    assert.ok(
      process.platform === 'linux' || process.platform === 'darwin',
      'Real plugin storage requires Linux MinIO or macOS Docker'
    )
    const rootStat = await lstat(this.resultDir)
    assert.ok(
      rootStat.isDirectory() && !rootStat.isSymbolicLink(),
      'E2E result directory must be real'
    )
    this.resultDir = await realpath(this.resultDir)
    this.directory = await mkdtemp(join(this.resultDir, 'real-minio-'))
    this.directoryStat = await lstat(this.directory)
    this.dataDirectory = join(this.directory, 'data')
    this.certsDirectory = join(this.directory, 'certs')
    this.logPath = join(this.directory, 'minio.log')
    try {
      await mkdir(this.dataDirectory, { mode: 0o700 })
      await mkdir(this.certsDirectory, { mode: 0o700 })
      this.log = createWriteStream(this.logPath, { flags: 'wx', mode: 0o600 })
      this.log.on('error', error => {
        this.logError = error
      })
      await once(this.log, 'open')
      if (process.platform === 'linux') await this.startNative()
      else await this.startDocker()
      await this.waitUntilReady()
      return this
    } catch (error) {
      try {
        await this.stop()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Real MinIO startup and cleanup failed')
      }
      throw error
    }
  }

  async startNative() {
    const port = await reservePort()
    this.endpoint = `http://127.0.0.1:${port}`
    this.child = spawn(
      'minio',
      [
        '--quiet',
        '--anonymous',
        '--json',
        '--certs-dir',
        this.certsDirectory,
        'server',
        '--address',
        `127.0.0.1:${port}`,
        '--console-address',
        '127.0.0.1:0',
        this.dataDirectory,
      ],
      { env: this.environment(), stdio: ['ignore', 'pipe', 'pipe'] }
    )
    this.child.once('error', error => {
      this.childError = error
    })
    this.childClosed = new Promise(resolveClosed => this.child.once('close', resolveClosed))
    for (const input of [this.child.stdout, this.child.stderr]) {
      createInterface({ input }).on('line', line => this.log.write(`${this.redact(line)}\n`))
    }
    await once(this.child, 'spawn')
  }

  async startDocker() {
    this.dockerLaunchAttempted = true
    await this.docker([
      'run',
      '--detach',
      '--platform',
      process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
      '--name',
      this.containerName,
      '--label',
      `${OWNER_LABEL}=${this.owner}`,
      '--user',
      '0',
      '--publish',
      '127.0.0.1::9000',
      '--tmpfs',
      '/data:rw,nosuid,nodev,mode=0700',
      '--env',
      'MINIO_ROOT_USER',
      '--env',
      'MINIO_ROOT_PASSWORD',
      '--env',
      'MINIO_BROWSER',
      '--env',
      'MINIO_UPDATE',
      '--entrypoint',
      MINIO_CONTAINER_BINARY,
      MINIO_IMAGE,
      '--quiet',
      '--anonymous',
      '--json',
      '--certs-dir',
      '/data/certs',
      'server',
      '--address',
      ':9000',
      '--console-address',
      '127.0.0.1:0',
      '/data/objects',
    ])
    const { stdout } = await this.docker(['port', this.containerName, '9000/tcp'])
    const address = stdout.trim()
    assert.match(address, /^127\.0\.0\.1:\d+$/, 'MinIO must publish only a random loopback port')
    this.endpoint = `http://${address}`
  }

  async waitUntilReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.logError) throw this.logError
      if (this.childError) throw this.childError
      if (this.child && (this.child.exitCode !== null || this.child.signalCode !== null)) {
        throw new Error(`Real MinIO exited before readiness; inspect ${this.logPath}`)
      }
      if (this.dockerLaunchAttempted) {
        const { stdout } = await this.docker([
          'inspect',
          '--format',
          '{{.State.Running}}',
          this.containerName,
        ])
        assert.equal(stdout.trim(), 'true', `Real MinIO container stopped; inspect ${this.logPath}`)
      }
      try {
        const response = await fetch(`${this.endpoint}/minio/health/live`, {
          signal: AbortSignal.timeout(1000),
        })
        await response.body?.cancel()
        if (response.status === 200) return
      } catch {
        // MinIO opens the loopback listener after initializing its isolated store.
      }
      await new Promise(resolveTick => setTimeout(resolveTick, 100))
    }
    throw new Error(`Real MinIO did not become healthy; inspect ${this.logPath}`)
  }

  async stopDocker() {
    if (!this.dockerLaunchAttempted) return
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', `{{ index .Config.Labels "${OWNER_LABEL}" }}`, this.containerName],
      { encoding: 'utf8', timeout: READY_TIMEOUT_MS }
    ).catch(error => {
      if (String(error.stderr).includes('No such object')) return { stdout: '' }
      throw new Error(`Cannot verify real MinIO container ownership: ${this.redact(error.message)}`)
    })
    if (!stdout.trim()) return
    assert.equal(stdout.trim(), this.owner, 'Refusing to remove a container owned by another run')
    try {
      await this.docker(['stop', '--time', '5', this.containerName])
      const logs = await this.docker(['logs', this.containerName])
      this.log?.write(this.redact(`${logs.stdout}${logs.stderr}`))
    } finally {
      await this.docker(['rm', '--force', this.containerName])
      this.dockerLaunchAttempted = false
    }
  }

  async stop() {
    const errors = []
    try {
      await this.stopDocker()
      if (this.child?.pid) {
        await stopProcess(this.child)
        await this.childClosed
      }
    } catch (error) {
      errors.push(error)
    }
    if (this.log && !this.log.writableEnded) {
      await new Promise(resolveClosed => this.log.end(resolveClosed))
      if (this.logError) errors.push(this.logError)
    }
    if (this.directory) {
      const current = await lstat(this.directory)
      const suffix = relative(this.resultDir, await realpath(this.directory))
      assert.ok(
        current.isDirectory() &&
          !current.isSymbolicLink() &&
          current.dev === this.directoryStat.dev &&
          current.ino === this.directoryStat.ino &&
          suffix &&
          !isAbsolute(suffix) &&
          suffix !== '..' &&
          !suffix.startsWith(`..${sep}`),
        'Refusing to clean data outside the owned isolated MinIO directory'
      )
      // Preserve the sanitized server log as E2E evidence, remove only owned data.
      await rm(this.dataDirectory, { recursive: true, force: true })
      await rm(this.certsDirectory, { recursive: true, force: true })
    }
    if (errors.length) throw new AggregateError(errors, 'Real MinIO cleanup failed')
  }
}
