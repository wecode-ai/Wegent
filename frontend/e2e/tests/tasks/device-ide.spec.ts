// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import {
  startIdeDevice,
  stopOwnedProcess,
  type ArtifactDevice,
} from '../../utils/artifact-device-fixture'

const run = promisify(execFile)

async function codeServerBinary(root: string): Promise<string> {
  if (process.env.E2E_CODE_SERVER_BINARY || !process.env.CI) {
    return process.env.E2E_CODE_SERVER_BINARY || 'code-server'
  }

  // Match the real device image without rebuilding an image for this test.
  const dockerfile = await readFile(
    resolve(__dirname, '../../../../docker/device/Dockerfile'),
    'utf8'
  )
  const version = dockerfile.match(/^ARG CODE_SERVER_VERSION=(\d+\.\d+\.\d+)$/m)?.[1]
  if (!version) throw new Error('Could not read the device image code-server version')

  const archive = join(root, 'code-server.tar.gz')
  await run('curl', [
    '--fail',
    '--silent',
    '--show-error',
    '--location',
    '--retry',
    '2',
    '--max-time',
    '45',
    '--retry-max-time',
    '45',
    '--output',
    archive,
    `https://github.com/coder/code-server/releases/download/v${version}/code-server-${version}-linux-amd64.tar.gz`,
  ])
  await run('tar', ['-xzf', archive, '--strip-components=1', '-C', root])
  await unlink(archive)
  return join(root, 'bin', 'code-server')
}

test('opens a remote Executor IDE from the device card', async ({ page, request }, testInfo) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => localStorage.setItem('user_onboarding_completed', 'true'))
  await page.goto('/devices', { waitUntil: 'domcontentloaded' })
  const token = await page.evaluate(() => localStorage.getItem('auth_token'))
  if (!token) throw new Error('The browser has no authenticated Wegent session')

  const root = await mkdtemp(join(tmpdir(), 'wegent-code-server-e2e-'))
  const binary = await codeServerBinary(root).catch(async error => {
    await rm(root, { recursive: true })
    throw error
  })
  const port = 18080
  const password = crypto.randomUUID()
  const log = createWriteStream(testInfo.outputPath('code-server.log'))
  const server = spawn(
    binary,
    [
      '--bind-addr',
      `127.0.0.1:${port}`,
      '--auth',
      'password',
      '--config',
      join(root, 'config.yaml'),
      '--disable-telemetry',
      '--disable-update-check',
      '--user-data-dir',
      join(root, 'data'),
      '--extensions-dir',
      join(root, 'extensions'),
    ],
    {
      detached: true,
      env: { ...process.env, PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  server.stdout.pipe(log, { end: false })
  server.stderr.pipe(log, { end: false })
  const closed = new Promise<void>(resolve => server.once('close', resolve))
  let launchError: Error | undefined
  server.once('error', error => {
    launchError = error
  })
  let device: ArtifactDevice | undefined
  try {
    await expect
      .poll(
        async () => {
          if (launchError) throw launchError
          if (server.exitCode !== null || server.signalCode !== null) {
            throw new Error('code-server exited before becoming ready. See code-server.log.')
          }
          const health = await request
            .get(`http://127.0.0.1:${port}/healthz`, { timeout: 1_000 })
            .catch(() => null)
          return health?.status()
        },
        { timeout: 15_000, message: 'code-server did not become ready' }
      )
      .toBe(200)

    device = await startIdeDevice(request, token, testInfo, { port, password })
    await page.goto(`/devices?deviceId=${encodeURIComponent(device.id)}`)
    await page.getByTestId(`device-menu-${device.recordId}`).click()
    const [ide] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByTestId(`device-menu-open-ide-${device.id}`).click(),
    ])
    await expect(ide).toHaveURL(url => url.pathname.startsWith('/s/code-'))
    await expect(ide.locator('.monaco-workbench')).toBeVisible({ timeout: 30_000 })
    await ide.close()
  } finally {
    try {
      await device?.close()
    } finally {
      await stopOwnedProcess(server, closed)
      log.end()
      await rm(root, { recursive: true })
    }
  }
})
