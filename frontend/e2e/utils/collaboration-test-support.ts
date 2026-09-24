// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, type Locator, type Page } from '@playwright/test'
import { createAuthenticatedSocketClient } from '../../../packages/chat-core/src/socket/authenticatedSocketClient'

/**
 * The Issue comment boxes are the shared ProseMirror composer, which refuses
 * input while its host still loads. `fill` reports a non-editable editor
 * instead of waiting for it, so wait for the editor to accept input first.
 */
export async function writeSharedComposer(locator: Locator, text: string): Promise<void> {
  await expect
    .poll(() => locator.evaluate((element: HTMLElement) => element.isContentEditable), {
      message: 'The shared composer never became editable',
    })
    .toBe(true)
  await locator.fill(text)
}

export async function webApi<T>(
  page: Page,
  path: string,
  init: { body?: unknown; method?: string } = {}
): Promise<T> {
  return page.evaluate(
    async ({ requestPath, requestInit }) => {
      const response = await fetch(requestPath, {
        method: requestInit.method ?? 'GET',
        cache: 'no-store',
        headers:
          requestInit.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: requestInit.body === undefined ? undefined : JSON.stringify(requestInit.body),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`${requestInit.method ?? 'GET'} ${requestPath}: ${response.status} ${text}`)
      }
      return text ? JSON.parse(text) : null
    },
    { requestPath: path, requestInit: init }
  )
}

export async function configureDispatchRuntime(
  page: Page,
  projectId: string,
  suffix: string
): Promise<() => Promise<void>> {
  const token = (await page.context().cookies()).find(cookie => cookie.name === 'auth_token')?.value
  if (!token) throw new Error('Authenticated browser context is missing auth_token')
  const deviceId = `e2e-dispatch-${suffix}`
  const client = createAuthenticatedSocketClient({
    socketBaseUrl: () => process.env.E2E_API_URL || 'http://localhost:8000',
    getToken: () => token,
    namespace: '/local-executor',
  })
  let registered = false
  let profile: { id: string; version: number } | undefined
  const cleanup = async () => {
    client.dispose()
    if (profile)
      await webApi(page, `/api/v1/runtime-profiles/${profile.id}`, {
        method: 'PATCH',
        body: { version: profile.version, status: 'archived' },
      })
    if (registered) {
      await expect
        .poll(async () => {
          const devices = await webApi<{ items: Array<{ device_id: string; status: string }> }>(
            page,
            '/api/devices'
          )
          return devices.items.find(device => device.device_id === deviceId)?.status
        })
        .toBe('offline')
      await webApi(page, `/api/devices/${deviceId}`, { method: 'DELETE' })
    }
  }
  try {
    await client.connect(token)
    await expect.poll(() => client.getState().isConnected).toBe(true)
    const ack = await new Promise<{ success?: boolean; device_id?: string }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Dispatch device registration timed out')),
        10_000
      )
      client.socket.emit(
        'device:register',
        {
          device_id: deviceId,
          name: deviceId,
          device_type: 'local',
          bind_shell: 'claudecode',
          executor_version: 'e2e',
        },
        (response: { success?: boolean; device_id?: string }) => {
          clearTimeout(timeout)
          resolve(response)
        }
      )
    })
    registered = ack.success === true
    expect(ack).toEqual({ success: true, device_id: deviceId })
    // This scenario verifies persisted dispatch history, not agent execution.
    client.dispose()
    profile = await webApi<{ id: string; version: number }>(page, '/api/v1/runtime-profiles', {
      method: 'POST',
      body: {
        name: deviceId,
        executionEnvironment: 'local',
        executionDeviceId: deviceId,
        model: 'gpt-5-codex',
        modelType: 'runtime',
        modelOptions: {},
        workspacePolicy: 'project',
      },
    })
    await webApi(page, `/api/v1/cloud-projects/${projectId}/runtime-default`, {
      method: 'PUT',
      body: { runtimeProfileId: profile.id },
    })
    return cleanup
  } catch (error) {
    await cleanup()
    throw error
  }
}

export async function stopDispatchRun(
  page: Page,
  projectId: string,
  run: { id: string; automationId: string; taskId: string }
): Promise<void> {
  const plan = await webApi<{ manager_run: { id: string; status: string } | null }>(
    page,
    `/api/v1/loop-items/${run.taskId}/workflow-plan`
  )
  const activeStatuses = ['pending', 'queued', 'waiting_device', 'running']
  if (plan.manager_run && activeStatuses.includes(plan.manager_run.status)) {
    const stopped = await webApi<{ status: string }>(
      page,
      `/api/v1/cloud-projects/${projectId}/automation-runs/${plan.manager_run.id}/cancel`,
      { method: 'POST' }
    )
    expect(stopped.status).toBe('cancelled')
  }
  const runs = await webApi<Array<{ id: string; status: string }>>(
    page,
    `/api/v1/cloud-projects/${projectId}/automations/${run.automationId}/runs`
  )
  let current = runs.find(candidate => candidate.id === run.id)
  if (!current) throw new Error('Dispatch run disappeared before cleanup')
  if (activeStatuses.includes(current.status)) {
    current = await webApi(
      page,
      `/api/v1/cloud-projects/${projectId}/automation-runs/${run.id}/cancel`,
      {
        method: 'POST',
      }
    )
  }
  expect(current?.status).toMatch(/^(cancelled|failed|succeeded|skipped)$/)
}
