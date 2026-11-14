import { createServer } from 'node:https'
import { readFile, rm } from 'node:fs/promises'
import {
  assert,
  CLOUD_DEVICE_ID,
  fetchJson,
  join,
  mkdir,
  resultDir,
  runChecked,
  writeFile,
} from './shared.mjs'
import { waitForSnapshot } from './conversation-layout.mjs'
import { verifyBackendGitProjectCreation } from './backend-git-project-creation.mjs'

const ACCOUNT_ID = 'desktop-git-recovery'
const TOKEN = 'desktop-git-recovery-synthetic-token'

async function createPrivateRepository() {
  const root = join(resultDir, 'git-clone-recovery')
  const repo = join(root, 'private.git')
  await mkdir(root, { recursive: true })
  const source = join(root, 'source')
  await mkdir(source, { recursive: true })
  await runChecked('git', ['init', '--initial-branch=develop'], { cwd: source })
  await writeFile(join(source, 'README.md'), '# Private Git recovery\n')
  await runChecked('git', ['add', 'README.md'], { cwd: source })
  await runChecked(
    'git',
    [
      '-c',
      'user.name=Recovery fixture',
      '-c',
      'user.email=recovery@example.test',
      'commit',
      '-m',
      'test: seed private repository',
    ],
    { cwd: source }
  )
  await runChecked('git', ['clone', '--bare', source, repo])
  await runChecked('git', ['--git-dir', repo, 'update-server-info'])
  const cert = join(root, 'localhost.pem')
  const key = join(root, 'localhost.key')
  await runChecked('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
    '-keyout',
    key,
    '-out',
    cert,
  ])
  const expectedAuth = `Basic ${Buffer.from(`oauth2:${TOKEN}`).toString('base64')}`
  const server = createServer(
    { cert: await readFile(cert), key: await readFile(key) },
    async (request, response) => {
      if (request.headers.authorization !== expectedAuth) {
        response.writeHead(401, { 'www-authenticate': 'Basic realm="Git recovery fixture"' })
        response.end()
        return
      }
      try {
        const pathname = new URL(request.url, 'https://localhost').pathname
        const relative = decodeURIComponent(pathname).replace(/^\/private\.git\//, '')
        if (!pathname.startsWith('/private.git/') || relative.split('/').includes('..')) {
          response.writeHead(403)
          response.end()
          return
        }
        const content = await readFile(join(repo, relative))
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(content)
      } catch {
        response.writeHead(404)
        response.end()
      }
    }
  )
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const domain = `localhost:${server.address().port}`
  return {
    domain,
    cert,
    source,
    url: `https://${domain}/private.git`,
    async close() {
      await new Promise(resolve => {
        server.close(resolve)
        server.closeAllConnections()
      })
      await rm(root, { recursive: true, force: true })
    },
  }
}

