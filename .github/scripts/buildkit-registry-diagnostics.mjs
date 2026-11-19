import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    builder: { type: 'string' },
    evidence: { type: 'string' },
    revision: { type: 'string' },
  },
})
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(values.builder ?? '')) {
  throw new Error('Registry diagnostics require the selected Buildx builder name')
}
if (!values.evidence || !/^[a-f0-9]{40}$/.test(values.revision ?? '')) {
  throw new Error('Registry diagnostics require an evidence directory and source revision')
}

function command(program, args) {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 128 * 1024,
  })
  return {
    startedAt,
    elapsedMs: Math.round(performance.now() - started),
    exitCode: result.status,
    signal: result.signal,
    errorCode: result.error?.code ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

async function hostRegistry() {
  const startedAt = new Date().toISOString()
  const lookup = command('getent', ['ahostsv4', 'ghcr.io'])
  const addresses = { status: lookup.exitCode === 0 ? 'resolved' : 'failed', ...lookup }
  let registry
  try {
    // An unauthenticated 401 is useful connectivity evidence, never login success.
    const response = await fetch('https://ghcr.io/v2/', {
      method: 'HEAD',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
    registry = { status: response.status }
  } catch (error) {
    registry = { status: 'failed', errorCode: error.cause?.code ?? error.name }
  }
  return { startedAt, addresses, registry }
}

const prefix = `buildx_buildkit_${values.builder}`
const listed = command('docker', [
  'ps', '--all', '--filter', `name=${prefix}`, '--format', '{{.ID}} {{.Names}}',
])
const containers = []
for (const row of listed.stdout.trim().split('\n')) {
  const [id, name] = row.trim().split(/\s+/)
  if (!/^[a-f0-9]{12,64}$/.test(id ?? '') || !name?.startsWith(prefix)) continue
  if (!/^\d+$/.test(name.slice(prefix.length))) continue
  containers.push({
    id,
    name,
    // Do not collect inspect's environment, credentials, mounts or arbitrary logs.
    networkMode: command('docker', ['inspect', '--format', '{{json .HostConfig.NetworkMode}}', id]),
    configuredDns: command('docker', ['inspect', '--format', '{{json .HostConfig.Dns}}', id]),
    resolver: command('docker', ['exec', id, 'cat', '/etc/resolv.conf']),
    lookup: command('docker', [
      'exec', id, '/bin/busybox', 'timeout', '4', '/bin/busybox', 'nslookup', 'ghcr.io',
    ]),
  })
}
const evidence = {
  schema: 1,
  revision: values.revision,
  at: new Date().toISOString(),
  builder: values.builder,
  note: 'Failure diagnostics only. No retry, DNS override, registry credentials or gate change.',
  hostResolver: await readFile('/etc/resolv.conf', 'utf8').catch(error => ({ errorCode: error.code })),
  host: await hostRegistry(),
  discovery: listed,
  containers,
  collection: {
    discoverySucceeded: listed.exitCode === 0,
    builderLocated: containers.length > 0,
  },
}
await mkdir(values.evidence, { recursive: true })
await writeFile(join(values.evidence, 'buildkit-registry-network.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify({
  revision: evidence.revision,
  builder: evidence.builder,
  hostDns: evidence.host.addresses.status,
  hostRegistry: evidence.host.registry.status,
  containers: containers.map(({ name, lookup }) => ({ name, lookupExitCode: lookup.exitCode, errorCode: lookup.errorCode })),
}))

if (!evidence.collection.discoverySucceeded || !evidence.collection.builderLocated) process.exitCode = 1
