// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import {
  configureToolScenario,
  clearToolScenario,
  waitForTaskTerminal,
  getTask,
  getScenarioModelBodies,
  modelRequestText,
} from '../../utils/provider-native-test-support'
import {
  artifactApiUrl,
  artifactModelUrl,
  artifactHeaders,
  startArtifactDevice,
  artifactDatabaseState,
  prepareArtifactDatabaseState,
  type ArtifactShell,
  type ArtifactDevice,
} from '../../utils/artifact-device-fixture'

type Artifact = { id: number; name: string; context_type: string; remote_task_id: number }
type Done = { task_id: number; contexts: Artifact[] }
test.describe.configure({ mode: 'serial', timeout: 180_000 })

test.beforeAll(async () => {
  test.setTimeout(330_000)
  await test.step('Prepare isolated artifact database dependencies', prepareArtifactDatabaseState)
})

function completionFrames(page: Page): Done[] {
  const frames: Done[] = []
  page.on('websocket', socket =>
    socket.on('framereceived', frame => {
      const payload = frame.payload.toString()
      if (!payload.includes('"chat:done"')) return
      const event = JSON.parse(payload.slice(payload.indexOf('['))) as [string, Done]
      if (event[0] === 'chat:done') frames.push(event[1])
    })
  )
  return frames
}

function generationCommand(content: string, marker: string): string {
  const seed = `const fs=require('fs'),p=require('path'),r=process.env.WEGENT_TASK_WORKSPACE;
if(!r)throw new Error('Missing real Task workspace');
fs.mkdirSync(p.join(r,'outputs'),{recursive:true});
fs.writeFileSync(p.join(r,'outputs/report.md'),Buffer.from('${Buffer.from(content).toString('base64')}','base64'));
for(const name of ['missing.txt','symlink.txt','large.bin'])fs.writeFileSync(p.join(r,'outputs',name),'fixture');
fs.truncateSync(p.join(r,'outputs/large.bin'),50*1024*1024+1);
fs.writeFileSync(p.join(r,'../outside-${marker}'),'OUTSIDE_MUST_NOT_LEAK');`
  const mutate = `const fs=require('fs'),p=require('path'),r=process.env.WEGENT_TASK_WORKSPACE;
fs.unlinkSync(p.join(r,'outputs/missing.txt'));fs.unlinkSync(p.join(r,'outputs/symlink.txt'));
fs.symlinkSync(p.join(r,'../outside-${marker}'),p.join(r,'outputs/symlink.txt'));`
  return (
    `set -eu\nnode <<'ARTIFACT_SEED'\n${seed}\nARTIFACT_SEED\n` +
    `for file in report.md missing.txt symlink.txt large.bin; do "$WEGENT_EXECUTOR_BINARY" artifact declare --path "outputs/$file"; done\n` +
    `"$WEGENT_EXECUTOR_BINARY" artifact declare --path outputs/report.md & first=$!\n` +
    `"$WEGENT_EXECUTOR_BINARY" artifact declare --path outputs/report.md & second=$!\nwait "$first"\nwait "$second"\n` +
    `node <<'ARTIFACT_MUTATE'\n${mutate}\nARTIFACT_MUTATE`
  )
}

async function download(page: Page, context: Artifact, expected: string): Promise<void> {
  const downloaded = page.waitForEvent('download')
  await page.getByTestId(`remote-workspace-artifact-download-${context.id}`).click()
  const file = await downloaded
  expect(file.suggestedFilename()).toBe('report.md')
  expect(await file.failure()).toBeNull()
  expect(await readFile((await file.path())!, 'utf8')).toBe(expected)
}

