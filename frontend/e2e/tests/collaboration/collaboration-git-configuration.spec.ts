import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import type { DeviceListResponse } from '../../../src/apis/devices'
import { selectCollaborationProjectView, webApi } from '../../utils/collaboration-test-support'

interface Resource {
  id: string
  version: number
}

// The server is a real Git authentication boundary; no Backend or executor API is mocked.
// This spec is discovered by the default Chromium CI project.
test('execution environment Git errors open domain-specific settings and keep the original project', async ({
  page,
}) => {
  let responseStatus = 401
  const server = createServer((_request, response) => {
    response.writeHead(
      responseStatus,
      responseStatus === 401 ? { 'www-authenticate': 'Basic realm="Private Git repository"' } : {}
    )
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const domain = `127.0.0.1:${(server.address() as AddressInfo).port}`
  let workspace: Resource | undefined
  let project: Resource | undefined
  try {
    await page.goto('/collaboration')
    await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
    workspace = await webApi<Resource>(page, '/api/v1/workspaces', {
      method: 'POST',
      body: { name: `Git guidance ${crypto.randomUUID()}` },
    })
    project = await webApi<Resource>(page, '/api/v1/cloud-projects', {
      method: 'POST',
      body: {
        name: 'Git configuration recovery',
        workspace_id: workspace.id,
        task_provider: 'local',
      },
    })
    project = await webApi<Resource>(page, `/api/v1/cloud-projects/${project.id}`, {
      method: 'PATCH',
      body: {
        version: project.version,
        execution_environment: {
          repositories: [
            {
              name: 'private',
              url: `http://${domain}/private.git`,
              ref: 'main',
              path: 'private',
              primary: true,
            },
          ],
          setup_steps: [],
        },
      },
    })
    const { items } = await webApi<DeviceListResponse>(page, '/api/devices')
    const deviceKey =
      process.env.E2E_DEVICE_ID ||
      (process.env.E2E_SHARD_INDEX
        ? `e2e-platform-device-${process.env.E2E_SHARD_INDEX}`
        : 'e2e-claudecode-device')
    const device = items.find(item => item.device_id === deviceKey)
    expect(device, `Expected registered test executor ${deviceKey}`).toBeDefined()
    const projectPath = `/collaboration/workspaces/${workspace.id}/projects/${project.id}`
    await page.goto(projectPath)
    await selectCollaborationProjectView(page, 'manage')
    await page.getByTestId('collaboration-project-settings-environments').click()
    const prefix = 'collaboration-project-execution-environment'
    await page.getByTestId(`${prefix}-add`).click()
    await page.getByTestId(`${prefix}-candidate-${device!.id}`).click()
    await page.getByTestId(`${prefix}-actions-toggle-${device!.id}`).click()
    const initialize = page.getByTestId(`${prefix}-initialize-${device!.id}`)
    await initialize.click()
    const configure = page.getByTestId(`${prefix}-configure-git`)
    await expect(configure).toBeVisible()
    await expect(page.getByTestId(`${prefix}-environment-error`)).toContainText(domain)
    await expect(page.getByTestId(`${prefix}-environment-error`)).not.toContainText('git-access:')

    const popupPromise = page.waitForEvent('popup')
    await configure.click()
    const settings = await popupPromise
    await expect(settings.getByTestId('git-account-domain-input')).toHaveValue(domain)
    const settingsUrl = new URL(settings.url())
    expect(settingsUrl.pathname).toBe('/settings')
    expect(settingsUrl.searchParams.get('gitDomain')).toBe(domain)
    expect(settingsUrl.hash).toBe('#git-accounts')
    await settings.getByTestId('gitee-platform-radio').click()
    await expect(settings.getByTestId('git-account-domain-input')).toHaveValue(domain)
    await settings.close()
    await expect(page).toHaveURL(new RegExp(project.id))
    await expect(configure).toBeVisible()

    responseStatus = 404
    await initialize.click()
    await expect(page.getByTestId(`${prefix}-${device!.id}`)).toHaveAttribute(
      'data-preparation-state',
      'error'
    )
    await expect(configure).toHaveCount(0)
    await expect(page.getByTestId(`${prefix}-environment-error`)).toContainText(
      /权限|access|repository/i
    )
  } finally {
    try {
      for (const path of [
        ...(project ? [`/api/v1/cloud-projects/${project.id}`] : []),
        ...(workspace ? [`/api/v1/workspaces/${workspace.id}`] : []),
      ]) {
        const current = await webApi<Resource>(page, path)
        await webApi(page, `${path}?version=${current.version}`, { method: 'DELETE' })
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    }
  }
})
