// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from 'node:child_process'
import { constants, createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { expect, type APIRequestContext, type TestInfo } from '@playwright/test'
import { prepareArtifactDeviceUser } from './artifact-device-user'

export { artifactDatabaseState } from './artifact-database-state'

const repository = resolve(__dirname, '../../..')
export const artifactApiUrl = process.env.E2E_API_URL || 'http://localhost:8000'
export const artifactModelUrl =
  process.env.E2E_LOCAL_CLAUDE_MODEL_SERVER_URL ||
  process.env.MOCK_MODEL_SERVER_URL ||
  'http://localhost:9999'
export type ArtifactShell = 'ClaudeCode' | 'Codex'
export type ArtifactDevice = {
  id: string
  targetId: string
  stop(): Promise<void>
  close(): Promise<void>
}

export function artifactHeaders(token: string) {
  return { Authorization: `Bearer ${token}` }
}

async function stopOwnedProcess(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await closed
    return
  }
  if (!child.pid) {
    await closed
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }, 10_000)
  try {
    await closed
  } finally {
    clearTimeout(timer)
  }
}

export async function startArtifactDevice(
  request: APIRequestContext,
  token: string,
  shell: ArtifactShell,
  testInfo: TestInfo
): Promise<ArtifactDevice> {
  const id = `e2e-artifact-${shell.toLowerCase()}-${crypto.randomUUID()}`
  const binary =
    process.env.E2E_EXECUTOR_BINARY || join(repository, 'executor/target/release/wegent-executor')
  const claude =
    process.env.E2E_CLAUDE_BINARY ||
    join(repository, '.github/claude-code-cli/node_modules/.bin/claude')
  const codex =
    process.env.E2E_CODEX_BINARY ||
    join(
      repository,
      'wework/resources/binaries/codex/x86_64-unknown-linux-gnu/vendor/x86_64-unknown-linux-musl/bin/codex'
    )
  for (const executable of [binary, shell === 'Codex' ? codex : claude])
    await access(executable, constants.X_OK)
  const root = await mkdtemp(join(tmpdir(), 'wegent-artifact-e2e-'))
  await mkdir(join(root, 'home'))
  const identity = await prepareArtifactDeviceUser(root).catch(async error => {
    await rm(root, { recursive: true })
    throw error
  })
  const log = createWriteStream(testInfo.outputPath(`${id}.log`))
  const child = spawn(binary, [], {
    cwd: root,
    detached: true,
    ...identity,
    env: {
      ...process.env,
      PATH: `${dirname(claude)}${delimiter}${process.env.PATH}`,
      EXECUTOR_MODE: 'local',
      WEGENT_BACKEND_URL: artifactApiUrl,
      WEGENT_AUTH_TOKEN: token,
      DEVICE_ID: id,
      DEVICE_NAME: id,
      DEVICE_TYPE: 'app',
      DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
      DEVICE_SESSION_GATEWAY_PORT: '0',
      // Registration's transport family is distinct from the Task's Bot Shell.
      // Both SDKs execute on this real device; the explicit Team selects one.
      BIND_SHELL: 'claudecode',
      HOME: join(root, 'home'),
      USERPROFILE: join(root, 'home'),
      WEGENT_EXECUTOR_HOME: join(root, 'home'),
      WORKSPACE_ROOT: join(root, 'workspace'),
      LOCAL_WORKSPACE_ROOT: join(root, 'workspace'),
      LOCAL_HEARTBEAT_INTERVAL: '2',
      CODEX_BINARY_PATH: codex,
      CODEX_BIN: codex,
      CLAUDE_BINARY_PATH: claude,
      CODEX_HOME: join(root, 'codex'),
      WEGENT_CODEX_HOME: join(root, 'codex'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      ANTHROPIC_API_KEY: 'artifact-e2e-model-only',
      OPENAI_API_KEY: 'artifact-e2e-model-only',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()))
  let launchError: Error | undefined
  child.once('error', error => {
    launchError = error
  })
  child.stdout!.pipe(log, { end: false })
  child.stderr!.pipe(log, { end: false })
  let recordId: number | undefined
  const stop = async () => {
    await stopOwnedProcess(child, closed)
    if (recordId) {
      await expect
        .poll(
          async () => {
            const response = await request.get(`${artifactApiUrl}/api/devices`, {
              headers: artifactHeaders(token),
            })
            expect(response.status()).toBe(200)
            const body = (await response.json()) as {
              items: Array<{ device_id: string; status: string }>
            }
            return body.items.find(device => device.device_id === id)?.status
          },
          { timeout: 20_000 }
        )
        .toBe('offline')
    }
  }
  const close = async () => {
    await stop()
    log.end()
    if (recordId) {
      const deleted = await request.delete(`${artifactApiUrl}/api/devices/records/${recordId}`, {
        headers: artifactHeaders(token),
      })
      expect(deleted.status(), await deleted.text()).toBe(200)
    }
    await rm(root, { recursive: true })
  }
  try {
    let targetId = ''
    await expect
      .poll(
        async () => {
          if (launchError) throw launchError
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(`E2E executor exited; see ${id}.log`)
          const response = await request.get(`${artifactApiUrl}/api/devices`, {
            headers: artifactHeaders(token),
          })
          expect(response.status()).toBe(200)
          const body = (await response.json()) as {
            items: Array<{
              id: number
              device_id: string
              execution_target_id: string
              status: string
            }>
          }
          const device = body.items.find(device => device.device_id === id)
          recordId = device?.id
          targetId = device?.execution_target_id || ''
          return device?.status
        },
        { timeout: 60_000, message: `The real ${shell} artifact executor did not register` }
      )
      .toBe('online')
    expect(targetId).toMatch(/^app-record-\d+$/)
    recordId = Number(targetId.slice('app-record-'.length))
    return { id, targetId, stop, close }
  } catch (error) {
    await close()
    throw error
  }
}
