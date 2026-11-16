// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test as base, expect, type APIResponse } from '@playwright/test'

import { ADMIN_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'

const apiUrl = process.env.E2E_API_URL || 'http://localhost:8000'
const csv = '名称,说明,数量\n"张三,测试","第一行\n第二行",42\n,,\n尾行\n'
const csvText = '--- Sheet: CSV Data ---\n名称 | 说明 | 数量\n张三,测试 | 第一行\n第二行 | 42\n尾行'
const emptyMessage = /The file is empty|文件内容为空/

interface UploadBody {
  id?: number
  filename?: string
  status?: string
  file_size?: number
  text_length?: number
  detail?: string
  truncation_info?: {
    is_truncated: boolean
    original_length: number
    truncated_length: number
  }
}

interface AttachmentSession {
  headers: Record<string, string>
  ids: Set<number>
  upload: (
    filename: string,
    buffer: Buffer,
    overwriteId?: number
  ) => Promise<{ response: APIResponse; body: UploadBody }>
}

const test = base.extend<{ attachments: AttachmentSession; uploadChat: void }>({
  attachments: async ({ request }, use) => {
    // Both local runs and CI use the real hybrid gateway with this active route.
    const routes = readFileSync(
      resolve(__dirname, '../../../../backend-rs/config/routes.toml'),
      'utf8'
    )
    expect(routes).toMatch(
      /^\[\[routes\]\]\s*\nmethods = \["POST"\]\s*\npath = "\/api\/attachments\/upload"/m
    )
    const api = createApiClient(request)
    const login = await api.login(ADMIN_USER.username, ADMIN_USER.password, 1)
    expect(login.status).toBe(200)
    expect(login.data?.access_token).toBeTruthy()
    const headers = { Authorization: `Bearer ${login.data!.access_token}` }
    const ids = new Set<number>()
    try {
      await use({
        headers,
        ids,
        upload: async (filename, buffer, overwriteId) => {
          const query = new URLSearchParams({ storage_purpose: 'default' })
          if (overwriteId !== undefined) query.set('overwrite_attachment_id', String(overwriteId))
          const response = await request.post(`${apiUrl}/api/attachments/upload?${query}`, {
            headers,
            multipart: { file: { name: filename, mimeType: 'application/octet-stream', buffer } },
          })
          const body = (await response.json()) as UploadBody
          if (typeof body.id === 'number') ids.add(body.id)
          return { response, body }
        },
      })
    } finally {
      for (const id of ids) {
        const deleted = await request.delete(`${apiUrl}/api/attachments/${id}`, { headers })
        expect(deleted.status(), await deleted.text()).toBe(200)
      }
    }
  },
  uploadChat: async ({ page, request, attachments }, use, testInfo) => {
    const name = `e2e-attachment-${Date.now()}-${testInfo.workerIndex}`
    const bot = await request.post(`${apiUrl}/api/bots`, {
      headers: attachments.headers,
      data: { name, shell_name: 'Chat', agent_config: {}, namespace: 'default' },
    })
    expect(bot.ok(), await bot.text()).toBe(true)
    try {
      const team = await request.post(`${apiUrl}/api/teams`, {
        headers: attachments.headers,
        data: { name, bots: [{ bot_id: (await bot.json()).id }], bind_mode: ['chat'] },
      })
      expect(team.ok(), await team.text()).toBe(true)
      try {
        const teamId = (await team.json()).id as number
        await page.addInitScript(id => {
          localStorage.setItem('user_onboarding_completed', 'true')
          localStorage.setItem('wegent_last_team_id', String(id))
          localStorage.setItem('wegent_last_team_id_chat', String(id))
        }, teamId)
        await page.goto(`/chat?teamId=${teamId}`)
        await expect(page.getByTestId('message-input')).toBeVisible()
        await expect(page.locator('input[type="file"][accept*=".csv"]')).toBeEnabled()
        await use()
      } finally {
        const deleted = await request.delete(`${apiUrl}/api/v1/namespaces/default/teams/${name}`, {
          headers: attachments.headers,
        })
        expect(deleted.ok(), await deleted.text()).toBe(true)
      }
    } finally {
      const deleted = await request.delete(`${apiUrl}/api/v1/namespaces/default/bots/${name}`, {
        headers: attachments.headers,
      })
      expect(deleted.ok(), await deleted.text()).toBe(true)
    }
  },
})

for (const sample of [
  { name: 'quoted.csv', buffer: Buffer.from(csv), text: csvText },
  {
    name: 'chinese-gb18030.csv',
    buffer: Buffer.from(
      'c3fbb3c62ccafdc1bf0ad6d0cec4b2e2cad42c34320ad5e2cac7d3c3d3dad1e9d6a4d6d0cec4b1e0c2ebb5c4b2e2cad4cafdbedd2c3130300a',
      'hex'
    ),
    text: '--- Sheet: CSV Data ---\n名称 | 数量\n中文测试 | 42\n这是用于验证中文编码的测试数据 | 100',
  },
]) {
  test(`CSV upload persists parsed text and original bytes: ${sample.name}`, async ({
    request,
    attachments,
  }) => {
    const { response, body } = await attachments.upload(sample.name, sample.buffer)
    expect(response.status(), JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({
      filename: sample.name,
      status: 'ready',
      file_size: sample.buffer.length,
      text_length: Array.from(sample.text).length,
      truncation_info: null,
    })
    const preview = await request.get(`${apiUrl}/api/attachments/${body.id}/preview`, {
      headers: attachments.headers,
    })
    expect(preview.status()).toBe(200)
    expect(await preview.json()).toMatchObject({ preview_type: 'text', preview_text: sample.text })
    const download = await request.get(`${apiUrl}/api/attachments/${body.id}/download`, {
      headers: attachments.headers,
    })
    expect(download.status()).toBe(200)
    expect(await download.body()).toEqual(sample.buffer)
  })
}

test('large CSV reports structural truncation and preserves the original download', async ({
  request,
  attachments,
}) => {
  const content = `name,value\n${Array.from({ length: 8000 }, (_, i) => `row${i},${'x'.repeat(80)}`).join('\n')}`
  const buffer = Buffer.from(content)
  const { response, body } = await attachments.upload('large.csv', buffer)
  expect(response.status(), JSON.stringify(body)).toBe(200)
  expect(body.status).toBe('ready')
  expect(body.truncation_info?.is_truncated).toBe(true)
  expect(body.text_length).toBeLessThanOrEqual(500000)
  expect(body.truncation_info?.truncated_length).toBe(body.text_length)
  expect(body.truncation_info!.original_length).toBeGreaterThan(body.text_length!)
  const preview = await request.get(`${apiUrl}/api/attachments/${body.id}/preview`, {
    headers: attachments.headers,
  })
  expect(preview.status()).toBe(200)
  expect((await preview.json()).preview_text).toContain('# Header\nname | value\n\n# Head Data')
  const download = await request.get(`${apiUrl}/api/attachments/${body.id}/download`, {
    headers: attachments.headers,
  })
  expect(download.status()).toBe(200)
  expect(await download.body()).toEqual(buffer)
})

for (const filename of ['image.png', 'empty.csv', 'empty.txt', 'empty.mp4']) {
  test(`new empty uploads return 400: ${filename}`, async ({ attachments }) => {
    const { response, body } = await attachments.upload(filename, Buffer.alloc(0))
    expect(response.status(), JSON.stringify(body)).toBe(400)
    expect(body).toEqual({ detail: 'File is empty' })
  })
}

for (const filename of ['document.txt', 'document.md']) {
  test(`empty overwrite still clears an existing ${filename}`, async ({ request, attachments }) => {
    const created = await attachments.upload(filename, Buffer.from('original text'))
    expect(created.response.status(), JSON.stringify(created.body)).toBe(200)
    const { response, body } = await attachments.upload(filename, Buffer.alloc(0), created.body.id)
    expect(response.status(), JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({
      id: created.body.id,
      status: 'ready',
      file_size: 0,
      text_length: 0,
    })
    const preview = await request.get(`${apiUrl}/api/attachments/${body.id}/preview`, {
      headers: attachments.headers,
    })
    expect(preview.status()).toBe(200)
    expect(await preview.json()).toMatchObject({ preview_type: 'none', preview_text: null })
  })
}

test('file picker rejects empty files while uploading the valid CSV in the same selection', async ({
  page,
  request,
  attachments,
  uploadChat: _uploadChat,
}) => {
  const uploads: string[] = []
  page.on('request', req => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/attachments/upload') {
      uploads.push(req.url())
    }
  })
  const uploaded = page.waitForResponse(
    res =>
      res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/attachments/upload'
  )
  await page.locator('input[type="file"][accept*=".csv"]').setInputFiles([
    { name: 'image.png', mimeType: 'image/png', buffer: Buffer.alloc(0) },
    { name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.alloc(0) },
    { name: 'selected.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) },
  ])
  await expect(page.getByText(emptyMessage).first()).toBeVisible()
  const response = await uploaded
  expect(response.status(), await response.text()).toBe(200)
  const body = (await response.json()) as UploadBody & { id: number }
  attachments.ids.add(body.id)
  expect(body).toMatchObject({ filename: 'selected.csv', status: 'ready' })
  await expect(page.locator('[title="selected.csv"]').first()).toBeVisible()
  expect(uploads).toHaveLength(1)
  await expect(page.locator('[title="image.png"]')).toHaveCount(0)
  await expect(page.locator('[title="empty.csv"]')).toHaveCount(0)
  const preview = await request.get(`${apiUrl}/api/attachments/${body.id}/preview`, {
    headers: attachments.headers,
  })
  expect(preview.status()).toBe(200)
  expect((await preview.json()).preview_text).toBe(csvText)
})

test('pasting an empty screenshot shows an error and a subsequent file paste succeeds', async ({
  page,
  attachments,
  uploadChat: _uploadChat,
}) => {
  const uploads: string[] = []
  page.on('request', req => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/attachments/upload') {
      uploads.push(req.url())
    }
  })
  const input = page.getByTestId('message-input')
  await input.evaluate(element => {
    const clipboardData = new DataTransfer()
    clipboardData.items.add(new File([], 'image.png', { type: 'image/png' }))
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
    )
  })
  await expect(page.getByText(emptyMessage).first()).toBeVisible()
  expect(uploads).toHaveLength(0)
  await expect(page.locator('[title="image.png"]')).toHaveCount(0)
  const uploaded = page.waitForResponse(
    res =>
      res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/attachments/upload'
  )
  await input.evaluate((element, content) => {
    const clipboardData = new DataTransfer()
    clipboardData.items.add(new File([content], 'pasted.csv', { type: 'text/csv' }))
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
    )
  }, csv)
  const response = await uploaded
  expect(response.status(), await response.text()).toBe(200)
  attachments.ids.add(((await response.json()) as { id: number }).id)
  await expect(page.locator('[title="pasted.csv"]').first()).toBeVisible()
  expect(uploads).toHaveLength(1)
})

