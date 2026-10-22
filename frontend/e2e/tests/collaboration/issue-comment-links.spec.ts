// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createServer } from 'node:http'
import { expect, test, type Page } from '@playwright/test'
import { webApi, writeSharedComposer } from '../../utils/collaboration-test-support'

const GITHUB_URL = 'https://github.com/wecode-ai/Wegent/pull/3966'
const DOCUMENT_TEXT = 'The Issue comment document opened in a separate page.'

interface Resource {
  id: string
  version: number
}

async function archiveResource(page: Page, path: string): Promise<void> {
  const resource = await webApi<Resource>(page, path)
  await webApi(page, `${path}?version=${resource.version}`, { method: 'DELETE' })
}

const commentTest = test.extend<{ commentDocumentUrl: string }>({
  commentDocumentUrl: async ({}, use) => {
    const server = createServer((request, response) => {
      if (request.url !== '/comment-document') {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><title>Issue comment document</title><p>${DOCUMENT_TEXT}</p>`)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('The comment document server did not expose a TCP port')
      }
      await use(`http://127.0.0.1:${address.port}/comment-document`)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    }
  },
})

commentTest(
  'opens persisted Issue comment chips and Markdown links without leaving the workspace',
  async ({ page, commentDocumentUrl }) => {
    await page.goto('/collaboration')
    await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
    const suffix = crypto.randomUUID()
    const workspace = await webApi<Resource>(page, '/api/v1/workspaces', {
      method: 'POST',
      body: { name: `Comment links ${suffix}` },
    })
    let project: Resource | undefined
    try {
      project = await webApi<Resource>(page, '/api/v1/cloud-projects', {
        method: 'POST',
        body: {
          workspace_id: workspace.id,
          name: `Comment links ${suffix}`,
          task_provider: 'local',
          visibility: 'private',
        },
      })
      const issueTitle = `Open comment links ${suffix}`
      const issue = await webApi<Resource>(
        page,
        `/api/v1/cloud-projects/${project.id}/loop-items`,
        { method: 'POST', body: { title: issueTitle } }
      )
      const projectPath = `/collaboration/workspaces/${workspace.id}/projects/${project.id}`
      const issuePath = `${projectPath}/issues/${issue.id}`
      await page.goto(issuePath)
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      const commentMarker = `Persisted comment links ${suffix}`
      await writeSharedComposer(
        page.getByTestId('collaboration-issue-comment'),
        [
          commentMarker,
          `[wecode-ai/Wegent#3966](${GITHUB_URL})`,
          `[Comment document](${commentDocumentUrl})`,
        ].join('\n')
      )
      await page.getByTestId('collaboration-issue-comment-submit').click()
      await expect(page.getByTestId('collaboration-comments')).toContainText(commentMarker)

      // Reload before clicking so optimistic comment state cannot satisfy the test.
      await page.reload()
      const comment = page.locator('.task-detail-comment-card').filter({ hasText: commentMarker })
      const githubLink = comment.getByTestId('composer-link-chip')
      const documentLink = comment.getByTestId('assistant-markdown-link')
      await expect(githubLink).toHaveAttribute('href', GITHUB_URL)
      await expect(documentLink).toHaveAttribute('href', commentDocumentUrl)

      for (const [link, url, documentText] of [
        [githubLink, GITHUB_URL, undefined],
        [documentLink, commentDocumentUrl, DOCUMENT_TEXT],
      ] as const) {
        await expect(link).toHaveAttribute('target', '_blank')
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
        const popupPromise = page.waitForEvent('popup')
        await link.click()
        const popup = await popupPromise
        try {
          await expect(popup).toHaveURL(url)
          if (documentText) {
            await expect(popup.locator('body')).toHaveText(documentText)
          } else {
            await popup.waitForLoadState('load')
            await expect(popup).toHaveTitle(/GitHub/)
          }
          await expect(page).toHaveURL(issuePath)
          await expect(page.getByTestId('cloud-todo-detail-title')).toHaveValue(issueTitle)
          await expect(comment).toContainText(commentMarker)
        } finally {
          await popup.close()
        }
      }

      // Exercise the source page after both popups, beyond checking its old DOM.
      await page.getByTestId('cloud-todo-detail-close').click()
      await expect(page).toHaveURL(projectPath)
      await page.getByTestId(`collaboration-issue-${issue.id}`).getByRole('button').first().click()
      await expect(page).toHaveURL(issuePath)
      await expect(page.getByTestId('collaboration-comments')).toContainText(commentMarker)
    } finally {
      if (project) {
        await archiveResource(page, `/api/v1/cloud-projects/${encodeURIComponent(project.id)}`)
      }
      await archiveResource(page, `/api/v1/workspaces/${encodeURIComponent(workspace.id)}`)
    }
  }
)
