// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type GitHttpFixture = {
  domain: string
  url: string
  close: () => Promise<void>
}

export async function createGitHttpFixture(): Promise<GitHttpFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'wegent-device-git-e2e-'))
  const sourcePath = join(fixtureRoot, 'source')
  const repositoryPath = join(fixtureRoot, 'repository.git')
  await mkdir(sourcePath)
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: sourcePath })
  await writeFile(join(sourcePath, 'README.md'), '# Device Git E2E\n')
  await execFileAsync('git', ['add', 'README.md'], { cwd: sourcePath })
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Wegent E2E',
      '-c',
      'user.email=wegent-e2e@example.test',
      'commit',
      '-m',
      'test: seed device git repository',
    ],
    { cwd: sourcePath }
  )
  await execFileAsync('git', ['clone', '--bare', sourcePath, repositoryPath])
  await execFileAsync('git', ['update-server-info'], { cwd: repositoryPath })

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
      if (requestUrl.pathname === '/api/v1/user') {
        if (request.headers.authorization !== 'token device-git-e2e-token') {
          response.writeHead(401)
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            id: 1,
            login: 'device-git-e2e',
            username: 'device-git-e2e',
            email: 'device-git-e2e@example.test',
          })
        )
        return
      }

      const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '')
      const filePath = resolve(fixtureRoot, relativePath)
      if (!filePath.startsWith(`${fixtureRoot}${sep}`)) {
        response.writeHead(403)
        response.end()
        return
      }
      const content = await readFile(filePath)
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(content)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      response.writeHead(code === 'ENOENT' ? 404 : 500)
      response.end()
    }
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => resolvePromise())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    await rm(fixtureRoot, { recursive: true, force: true })
    throw new Error('Device Git fixture did not expose a TCP port')
  }
  const domain = `http://127.0.0.1:${address.port}`

  return {
    domain,
    url: `${domain}/repository.git`,
    async close() {
      await new Promise<void>((resolvePromise, reject) => {
        server.close(error => (error ? reject(error) : resolvePromise()))
      })
      await rm(fixtureRoot, { recursive: true, force: true })
    },
  }
}
