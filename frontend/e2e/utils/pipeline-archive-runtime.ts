import { APIRequestContext, expect } from '@playwright/test'

export type Runtime = { base_url: string; container_name: string; executor_namespace: string }
export type Roots = { workspace_path: string; workbench_home: string; executor_home: string }
export type Snapshot = {
  files: Record<string, string>
  homes: string[]
  transcripts: string[]
  markers: Record<string, string>
}

// All paths come from a disposable CI runtime. Target sessions are produced by
// the real CLIs; only unrelated data and authentication exclusion probes are seeded.
export const SESSION_FILES = `
const fs = require('node:fs')
const path = require('node:path')
const p = JSON.parse(process.argv[1])
const task = path.join(p.roots.executor_home, 'sessions', String(p.taskId))
const homes = p.botIds.map(id => path.join(p.roots.workbench_home, 'agents', p.user, 'default', p.team, 'bots', String(id)))
const walk = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]) : []
const files = {}
const transcripts = homes.flatMap(home => ['projects', 'sessions'].flatMap(dir => walk(path.join(home, dir))).filter(file => file.endsWith('.jsonl'))).sort()
const markers = Object.fromEntries(walk(task).filter(file => ['.claude_session_id_', '.codex_thread_id_'].some(prefix => path.basename(file).startsWith(prefix))).sort().map(file => [file, fs.readFileSync(file, 'utf8')]))
if (p.action === 'snapshot') {
  for (const file of [...Object.keys(markers), ...transcripts, ...homes.flatMap(home => [path.join(home, 'agent.json'), path.join(home, 'runtime/tasks', p.taskId + '.json')])]) files[file] = fs.readFileSync(file).toString('base64')
  console.log(JSON.stringify({ files, homes, transcripts, markers }))
} else if (p.action === 'seed') {
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data) }
  for (const home of homes) {
    if (!fs.existsSync(path.join(home, 'auth.json'))) write(path.join(home, 'auth.json'), 'E2E_ARCHIVE_AUTH_SECRET')
    write(path.join(home, 'runtime/tasks/other-task.json'), '{}')
    write(path.join(home, p.engine === 'ClaudeCode' ? 'projects/other/other-session.jsonl' : 'sessions/2026/01/01/rollout-other-session.jsonl'), 'E2E_OTHER_SESSION')
  }
  const other = path.join(p.roots.workbench_home, 'agents/e2e-other/default/unrelated/bots/999')
  write(path.join(other, 'agent.json'), '{}')
  write(path.join(other, 'runtime/tasks/other-task.json'), '{}')
  for (const transcript of transcripts) write(path.join(other, path.relative(homes.find(home => transcript.startsWith(home + path.sep)), transcript)), fs.readFileSync(transcript))
  for (const [marker, id] of Object.entries(markers)) write(path.join(p.roots.executor_home, 'sessions/other-task', path.basename(marker)), id)
  write(path.join(p.roots.workspace_path, 'archive-workspace.txt'), 'E2E_WORKSPACE')
  if (p.mode === 'sandbox') write('/home/user/archive-home.txt', 'E2E_SANDBOX_HOME')
} else if (p.action === 'erase') {
  for (const home of homes) fs.rmSync(home, { recursive: true })
  fs.rmSync(task, { recursive: true })
  fs.rmSync(path.join(p.roots.workspace_path, 'archive-workspace.txt'))
  if (p.mode === 'sandbox') fs.rmSync('/home/user/archive-home.txt')
} else if (p.action === 'missing') {
  fs.unlinkSync(p.transcript)
} else if (p.action === 'verify') {
  if (fs.readFileSync(path.join(p.roots.workspace_path, 'archive-workspace.txt'), 'utf8') !== 'E2E_WORKSPACE') throw Error('Workspace was not restored')
  if (p.mode === 'sandbox' && fs.readFileSync('/home/user/archive-home.txt', 'utf8') !== 'E2E_SANDBOX_HOME') throw Error('Sandbox Home was not restored')
  for (const home of homes) for (const relative of ['auth.json', 'runtime/tasks/other-task.json']) if (fs.existsSync(path.join(home, relative))) throw Error('Excluded file restored: ' + relative)
}
`

export async function runtimeProcess<T>(
  request: APIRequestContext,
  runtime: Runtime,
  script: string,
  params: Record<string, unknown>
): Promise<T> {
  const payload = Buffer.from(
    JSON.stringify({
      process: { cmd: 'node', args: ['-e', script, JSON.stringify(params)], cwd: '/tmp' },
      stdin: false,
    })
  )
  const envelope = Buffer.alloc(5)
  envelope.writeUInt32BE(payload.length, 1)
  const response = await request.post(`${runtime.base_url}/process.Process/Start`, {
    headers: { 'Content-Type': 'application/connect+json' },
    data: Buffer.concat([envelope, payload]),
  })
  expect(response.ok(), await response.text()).toBe(true)
  const bytes = await response.body()
  let stdout = ''
  let stderr = ''
  let exitCode: number | undefined
  for (let offset = 0; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset + 1)
    const message = JSON.parse(bytes.subarray(offset + 5, offset + 5 + length).toString())
    expect(message.error, JSON.stringify(message)).toBeUndefined()
    const event = message.event
    if (event?.data?.stdout) stdout += Buffer.from(event.data.stdout, 'base64').toString()
    if (event?.data?.stderr) stderr += Buffer.from(event.data.stderr, 'base64').toString()
    if (event?.end) exitCode = event.end.exitCode
    offset += 5 + length
  }
  expect(exitCode, stderr).toBe(0)
  return (stdout.trim() ? JSON.parse(stdout) : undefined) as T
}

export async function resolveRuntime(
  request: APIRequestContext,
  manager: string,
  taskId: number,
  headers: Record<string, string>
): Promise<Runtime> {
  const sandbox = await request.get(`${manager}/sandboxes/${taskId}`)
  if (sandbox.ok()) return { executor_namespace: '', ...(await sandbox.json()) }
  expect(sandbox.status()).toBe(404)
  const response = await request.get(
    `${process.env.E2E_API_URL || 'http://localhost:8000'}/api/tasks/${taskId}`,
    { headers }
  )
  expect(response.ok(), await response.text()).toBe(true)
  const subtasks: Array<{ executor_name?: string; executor_namespace?: string }> = (
    await response.json()
  ).subtasks
  const executor = subtasks.find(subtask => subtask.executor_name)
  expect(executor?.executor_name).toBeTruthy()
  const address = await request.get(`${manager}/executor/address`, {
    params: {
      executor_name: executor!.executor_name!,
      executor_namespace: executor!.executor_namespace || '',
    },
  })
  expect(address.ok(), await address.text()).toBe(true)
  return {
    ...(await address.json()),
    container_name: executor!.executor_name!,
    executor_namespace: executor!.executor_namespace || '',
  }
}
