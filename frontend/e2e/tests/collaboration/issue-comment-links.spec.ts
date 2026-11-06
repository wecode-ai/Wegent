// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createServer } from 'node:http'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { webApi, writeSharedComposer } from '../../utils/collaboration-test-support'

const GITHUB_URL = 'https://github.com/wecode-ai/Wegent/pull/3966'
const LONG_GITHUB_URL = `https://github.com/wecode-ai/Wegent/commit/${'a'.repeat(180)}`
const LONG_GITHUB_LABEL = `${LONG_GITHUB_URL}#source`
const DOCUMENT_TEXT = 'The Issue comment document opened in a separate page.'

interface Resource {
  id: string
  version: number
}

async function archiveResource(page: Page, path: string): Promise<void> {
  const resource = await webApi<Resource>(page, path)
  await webApi(page, `${path}?version=${resource.version}`, { method: 'DELETE' })
}

async function pasteSharedComposer(composer: Locator, text: string) {
  await expect
    .poll(() => composer.evaluate((element: HTMLElement) => element.isContentEditable))
    .toBe(true)
  await composer.click()
  await composer.evaluate((element: HTMLElement, value: string) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', value)
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
      })
    )
  }, text)
}

async function longLinkLayout(
  page: Page,
  linkTestId: string,
  containerSelector: string,
  labelSelector: string
) {
  return page.evaluate(
    ({ linkTestId, containerSelector, labelSelector }) => {
      const link = document.querySelector<HTMLElement>(`[data-testid="${linkTestId}"]`)
      const container = link?.closest<HTMLElement>(containerSelector)
      const label = link?.querySelector<HTMLElement>(labelSelector)
      const outer = document.querySelector<HTMLElement>('[data-testid="cloud-todo-detail-scroll"]')
      if (!link || !container || !label || !outer) {
        throw new Error('The long Issue comment link layout could not be measured')
      }

      const linkRect = link.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      const labelRect = label.getBoundingClientRect()
      const fontSize = Number.parseFloat(getComputedStyle(label).fontSize)
      const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight) || fontSize * 1.5
      return {
        linkRight: linkRect.right,
        containerRight: containerRect.right,
        labelHeight: labelRect.height,
        lineHeight,
        containerFits: container.scrollWidth <= container.clientWidth + 1,
        outerFits: outer.scrollWidth <= outer.clientWidth + 1,
        pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      }
    },
    { linkTestId, containerSelector, labelSelector }
  )
}

function expectWrappedInsideContainer(
  layout: Awaited<ReturnType<typeof longLinkLayout>>,
  label: string
) {
  expect(layout.linkRight, `${label} link escaped its container`).toBeLessThanOrEqual(
    layout.containerRight + 1
  )
  expect(layout.labelHeight, `${label} link label did not wrap`).toBeGreaterThan(
    layout.lineHeight * 1.5
  )
  expect(layout.containerFits, `${label} container overflowed horizontally`).toBe(true)
  expect(layout.outerFits, `${label} issue detail overflowed horizontally`).toBe(true)
  expect(layout.pageFits, `${label} page overflowed horizontally`).toBe(true)
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
        const navigationPromise = page
          .context()
          .waitForEvent(
            'request',
            request => request.isNavigationRequest() && request.url() === url
          )
        const popupPromise = page.waitForEvent('popup')
        await link.click()
        const popup = await popupPromise
        try {
          const navigation = await navigationPromise
          expect(navigation.frame()).toBe(popup.mainFrame())
          await expect(popup).toHaveURL(url)
          expect(await popup.evaluate(() => window.opener === null)).toBe(true)
          if (documentText) {
            await popup.waitForLoadState('load')
            await expect(popup).toHaveTitle('Issue comment document')
            await expect(popup.locator('body')).toHaveText(documentText)
          }
          // External content availability is independent of navigation: CI observed
          // HTTP 529 with the exact GitHub URL and an empty body. The real local
          // document above verifies page loading and content without that dependency.
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

commentTest(
  'wraps a long Issue comment link without widening the composer or activity layout',
  async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 900 })
    await page.goto('/collaboration')
    await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
    const suffix = crypto.randomUUID()
    const workspace = await webApi<Resource>(page, '/api/v1/workspaces', {
      method: 'POST',
      body: { name: `Long comment links ${suffix}` },
    })
    let project: Resource | undefined
    try {
      project = await webApi<Resource>(page, '/api/v1/cloud-projects', {
        method: 'POST',
        body: {
          workspace_id: workspace.id,
          name: `Long comment links ${suffix}`,
          task_provider: 'local',
          visibility: 'private',
        },
      })
      const issue = await webApi<Resource>(
        page,
        `/api/v1/cloud-projects/${project.id}/loop-items`,
        { method: 'POST', body: { title: `Long comment links ${suffix}` } }
      )
      await page.goto(
        `/collaboration/workspaces/${workspace.id}/projects/${project.id}/issues/${issue.id}`
      )
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()

      const composer = page.getByTestId('collaboration-issue-comment')
      const commentMarker = `Long persisted comment link ${suffix}`
      await pasteSharedComposer(
        composer,
        [commentMarker, `[${LONG_GITHUB_LABEL}](${LONG_GITHUB_URL})`].join('\n')
      )
      const composerLink = composer.getByTestId('composer-link-chip')
      await expect(composerLink).toHaveAttribute('data-composer-link-url', LONG_GITHUB_URL)
      expectWrappedInsideContainer(
        await longLinkLayout(
          page,
          'composer-link-chip',
          '[data-testid="collaboration-issue-comment"]',
          '.composer-mention-label'
        ),
        'Composer'
      )

      await page.getByTestId('collaboration-issue-comment-submit').click()
      await expect(page.getByTestId('collaboration-comments')).toContainText(commentMarker)
      await page.reload()

      const comment = page.locator('.task-detail-comment-card').filter({ hasText: commentMarker })
      const persistedLink = comment.getByTestId('composer-link-chip')
      await expect(persistedLink).toHaveAttribute('href', LONG_GITHUB_URL)
      expectWrappedInsideContainer(
        await longLinkLayout(
          page,
          'composer-link-chip',
          '.task-detail-comment-card',
          '.composer-mention-label'
        ),
        'Persisted comment'
      )
    } finally {
      if (project) {
        await archiveResource(page, `/api/v1/cloud-projects/${encodeURIComponent(project.id)}`)
      }
      await archiveResource(page, `/api/v1/workspaces/${encodeURIComponent(workspace.id)}`)
    }
  }
)
