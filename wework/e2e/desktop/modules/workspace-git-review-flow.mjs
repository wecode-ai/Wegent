import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { CLOUD_DEVICE_ID, assert, commandOutput, join, mkdir, rm, writeFile } from './shared.mjs'
import { withCloudRuntimeRequest } from './cloud-runtime-request.mjs'

// Real cloud-device protocol coverage shared by desktop and Mobile; not native UI coverage.
export async function verifyCloudGitReview({ cloudEnvironment, workspacePath }) {
  const repo = join(workspacePath, `git-review-${randomUUID()}`)
  let nonRepository
  const git = (...args) => commandOutput('git', ['-C', repo, ...args])
  try {
    await withCloudRuntimeRequest(cloudEnvironment, async runtimeRequest => {
      const request = (commandKey, args = [], path = repo) =>
        runtimeRequest(
          'device.execute_command',
          { command_key: commandKey, path, args, max_output_bytes: 1024 * 1024 },
          CLOUD_DEVICE_ID
        )
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
    })
  } finally {
    await rm(repo, { force: true, recursive: true })
    if (nonRepository) await rm(nonRepository, { force: true, recursive: true })
  }
}
