import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import {
  CLOUD_DEVICE_ID,
  DEFAULT_STEP_TIMEOUT_MS,
  assert,
  commandOutput,
  join,
  mkdir,
  rm,
  writeFile,
} from './shared.mjs'

// Real cloud-device protocol coverage shared by desktop and Mobile; not native UI coverage.
export async function verifyCloudGitReview({ cloudEnvironment, workspacePath }) {
  const repo = join(workspacePath, `git-review-${randomUUID()}`)
  let nonRepository
  const git = (...args) => commandOutput('git', ['-C', repo, ...args])
  const { io } = createRequire(
    new URL('../../../../packages/chat-core/package.json', import.meta.url)
  )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
  const socket = io(`${cloudEnvironment.backendUrl}/wework-runtime`, {
    path: '/socket.io',
    auth: { token: cloudEnvironment.authToken, client_origin: 'wework' },
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    forceNew: true,
    timeout: DEFAULT_STEP_TIMEOUT_MS,
  })
  const request = async (commandKey, args = [], path = repo) => {
    const ack = await socket.timeout(DEFAULT_STEP_TIMEOUT_MS).emitWithAck('runtime:request', {
      type: 'request',
      id: randomUUID(),
      device_id: CLOUD_DEVICE_ID,
      method: 'device.execute_command',
      params: { command_key: commandKey, path, args, max_output_bytes: 1024 * 1024 },
    })
    assert.equal(ack.ok, true, ack.error?.message)
    return ack.result?.__runtimeRpcEncoding === 'gzip+base64+json'
      ? JSON.parse(gunzipSync(Buffer.from(ack.result.payload, 'base64')).toString('utf8'))
      : ack.result
  }
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('connect_error', reject)
      socket.connect()
    })
    await mkdir(repo)
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Wework E2E')
    git('config', 'user.email', 'wework-e2e@example.com')
    await writeFile(join(repo, 'base.txt'), 'base\n')
    git('add', '--all')
    git('commit', '-qm', 'base')
    git('checkout', '-qb', 'review-base')
    await writeFile(join(repo, 'base.txt'), 'base\ncomparison\n')
    git('add', '--all')
    git('commit', '-qm', 'comparison')
    git('update-ref', 'refs/remotes/origin/review-base', 'HEAD')
    git('checkout', '-qb', 'feature/review')
    await writeFile(join(repo, 'feature.txt'), 'committed\n')
    git('add', '--all')
    git('commit', '-qm', 'feature')
    await writeFile(join(repo, 'feature.txt'), 'committed\nstaged\n')
    git('add', 'feature.txt')
    await writeFile(join(repo, 'feature.txt'), 'committed\nstaged\nunstaged\n')
    await writeFile(join(repo, 'untracked.txt'), 'untracked\n')
    const automatic = await request('git_branch_diff')
    assert.equal(automatic.success, true)
    assert.match(automatic.stdout, /base\.txt/)
    for (const line of ['+committed', '+staged', '+unstaged', '+untracked'])
      assert.ok(automatic.stdout.includes(line), `Branch diff is missing ${line}`)
    const staged = await request('git_diff_staged')
    assert.equal(staged.success, true)
    assert.match(staged.stdout, /\+staged/)
    assert.doesNotMatch(staged.stdout, /\+unstaged|untracked\.txt/)
    const unstaged = await request('git_diff_unstaged')
    assert.equal(unstaged.success, true)
    assert.match(unstaged.stdout, /\+unstaged/)
    assert.doesNotMatch(unstaged.stdout, /\+staged|untracked\.txt/)
    const commit = await request('git_diff_last_commit')
    assert.equal(commit.success, true)
    assert.match(commit.stdout, /\+committed/)
    assert.doesNotMatch(commit.stdout, /\+staged|\+unstaged|untracked\.txt/)
    const probe = await request('git_is_worktree', [repo])
    assert.equal(probe.success, true)
    assert.equal(probe.stdout.trim(), 'true')
    nonRepository = await mkdtemp(join(tmpdir(), 'wework-non-git-'))
    const nonGitProbe = await request('git_is_worktree', [nonRepository], nonRepository)
    assert.equal(nonGitProbe.success, false)
    assert.notEqual(nonGitProbe.exit_code, 0)
    assert.match(nonGitProbe.stderr, /not a git repository/i)
  } finally {
    socket.disconnect()
    await rm(repo, { force: true, recursive: true })
    if (nonRepository) await rm(nonRepository, { force: true, recursive: true })
  }
}
