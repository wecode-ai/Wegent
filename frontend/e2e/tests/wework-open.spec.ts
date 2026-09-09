import { expect, test } from '@playwright/test'

test.use({ storageState: { cookies: [], origins: [] } })

test('notification link opens the public Wegent launch page and preserves its target', async ({
  page,
}) => {
  const destination = 'wework://boards/12/issues/gitlab%3A12%2Fissue%233'
  const navigationRequests: string[] = []
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Page.enable')
  cdp.on('Page.frameRequestedNavigation', event => {
    if (event.url.startsWith('wework:')) navigationRequests.push(event.url)
  })
  const runtimeConfig = page.waitForResponse(response => response.url().endsWith('/runtime-config'))
  await page.goto(`/launch/wework?${new URLSearchParams({ destination })}`)
  expect((await runtimeConfig).ok()).toBe(true)
  await expect.poll(() => navigationRequests).toEqual([destination])
  const launch = page.getByTestId('open-wework')
  await expect(launch).toBeVisible()
  await expect(launch).toHaveAttribute('href', destination)
  await expect(page).toHaveURL(/\/launch\/wework\?/)
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(launch).toBeInViewport()
  const bounds = await launch.boundingBox()
  expect(bounds?.height).toBeGreaterThanOrEqual(44)
})

test('invalid target cannot launch an app and a corrected link recovers', async ({ page }) => {
  await page.goto('/launch/wework?destination=javascript%3Aalert(1)')
  await expect(page.getByTestId('open-wework-invalid')).toBeVisible()
  await expect(page.getByTestId('open-wework')).toHaveCount(0)
  await page.goto('/launch/wework?destination=wework%3A%2F%2Fboards')
  await expect(page.getByTestId('open-wework')).toHaveAttribute('href', 'wework://boards')
})
