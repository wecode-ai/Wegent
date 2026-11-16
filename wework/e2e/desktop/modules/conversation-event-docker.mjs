import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, access, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { writeCodexConfig } from './desktop-build-flows.mjs'
import { MODEL_API_KEY } from './shared.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

const execute = promisify(execFile)
const REMOTE_EXECUTOR_HOME = '/home/wegent/.wecode/wegent-executor'
const DELIVERY = '/opt/wegent/connection-runtime/connection-runtime.json'
const remoteUrl = value =>
  process.platform === 'linux'
    ? value
    : value
        .replace('127.0.0.1', 'host.docker.internal')
        .replace('localhost', 'host.docker.internal')

/** Replace the test's remote device with real containers sharing one owned volume. */
export async function createConversationEventDocker({
  cloud,
  resultDir,
  workspacePath,
  timeoutMs,
  deviceId,
}) {
  const image = process.env.WEWORK_E2E_REMOTE_IMAGE
  assert.ok(image, 'The Remote Docker checkpoint requires its current-revision device image')
  const runId = randomUUID()
  const volume = `wework-event-${runId}`
  const dataVolume = `${volume}-data`
  const containers = []
  const fixture = join(resultDir, 'event-docker')
  const environmentPath = join(fixture, 'device.env')
  const ownedVolumes = []
  let current
  async function docker(...args) {
    try {
      return (await execute('docker', args, { maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
    } catch (error) {
      throw new Error(`Remote Docker ${args[0]} failed: ${String(error.stderr ?? '').slice(-1200)}`)
    }
  }
  async function saveLogs() {
    if (!current) return
    const logs = await execute('docker', ['logs', current], { maxBuffer: 16 * 1024 * 1024 })
    await writeFile(
      join(resultDir, `event-docker-${containers.length}.log`),
      logs.stdout + logs.stderr
    )
    const hasNativeLogs = await execute('docker', [
      'exec',
      current,
      'test',
      '-d',
      `${REMOTE_EXECUTOR_HOME}/logs`,
    ]).then(
      () => true,
      () => false
    )
    if (hasNativeLogs)
      await docker(
        'cp',
        `${current}:${REMOTE_EXECUTOR_HOME}/logs`,
        join(resultDir, `event-docker-${containers.length}-native-logs`)
      )
  }
  const inContainer =
    process.platform === 'linux' &&
    (await access('/.dockerenv').then(
      () => true,
      () => false
    ))
  const network =
    process.platform === 'linux'
      ? ['--network', inContainer ? `container:${process.env.HOSTNAME}` : 'host']
      : ['--add-host', 'host.docker.internal:host-gateway']
  let hostResultDir = resultDir
  if (inContainer) {
    const mounts = JSON.parse(
      await docker('inspect', '--format', '{{json .Mounts}}', process.env.HOSTNAME)
    )
    const mount = mounts
      .filter(
        item => resultDir === item.Destination || resultDir.startsWith(`${item.Destination}/`)
      )
      .sort((a, b) => b.Destination.length - a.Destination.length)[0]
    assert.ok(
      mount?.RW,
      'The Docker fixture needs the runner mount containing its own writable evidence directory'
    )
    hostResultDir = join(mount.Source, relative(mount.Destination, resultDir))
  }
  await mkdir(fixture, { recursive: true })
  await docker('image', 'inspect', image, '--format', '{{.Id}}')
  const rawDelivery = await docker('run', '--rm', '--entrypoint', '/bin/cat', image, DELIVERY)
  const delivery = JSON.parse(rawDelivery)
  // Resolve the original relative paths before mounting the fixture manifest elsewhere.
  const absolute = path => (path.startsWith('/') ? path : `/opt/wegent/connection-runtime/${path}`)
  delivery.nodeExecutable = absolute(delivery.nodeExecutable)
  delivery.runtimeRoot = absolute(delivery.runtimeRoot)
  delivery.packageRoots = delivery.packageRoots.map(absolute)
  delivery.packageRoots.push(join(resultDir, 'connection-adapter'))
  await writeFile(join(fixture, 'connection-runtime.json'), JSON.stringify(delivery))
  await writeCodexConfig(join(fixture, 'codex'), remoteUrl(cloud.modelServerUrl))
  const environment = {
    EXECUTOR_MODE: 'local',
    DEVICE_TYPE: 'remote',
    DEVICE_ID: deviceId,
    DEVICE_NAME: 'Event recovery Remote Docker',
    WEGENT_EXECUTOR_HOME: REMOTE_EXECUTOR_HOME,
    WEGENT_EXECUTOR_HOME_ID: deviceId,
    WEGENT_CODEX_HOME: `${REMOTE_EXECUTOR_HOME}/codex`,
    CODEX_HOME: `${REMOTE_EXECUTOR_HOME}/codex`,
    WEGENT_BACKEND_URL: remoteUrl(cloud.backendUrl),
    WEGENT_SOCKET_URL: remoteUrl(cloud.socketUrl),
    WEGENT_AUTH_TOKEN: cloud.authToken,
    WEGENT_WORKSPACE_ROOTS: workspacePath,
    LOCAL_WORKSPACE_ROOT: '/home/wegent/.wegent/workspace',
    WEWORK_E2E_MODEL_API_KEY: MODEL_API_KEY,
    WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED: 'true',
    DEVICE_CODE_SERVER_ENABLED: 'false',
    DEVICE_SESSION_GATEWAY_ENABLED: 'false',
    DEVICE_TERMINAL_ENABLED: 'false',
    BIND_SHELL: 'claudecode',
  }
  const mounts = [
    '--mount',
    `type=volume,src=${volume},dst=${REMOTE_EXECUTOR_HOME}`,
    '--mount',
    `type=volume,src=${dataVolume},dst=/home/wegent/.wegent`,
    '--mount',
    `type=bind,src=${hostResultDir},dst=${resultDir}`,
    '--mount',
    `type=bind,src=${join(hostResultDir, 'event-docker/connection-runtime.json')},dst=${DELIVERY},readonly`,
  ]
  try {
    await writeFile(
      environmentPath,
      Object.entries(environment)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
      { mode: 0o600 }
    )
    for (const name of [volume, dataVolume]) {
      await docker('volume', 'create', '--label', `wework.event.fixture=${runId}`, name)
      ownedVolumes.push(name)
    }
    await docker(
      'run',
      '--rm',
      '--user',
      'root',
      '--entrypoint',
      '/bin/bash',
      ...mounts,
      image,
      '-c',
      'mkdir -p "$1/codex" && cp "$2/config.toml" "$1/codex/config.toml" && chown -R wegent:wegent "$1" "$3"',
      'fixture-volume-init',
      REMOTE_EXECUTOR_HOME,
      join(fixture, 'codex'),
      '/home/wegent/.wegent'
    )
  } catch (error) {
    const cleanup = await Promise.allSettled([
      ...ownedVolumes.map(name => docker('volume', 'rm', name)),
      rm(environmentPath, { force: true }),
    ])
    const failures = cleanup.filter(item => item.status === 'rejected').map(item => item.reason)
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        'Remote Docker initialization and cleanup failed'
      )
    throw error
  }
  return {
    nodeExecutable: delivery.nodeExecutable,
    async start() {
      const name = `wework-event-${runId}-${containers.length}`
      current = name
      containers.push(name)
      const id = await docker(
        'run',
        '--detach',
        '--name',
        name,
        '--label',
        `wework.event.fixture=${runId}`,
        '--env-file',
        environmentPath,
        ...network,
        ...mounts,
        image
      )
      assert.match(id, /^[a-f0-9]{64}$/)
      await waitForValue(
        async () => {
          const state = JSON.parse(await docker('inspect', '--format', '{{json .State}}', id))
          if (!state.Running) {
            await saveLogs()
            throw new Error(
              `Remote Docker exited ${state.ExitCode}; see event-docker-${containers.length}.log`
            )
          }
          return cloud.device(deviceId)
        },
        device => device?.status === 'online',
        'The real Docker device must register online',
        timeoutMs
      )
      return id
    },
    async destroy() {
      assert.ok(current)
      await saveLogs()
      const id = await docker('inspect', '--format', '{{.Id}}', current)
      await docker('rm', '--force', id)
      assert.equal(await docker('ps', '--all', '--filter', `id=${id}`, '--format', '{{.ID}}'), '')
      await cloud.waitForDeviceStatus(deviceId, 'offline', cloud.remoteDockerExecutorLogPath)
      return id
    },
    async cleanup() {
      try {
        await saveLogs()
      } catch {
        /* A failed start can have no container logs. */
      }
      const containerCleanup = await Promise.allSettled(
        containers.map(async name => {
          const found = await docker(
            'ps',
            '--all',
            '--filter',
            `name=^/${name}$`,
            '--format',
            '{{.ID}}'
          )
          if (found) await docker('rm', '--force', found)
        })
      )
      const remaining = await Promise.allSettled([
        ...ownedVolumes.map(name => docker('volume', 'rm', name)),
        rm(environmentPath, { force: true }),
      ])
      const errors = [...containerCleanup, ...remaining]
        .filter(item => item.status === 'rejected')
        .map(item => item.reason)
      if (errors.length) throw new AggregateError(errors, 'Remote Docker fixture cleanup failed')
    },
    async evidence(value) {
      await writeFile(join(resultDir, 'event-docker-evidence.json'), JSON.stringify(value, null, 2))
    },
  }
}