test('knowledge batch upload queues only nonempty files from a mixed selection', async ({
  page,
  request,
  attachments,
}) => {
  const name = `e2e-empty-batch-${Date.now()}`
  const created = await request.post(`${apiUrl}/api/knowledge-bases`, {
    headers: attachments.headers,
    data: {
      name,
      namespace: 'default',
      kb_type: 'classic',
      rag_config_mode: 'disabled',
      summary_enabled: false,
    },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const knowledgeBase = (await created.json()) as { id: number; namespace: string; name: string }
  try {
    await page.addInitScript(() => localStorage.setItem('user_onboarding_completed', 'true'))
    await page.goto(
      `/knowledge/${knowledgeBase.namespace}/${encodeURIComponent(knowledgeBase.name)}`
    )
    await page.getByTestId('upload-documents-button').click()
    const dialog = page.getByTestId('document-upload-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('document-upload-file-input').setInputFiles([
      { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
      { name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.alloc(0) },
      { name: 'batch.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) },
    ])
    await expect(dialog.getByText(emptyMessage)).toBeVisible()
    const queuedFiles = dialog.locator('[data-testid^="document-file-remove-"]')
    await expect(queuedFiles).toHaveCount(1)
    await expect(dialog.locator('[title="batch.csv"]')).toBeVisible()
    await expect(dialog.locator('[title="empty.csv"]')).toHaveCount(0)
    await expect(dialog.locator('[title="empty.txt"]')).toHaveCount(0)
  } finally {
    const deleted = await request.delete(`${apiUrl}/api/knowledge-bases/${knowledgeBase.id}`, {
      headers: attachments.headers,
    })
    expect(deleted.ok(), await deleted.text()).toBe(true)
  }
})
