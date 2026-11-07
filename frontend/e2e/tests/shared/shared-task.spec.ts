import { test, expect, type Page } from '@playwright/test'

const VALID_TOKEN = 'e2e-valid-shared-task-token'
const BROKEN_HTML_TOKEN = 'e2e-broken-html-shared-task-token'

type SharedTaskResponse = {
  task_title: string
  sharer_name: string
  sharer_id: number
  display_config: { show_final_answer_only: boolean | null }
  created_at: string
  subtasks: Array<{
    id: number
    role: string
    prompt: string
    result?: unknown
    status: string
    created_at: string
    updated_at: string
    contexts: unknown[]
  }>
}

function sharedTaskResponse(
  title: string,
  subtasks: SharedTaskResponse['subtasks']
): SharedTaskResponse {
  return {
    task_title: title,
    sharer_name: 'E2E Sharer',
    sharer_id: 1,
    display_config: { show_final_answer_only: false },
    created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    subtasks,
  }
}

async function fulfillSharedTask(page: Page, token: string, body: SharedTaskResponse) {
  await page.route(`**/api/tasks/share/public?token=${token}`, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}

test.describe('Shared Task Page', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('shows an invalid-token error without authentication', async ({ page }) => {
    await page.route('**/api/tasks/share/public?token=invalid-token-12345', async route => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Invalid share link format' }),
      })
    })

    await page.goto('/shared/task?token=invalid-token-12345')

    await expect(page.getByRole('heading', { name: /Invalid|无效/ })).toBeVisible()
  })

  test('shows a missing-token error without authentication', async ({ page }) => {
    await page.goto('/shared/task')

    await expect(page.getByRole('heading', { name: /Invalid|无效/ })).toBeVisible()
  })

  test('shows a login option for an unauthenticated shared task', async ({ page }) => {
    await fulfillSharedTask(page, 'test-token-123', sharedTaskResponse('Login prompt', []))

    await page.goto('/shared/task?token=test-token-123')

    await expect(page.getByRole('button', { name: /Login|登录/ }).first()).toBeVisible()
  })

  test('renders a shared task and preserves citation data', async ({ page }) => {
    await fulfillSharedTask(
      page,
      VALID_TOKEN,
      sharedTaskResponse('E2E shared report', [
        {
          id: 1,
          role: 'AI',
          prompt: '',
          result: {
            value: 'Research answer with [cite: 1]',
            annotations: [
              {
                start_index: 0,
                end_index: 1,
                source: 'https://example.invalid/grounding-source',
              },
            ],
            sources: [
              {
                index: 1,
                title: 'Source reference',
                source_uri: 'https://example.invalid/reference',
                source_type: 'external',
                source_id: 'reference',
              },
            ],
            retrieval_summary: {
              searched_source_ids: ['reference'],
              ignored_source_ids: [],
            },
            messages_chain: [{ role: 'assistant', content: 'private model transcript' }],
          },
          status: 'COMPLETED',
          created_at: '2026-01-01T00:00:01Z',
          updated_at: '2026-01-01T00:00:01Z',
          contexts: [],
        },
      ])
    )

    await page.goto(`/shared/task?token=${VALID_TOKEN}`)

    await expect(page.getByRole('heading', { name: 'E2E shared report' })).toBeVisible()
    await expect(page.getByText('E2E Sharer')).toBeVisible()
    await expect(page.getByText('Research answer with (参考来源: 1)')).toBeVisible()
    await expect(page.getByText('example.invalid')).toBeVisible()
    await expect(page.getByText('Source reference')).toBeVisible()
    await expect(page.getByText('Cited 1 documents from 1 knowledge sources')).toBeVisible()
    expect(await page.getByText('private model transcript').count()).toBe(0)
  })

  test('renders a shared HTML artifact with error reporting enabled', async ({ page }) => {
    const html =
      '<!doctype html><html><head><title>Broken report</title></head><body><main>Report body</main><script>throw new Error("preview library is unavailable")</script></body></html>'
    await fulfillSharedTask(
      page,
      BROKEN_HTML_TOKEN,
      sharedTaskResponse('E2E broken HTML preview', [
        {
          id: 1,
          role: 'AI',
          prompt: '',
          result: {
            value: `<artifact title="broken-report.html">${html}</artifact>`,
          },
          status: 'COMPLETED',
          created_at: '2026-01-01T00:00:01Z',
          updated_at: '2026-01-01T00:00:01Z',
          contexts: [],
        },
      ])
    )
    await page.goto(`/shared/task?token=${BROKEN_HTML_TOKEN}`)

    await expect(page.getByRole('heading', { name: 'E2E broken HTML preview' })).toBeVisible()
    const frame = page.getByTestId('artifact-preview-iframe')
    await expect(frame).toBeVisible()
    await expect(frame).toHaveAttribute('data-artifact-script-error-reporting', 'on')
    await expect(frame.contentFrame().getByText('Report body')).toBeVisible()
    await expect(page.getByTestId('artifact-preview-script-error')).toContainText(
      'preview library is unavailable'
    )
  })
})
