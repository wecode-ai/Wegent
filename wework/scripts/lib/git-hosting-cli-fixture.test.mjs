import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGitHostingCliFixtures } from '../../e2e/desktop/scenarios/change-request-status.scenario.mjs'

test('GitLab protocol fixture validates the real login command and creates an isolated config', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-git-cli-'))
  const previousPath = process.env.PATH
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(directory, { recursive: true, force: true })
  })
  await createGitHostingCliFixtures(directory)
  const run = async (args, input = '') => {
    const child = spawn(
      process.execPath,
      [join(directory, '.wework-e2e-bin', 'glab.mjs'), ...args],
      {
        env: { ...process.env, GLAB_CONFIG_DIR: join(directory, 'managed-glab') },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
    let stdout = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.resume()
    child.stdin.end(input)
    const [code] = await once(child, 'close')
    return { code, stdout }
  }
  const help = await run(['auth', 'login', '--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /--git-protocol/)
  const args = ['auth', 'login', '--hostname', 'git.example.test', '--stdin']
  assert.equal((await run(args, 'incorrect-token\n')).code, 1)
  assert.equal((await run(args, 'synthetic-desktop-e2e-gitlab-token\n')).code, 0)
  assert.match(
    await readFile(join(directory, 'managed-glab', 'config.yml'), 'utf8'),
    /hosts:\ngit|hosts:\n  git.example.test:/
  )
})
