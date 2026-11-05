import type { APIRequestContext } from '@playwright/test'
import { expect } from '@playwright/test'
import type { TestUser } from '../config/test-users'

export async function ensureE2EUser(
  request: APIRequestContext,
  bootstrapToken: string,
  user: TestUser,
  apiBaseUrl: string,
  bootstrapUsername: string
): Promise<void> {
  if (user.username === bootstrapUsername) {
    return
  }

  const headers = {
    Authorization: `Bearer ${bootstrapToken}`,
    'Content-Type': 'application/json',
  }

  const listResponse = await request.get(
    `${apiBaseUrl}/api/admin/users?page=1&limit=100&include_inactive=true&search=${encodeURIComponent(
      user.username
    )}`,
    {
      headers,
    }
  )
  expect(
    listResponse.ok(),
    `Failed to list users while provisioning ${user.username}: ${await listResponse.text()}`
  ).toBe(true)

  const listBody = (await listResponse.json()) as {
    items?: Array<{ id: number; user_name: string; role: string; is_active: boolean }>
  }
  const existingUser = listBody.items?.find(item => item.user_name === user.username)

  if (!existingUser) {
    const createResponse = await request.post(`${apiBaseUrl}/api/admin/users`, {
      headers,
      data: {
        user_name: user.username,
        password: user.password,
        role: user.role,
        auth_source: 'password',
      },
    })
    expect(
      createResponse.ok(),
      `Failed to create E2E user ${user.username}: ${await createResponse.text()}`
    ).toBe(true)
    return
  }

  if (existingUser.role !== user.role || !existingUser.is_active) {
    const updateResponse = await request.put(`${apiBaseUrl}/api/admin/users/${existingUser.id}`, {
      headers,
      data: {
        role: user.role,
        is_active: true,
      },
    })
    expect(
      updateResponse.ok(),
      `Failed to update E2E user ${user.username}: ${await updateResponse.text()}`
    ).toBe(true)
  }

  const resetResponse = await request.post(
    `${apiBaseUrl}/api/admin/users/${existingUser.id}/reset-password`,
    {
      headers,
      data: {
        new_password: user.password,
      },
    }
  )
  expect(
    resetResponse.ok(),
    `Failed to reset password for E2E user ${user.username}: ${await resetResponse.text()}`
  ).toBe(true)
}

export async function configurePetVisibility(
  request: APIRequestContext,
  token: string,
  apiBaseUrl: string
): Promise<void> {
  const url = `${apiBaseUrl}/api/users/me/pet`
  const headers = { Authorization: `Bearer ${token}` }
  // Provision the pet before updating its persisted visibility preference.
  const petResponse = await request.get(url, { headers })
  expect(petResponse.ok(), 'Failed to provision the E2E account pet').toBe(true)

  // Keep the optional draggable widget from covering controls in unrelated flows.
  const updateResponse = await request.put(url, { headers, data: { is_visible: false } })
  expect(updateResponse.ok(), 'Failed to configure E2E pet visibility').toBe(true)
  expect(await updateResponse.json()).toMatchObject({ is_visible: false })
}