for (const shell of ['ClaudeCode', 'Codex'] as const satisfies readonly ArtifactShell[]) {
  test(`${shell}: legacy Ghost delivers files without a prompt migration`, async ({
    page,
    request,
  }, testInfo) => {
    const api = createApiClient(request)
    const login = await api.login(ADMIN_USER.username, ADMIN_USER.password)
    expect(login.status).toBe(200)
    const token = login.data!.access_token
    const headers = artifactHeaders(token)
    const user = await request.get(`${artifactApiUrl}/api/users/me`, { headers })
    expect(user.status()).toBe(200)
    const { id: userId } = (await user.json()) as { id: number }
    const marker = crypto.randomUUID().replaceAll('-', '')
    const modelName = `artifact-${shell.toLowerCase()}-${marker}`
    const prompt = `ARTIFACT_${marker}: generate the requested Markdown file.`
    const legacyPrompt = await readFile(
      resolve(__dirname, '../../../../backend/tests/fixtures/wework_legacy_file_delivery.txt'),
      'utf8'
    )
    const content = `# 冬天\n\n雪落在窗前，热茶温暖了双手。${marker}\n`
    const resources: string[] = []
    const devices: ArtifactDevice[] = []
    let taskId: number | undefined
    const create = async <T>(path: string, data: unknown): Promise<T> => {
      const response = await request.post(`${artifactApiUrl}${path}`, { headers, data })
      expect(response.ok(), await response.text()).toBe(true)
      return response.json()
    }
    try {
      const primary = await startArtifactDevice(request, token, shell, testInfo)
      devices.push(primary)
      const replacement = await startArtifactDevice(request, token, shell, testInfo)
      devices.push(replacement)
      await create('/api/v1/namespaces/default/models', {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: { name: modelName, namespace: 'default' },
        spec: {
          protocol: shell === 'Codex' ? 'openai-responses' : 'anthropic',
          modelConfig: {
            env: {
              model: shell === 'Codex' ? 'openai' : 'claude',
              model_id: shell === 'Codex' ? 'gpt-5.1-codex' : 'claude-sonnet-4-6',
              api_key: 'artifact-model-only',
              ANTHROPIC_API_KEY: 'artifact-model-only',
              base_url: `${artifactModelUrl}/v1`,
            },
          },
        },
      })
      resources.unshift(`/api/v1/namespaces/default/models/${modelName}`)
      const bot = await create<{ id: number }>('/api/bots', {
        name: `${modelName}-bot`,
        shell_name: shell,
        agent_config: { bind_model: modelName, bind_model_type: 'user' },
        namespace: 'default',
        system_prompt: legacyPrompt,
      })
      resources.unshift(`/api/bots/${bot.id}`)
      const team = await create<{ id: number }>('/api/teams', {
        name: `${modelName}-team`,
        bots: [{ bot_id: bot.id, role: 'worker', bot_prompt: '' }],
        bind_mode: ['task'],
        namespace: 'default',
        is_active: true,
        requires_workspace: false,
      })
      resources.unshift(`/api/v1/namespaces/default/teams/${modelName}-team`)
      const command = generationCommand(content, marker)
      await configureToolScenario(request, prompt, [
        {
          toolCalls: [
            {
              toolName: shell === 'Codex' ? 'exec_command' : 'Bash',
              arguments: shell === 'Codex' ? { cmd: command } : { command },
            },
          ],
        },
        { responseContent: `Created report.md. ARTIFACT_DONE_${marker}` },
      ])
      await page.addInitScript(teamId => {
        localStorage.setItem('user_onboarding_completed', 'true')
        localStorage.setItem('hasSeenCodeTour', 'true')
        localStorage.setItem('wegent_last_team_id', String(teamId))
        localStorage.setItem('wegent_last_team_id_code', String(teamId))
      }, team.id)
      const done = completionFrames(page)
      await page.goto(`/devices/chat?deviceId=${primary.targetId}&teamId=${team.id}`, {
        waitUntil: 'domcontentloaded',
      })
      const selector = page.getByTestId('model-selector')
      await expect(selector).toBeEnabled()
      await selector.click()
      await page.getByTestId('model-cascade-search-input').fill(modelName)
      await page.getByTestId(`model-option-${modelName}`).click()
      const input = page.getByTestId('message-input')
      await expect(input).toHaveAttribute('contenteditable', 'true')
      await input.fill(prompt)
      await page.getByTestId('send-button').click()
      await expect.poll(() => new URL(page.url()).searchParams.get('taskId')).not.toBeNull()
      taskId = Number(new URL(page.url()).searchParams.get('taskId'))
      await waitForTaskTerminal(token, taskId)
      await expect
        .poll(
          () =>
            done
              .find(event => event.task_id === taskId)
              ?.contexts?.filter(context => context.context_type === 'remote_workspace_artifact')
              .length
        )
        .toBe(4)
      const contexts = done
        .find(event => event.task_id === taskId)!
        .contexts.filter(context => context.context_type === 'remote_workspace_artifact')
      const completed = (await getTask(request, token, taskId)) as {
        subtasks: Array<{ bots?: Array<{ shell_type: string }> }>
      }
      expect(
        completed.subtasks.some(subtask => subtask.bots?.some(bot => bot.shell_type === shell))
      ).toBe(true)
      const modelBodies = await getScenarioModelBodies(request, prompt)
      expect(modelBodies.length).toBeGreaterThan(0)
      const modelText = modelRequestText(modelBodies)
      expect(modelText).toContain('computer://path/to/file')
      expect(modelText).toContain('artifact declare --path')
      expect(modelText).toContain('The command sends metadata only')
      const storedBot = await request.get(`${artifactApiUrl}/api/bots/${bot.id}`, { headers })
      expect(storedBot.status()).toBe(200)
      expect((await storedBot.json()).system_prompt).toBe(legacyPrompt)
      for (const context of contexts)
        await expect(
          page.getByTestId(`remote-workspace-artifact-download-${context.id}`)
        ).toBeVisible()
      const report = contexts.find(context => context.name === 'report.md')!
      expect(report).toBeTruthy()
      const identity = {
        task_id: taskId,
        context_id: report.id,
        user_id: userId,
        expected_device_id: primary.id,
      }
      const stored = await test.step('Inspect real artifact database state', () =>
        artifactDatabaseState({ ...identity, operation: 'inspect' }))
      expect(stored).toMatchObject({ binary_size: 0, image_base64: '', extracted_text: '' })
      const controlRejected = await request.post(
        `${artifactApiUrl}/api/devices/${primary.targetId}/commands`,
        {
          headers,
          data: { command_key: 'workspace_read_file_chunk', path: '/tmp', args: ['file', '0'] },
        }
      )
      expect(controlRejected.status()).toBe(400)
      expect(await controlRejected.text()).toContain('Remote control is disabled')
      await download(page, report, content)
      const preview = await request.get(
        `${artifactApiUrl}/api/tasks/${taskId}/remote-workspace/artifacts/${report.id}/file?disposition=inline`,
        { headers }
      )
      expect(preview.status()).toBe(200)
      expect(preview.headers()['content-disposition']).toContain('inline;')
      expect(await preview.text()).toBe(content)
      await page.reload()
      await expect(
        page.getByTestId(`remote-workspace-artifact-download-${report.id}`)
      ).toBeVisible()
      await download(page, report, content)
      const rebound = await test.step('Rebind the task without changing its artifact source', () =>
        artifactDatabaseState({
          ...identity,
          operation: 'rebind',
          replacement_device_id: replacement.id,
        }))
      expect(rebound.executor_name).toBe(`device-${replacement.targetId}`)
      expect(rebound.source.executor_name).toBe(`device-${primary.targetId}`)
      await download(page, report, content)

      for (const [name, status] of [
        ['missing.txt', 502],
        ['symlink.txt', 502],
        ['large.bin', 413],
      ] as const) {
        const context = contexts.find(context => context.name === name)!
        expect(context).toBeTruthy()
        const rejected = await request.get(
          `${artifactApiUrl}/api/tasks/${taskId}/remote-workspace/artifacts/${context.id}/file`,
          { headers }
        )
        expect(rejected.status(), await rejected.text()).toBe(status)
        expect(await rejected.text()).not.toContain('OUTSIDE_MUST_NOT_LEAK')
      }
      const outsider = createApiClient(request)
      expect((await outsider.login(REGULAR_USER.username, REGULAR_USER.password)).status).toBe(200)
      expect(
        (await outsider.get(`/api/tasks/${taskId}/remote-workspace/artifacts/${report.id}/file`))
          .status
      ).toBe(404)
      expect((await api.post(`/api/tasks/${taskId}/remote-workspace/artifacts`, {})).status).toBe(
        403
      )

      await primary.stop()
      const downloads: string[] = []
      page.on('download', file => downloads.push(file.suggestedFilename()))
      const failed = page.waitForResponse(response =>
        new URL(response.url()).pathname.endsWith(`/artifacts/${report.id}/file`)
      )
      await page.getByTestId(`remote-workspace-artifact-download-${report.id}`).click()
      expect((await failed).status()).toBe(409)
      await expect(
        page.getByTestId(`remote-workspace-artifact-download-${report.id}`)
      ).toBeEnabled()
      expect(downloads).toEqual([])
      const available = await request.get(`${artifactApiUrl}/api/devices`, { headers })
      expect(
        (await available.json()).items.find(
          (device: { device_id: string }) => device.device_id === replacement.id
        ).status
      ).toBe('online')
      const persisted = await getTask(request, token, taskId)
      expect(JSON.stringify(persisted)).toContain('remote_workspace_artifact')
    } finally {
      const errors: unknown[] = []
      const cleanup = async (action: () => Promise<void>) => {
        try {
          await action()
        } catch (error) {
          errors.push(error)
        }
      }
      await cleanup(() => clearToolScenario(request, prompt))
      if (taskId)
        await cleanup(async () => {
          expect((await api.delete(`/api/tasks/${taskId}`)).status).toBe(200)
        })
      for (const device of devices.reverse()) await cleanup(() => device.close())
      for (const path of resources) {
        await cleanup(async () => {
          const deleted = await request.delete(`${artifactApiUrl}${path}`, { headers })
          expect(deleted.ok(), await deleted.text()).toBe(true)
        })
      }
      if (errors.length) throw new AggregateError(errors, 'Artifact E2E fixture cleanup failed')
    }
  })
}
