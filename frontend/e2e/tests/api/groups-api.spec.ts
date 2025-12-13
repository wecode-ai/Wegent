import { test, expect } from '@playwright/test'
import { createApiClient, ApiClient } from '../../utils/api-client'
import { DataBuilders } from '../../fixtures/data-builders'
import { ADMIN_USER } from '../../config/test-users'

test.describe('API - Groups', () => {
  let apiClient: ApiClient
  let testGroupName: string

  test.beforeAll(async ({ request }) => {
    apiClient = createApiClient(request)
    const response = await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
    expect(response.status).toBe(200)
  })

  test.afterEach(async () => {
    // Cleanup
    if (testGroupName) {
      await apiClient.deleteGroup(testGroupName).catch(() => {})
      testGroupName = ''
    }
  })

  test('POST /api/groups - should create a group', async () => {
    const groupData = DataBuilders.group()
    testGroupName = groupData.name

    const response = await apiClient.createGroup(groupData)

    expect(response.status).toBe(201)
    expect(response.data).toHaveProperty('name', groupData.name)
  })

  test('GET /api/groups - should list all groups', async () => {
    const response = await apiClient.getGroups()

    expect(response.status).toBe(200)
    expect(Array.isArray(response.data)).toBe(true)
  })

  test('GET /api/groups/:name - should get group by name', async () => {
    // Create group first
    const groupData = DataBuilders.group()
    testGroupName = groupData.name
    await apiClient.createGroup(groupData)

    const response = await apiClient.getGroup(testGroupName)

    expect(response.status).toBe(200)
    expect(response.data).toHaveProperty('name', testGroupName)
  })

  test('PUT /api/groups/:name - should update group', async () => {
    // Create group first
    const groupData = DataBuilders.group()
    testGroupName = groupData.name
    await apiClient.createGroup(groupData)

    // Update group
    const updateData = {
      display_name: 'Updated Display Name',
      description: 'Updated description',
    }
    const response = await apiClient.updateGroup(testGroupName, updateData)

    expect(response.status).toBe(200)
    expect(response.data).toHaveProperty('display_name', updateData.display_name)
  })

  test('DELETE /api/groups/:name - should delete group', async () => {
    // Create group first
    const groupData = DataBuilders.group()
    const groupName = groupData.name
    await apiClient.createGroup(groupData)

    // Delete group
    const response = await apiClient.deleteGroup(groupName)
    expect(response.status).toBe(200)

    // Verify group is deleted
    const getResponse = await apiClient.getGroup(groupName)
    expect(getResponse.status).toBe(404)
  })

  test('POST /api/groups/:name/members - should add member to group', async () => {
    // Create group first
    const groupData = DataBuilders.group()
    testGroupName = groupData.name
    await apiClient.createGroup(groupData)

    // Note: This test assumes a user with ID 1 exists
    // In a real scenario, you might need to create a test user first
    const memberData = {
      user_id: 1,
      role: 'developer',
    }
    const response = await apiClient.addGroupMember(testGroupName, memberData)

    // Response should be 201 or 200 depending on implementation
    expect([200, 201]).toContain(response.status)
  })

  test('GET /api/groups/:name/members - should get group members', async () => {
    // Create group first
    const groupData = DataBuilders.group()
    testGroupName = groupData.name
    await apiClient.createGroup(groupData)

    const response = await apiClient.getGroupMembers(testGroupName)

    expect(response.status).toBe(200)
    expect(Array.isArray(response.data)).toBe(true)
  })

  test('should validate hierarchical group names', async () => {
    const hierarchicalName = DataBuilders.hierarchicalGroupName(2)
    const groupData = DataBuilders.group({ name: hierarchicalName })
    testGroupName = hierarchicalName

    const response = await apiClient.createGroup(groupData)

    expect(response.status).toBe(201)
    expect(response.data).toHaveProperty('name', hierarchicalName)
    expect(response.data.name).toContain('/')
  })

  test('should reject duplicate group names', async () => {
    // Create group first
    const groupData = DataBuilders.group()
    testGroupName = groupData.name
    await apiClient.createGroup(groupData)

    // Try to create group with same name
    const response = await apiClient.createGroup(groupData)
    expect([400, 409]).toContain(response.status)
  })
})
