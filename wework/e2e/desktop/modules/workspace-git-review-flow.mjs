import { randomUUID } from 'node:crypto'
import {
  CLOUD_DEVICE_ID,
  DEFAULT_STEP_TIMEOUT_MS,
  assert,
  commandOutput,
  fetchJson,
  join,
  mkdir,
  rm,
  writeFile,
} from './shared.mjs'

// Real cloud-device protocol coverage shared by desktop and Mobile; not native UI coverage.
export async function verifyCloudGitReview({ cloudEnvironment, workspacePath }) {
  const repo = join(workspacePath, `git-review-${randomUUID()}`)
  const git = (...args) => commandOutput('git', ['-C', repo, ...args])
  const request = (commandKey, args = []) =>
    fetchJson(
      `${cloudEnvironment.backendUrl}/api/devices/${encodeURIComponent(CLOUD_DEVICE_ID)}/commands`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cloudEnvironment.authToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(DEFAULT_STEP_TIMEOUT_MS),
        body: JSON.stringify({
          command_key: commandKey,
          path: repo,
          args,
          max_output_bytes: 1024 * 1024,
        }),
      }
    )
  try {
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
    const selected = await request('git_compare_branch_diff', ['origin/review-base'])
    assert.equal(selected.success, true)
    assert.doesNotMatch(selected.stdout, /base\.txt/)
    for (const line of ['+committed', '+staged', '+unstaged', '+untracked'])
      assert.ok(selected.stdout.includes(line), `Selected diff is missing ${line}`)
    const staged = await request('git_diff_staged')
    assert.equal(staged.success, true)
    assert.match(staged.stdout, /\+staged/)
    assert.doesNotMatch(staged.stdout, /\+unstaged|untracked\.txt/)
    const unstaged = await request('git_diff_unstaged')
    assert.equal(unstaged.success, true)
    assert.match(unstaged.stdout, /\+unstaged/)
    assert.doesNotMatch(unstaged.stdout, /\+staged|untracked\.txt/)
    const invalid = await request('git_compare_branch_diff', ['missing-base'])
    assert.equal(invalid.success, false)
    assert.equal(invalid.stdout, '')
  } finally {
    await rm(repo, { force: true, recursive: true })
  }
}
