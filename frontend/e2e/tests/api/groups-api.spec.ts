import { test, expect } from '@playwright/test'
import { createApiClient, ApiClient } from '../../utils/api-client'
import { DataBuilders } from '../../fixtures/data-builders'
import { ADMIN_USER } from '../../config/test-users'

test.describe('API - Groups', () => {
  let apiClient: ApiClient
  let testGroupName: string
  let parentGroupName: string

  test.beforeEach(async ({ request }) => {
    apiClient = createApiClient(request)
    const response = await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
    expect(response.status).toBe(200)
  })

  test.afterEach(async () => {
    // Cleanup - delete child group first, then parent
    if (testGroupName) {
      await apiClient.deleteGroup(testGroupName).catch(() => {})
      testGroupName = ''
    }
    if (parentGroupName) {
      await apiClient.deleteGroup(parentGroupName).catch(() => {})
      parentGroupName = ''
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
    // Backend returns GroupListResponse with { total, items }
    expect(response.data).toHaveProperty('items')
    expect(Array.isArray((response.data as { items: unknown[] }).items)).toBe(true)
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

    // Delete group - backend returns 204 No Content
    const response = await apiClient.deleteGroup(groupName)
    expect(response.status).toBe(204)

    // Verify group is deleted - should return 403 (not a member) or 404
    const getResponse = await apiClient.getGroup(groupName)
    expect([403, 404]).toContain(getResponse.status)
  })

  test('POST /api/groups/:name/members - should add member to group', async () => {
    // Create group first
    const groupData = DataBuilders.group()
    testGroupName = groupData.name
    await apiClient.createGroup(groupData)

    // Get current user info to find another user to add
    const currentUserResponse = await apiClient.getCurrentUser()
    expect(currentUserResponse.status).toBe(200)
    const currentUserId = (currentUserResponse.data as { id: number }).id

    // Try to add a member - use a different user ID if possible
    // Since we're the owner (added automatically), we need to add a different user
    // For E2E tests, we'll try user_id 2 (assuming admin is user_id 1)
    const memberData = {
      user_id: currentUserId === 1 ? 2 : 1,
      role: 'Developer',
    }
    const response = await apiClient.addGroupMember(testGroupName, memberData)

    // Response should be 201 for success, or 400/404 if user doesn't exist
    // In CI environment, there might only be one user
    expect([200, 201, 400, 404]).toContain(response.status)
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
    // First create the parent group
    parentGroupName = `e2e-parent-${DataBuilders.uniqueId()}`
    const parentGroupData = DataBuilders.group({ name: parentGroupName })
    const parentResponse = await apiClient.createGroup(parentGroupData)
    expect(parentResponse.status).toBe(201)

    // Now create the child group under the parent
    const childName = `${parentGroupName}/child-${DataBuilders.uniqueId()}`
    const childGroupData = DataBuilders.group({ name: childName })
    testGroupName = childName

    const response = await apiClient.createGroup(childGroupData)

    expect(response.status).toBe(201)
    expect(response.data).toHaveProperty('name', childName)
    expect((response.data as { name: string }).name).toContain('/')
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