// This extends the CI-covered cloud-project-creation checkpoint. Only the
// account fixture is seeded; summary, sync, credential helper, Git and UI are real.
export async function verifyGitCloneRecovery(control, cloud, setPhase) {
  const fixture = await createPrivateRepository()
  const priorCa = cloud.remoteExecutorEnv.GIT_SSL_CAINFO
  const headers = { Authorization: `Bearer ${cloud.authToken}` }
  const targetRoot = join(resultDir, 'git-clone-recovery-checkout')
  let originalAccounts
  let userId
  let testError
  try {
    const user = await fetchJson(`${cloud.backendUrl}/api/users/me`, { headers })
    userId = user.id
    const rows = await cloud.queryDatabase('SELECT git_info FROM users WHERE id = %s', [userId])
    originalAccounts = rows[0].git_info
    const original =
      typeof originalAccounts === 'string' ? JSON.parse(originalAccounts) : (originalAccounts ?? [])
    const accounts = original.filter(account => account.id !== ACCOUNT_ID)
    setPhase('git-clone-recovery-authentication-preflight')
    cloud.remoteExecutorEnv.GIT_SSL_CAINFO = fixture.cert
    await cloud.restartCloudExecutor()
    await cloud.executeDatabase('UPDATE users SET git_info = %s WHERE id = %s', [
      JSON.stringify(accounts),
      userId,
    ])
    await mkdir(targetRoot, { recursive: true })
    await control.command('click', '[data-testid="projects-create-button"]')
    await control.command('click', '[data-testid="project-create-remote-option"]')
    await control.command('waitFor', '[data-testid="standalone-remote-device-select"]')
    await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
      value: CLOUD_DEVICE_ID,
    })
    await control.command('click', '[data-testid="remote-project-source-git"]')
    await control.command('waitFor', '[data-testid="remote-project-git-parent-input"]')
    await control.command('fill', '[data-testid="remote-project-git-parent-input"]', {
      value: targetRoot,
    })
    await control.command('fill', '[data-testid="remote-project-git-url-input"]', {
      value: fixture.url,
    })
    await control.command('click', '[data-testid="remote-project-git-advanced-toggle"]')
    await control.command('fill', '[data-testid="remote-project-git-branch-input"]', {
      value: 'develop',
    })
    await control.command('clickWhenEnabled', '[data-testid="remote-project-git-submit"]')
    await control.command('waitFor', '[data-testid="remote-project-git-error"]', {
      text: fixture.domain,
    })
    await control.command('waitFor', '[data-testid="remote-project-git-configure"]', {
      visible: true,
    })
    const snapshot = JSON.parse(await control.command('snapshot', 'body'))
    assert.ok(
      snapshot.testIds.includes('standalone-folder-project-dialog'),
      'Missing credentials must retain the project dialog and original inputs'
    )
    assert.ok(
      snapshot.testIds.includes('remote-project-git-configure'),
      'Missing the correct configuration entry'
    )
    assert.ok(
      !snapshot.testIds.includes('git-clone-project-operations'),
      'Clone configuration guidance must not appear in the sidebar'
    )
    assert.ok(
      snapshot.text.includes(fixture.domain),
      'The configuration guidance must identify the exact host and port'
    )

    setPhase('git-clone-recovery-configure-sync-resume')
    await cloud.executeDatabase('UPDATE users SET git_info = %s WHERE id = %s', [
      JSON.stringify([
        ...accounts,
        {
          id: ACCOUNT_ID,
          type: 'gitlab',
          git_domain: fixture.domain,
          git_token: TOKEN,
          git_login: 'oauth2',
          git_email: 'recovery@example.test',
        },
      ]),
      userId,
    ])
    await control.command('click', '[data-testid="remote-project-git-submit"]')
    await control.command('waitFor', '[data-testid="runtime-project-sortable-list"]', {
      text: 'private',
    })
    await waitForSnapshot(
      control,
      snapshot => !snapshot.testIds.includes('standalone-folder-project-dialog'),
      'Successful recovery did not complete the original operation'
    )
    const checkout = join(targetRoot, 'private')
    await runChecked('git', ['rev-parse', '--is-inside-work-tree'], { cwd: checkout })
    const branch = await fetchJson(`${cloud.backendUrl}/api/devices/${CLOUD_DEVICE_ID}/commands`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_key: 'git_branch', path: checkout }),
    })
    assert.equal(branch.stdout.trim(), 'develop', 'Recovery must preserve the original branch')
    const result = await fetchJson(`${cloud.backendUrl}/api/devices/${CLOUD_DEVICE_ID}/commands`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_key: 'git_remote_url', path: checkout }),
    })
    assert.equal(result.success, true)
    assert.equal(
      result.stdout.trim(),
      fixture.url,
      'Recovery must clone the original repository on the original device'
    )
    await verifyBackendGitProjectCreation(control, cloud, fixture, setPhase)
  } catch (error) {
    testError = error
    throw error
  } finally {
    const cleanupErrors = []
    const cleanup = async action => {
      try {
        await action()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    await cleanup(async () => {
      const snapshot = JSON.parse(await control.command('snapshot', 'body'))
      if (snapshot.testIds.includes('remote-project-git-cancel')) {
        await control.command('clickWhenEnabled', '[data-testid="remote-project-git-cancel"]')
      }
    })
    await cleanup(async () => {
      if (originalAccounts === undefined) return
      await cloud.executeDatabase('UPDATE users SET git_info = %s WHERE id = %s', [
        typeof originalAccounts === 'string' || originalAccounts === null
          ? originalAccounts
          : JSON.stringify(originalAccounts),
        userId,
      ])
      await fetchJson(`${cloud.backendUrl}/api/devices/${CLOUD_DEVICE_ID}/git-accounts`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow_empty: true }),
      })
    })
    if (priorCa === undefined) delete cloud.remoteExecutorEnv.GIT_SSL_CAINFO
    else cloud.remoteExecutorEnv.GIT_SSL_CAINFO = priorCa
    await cleanup(() => cloud.restartCloudExecutor())
    await cleanup(() => fixture.close())
    await cleanup(() => rm(targetRoot, { recursive: true, force: true }))
    if (cleanupErrors.length) {
      throw new AggregateError(
        testError ? [testError, ...cleanupErrors] : cleanupErrors,
        'Git clone recovery cleanup failed'
      )
    }
  }
}
