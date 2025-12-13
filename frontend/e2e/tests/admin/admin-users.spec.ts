import { test, expect } from '@playwright/test';
import { AdminPage } from '../../pages/admin/admin.page';
import { LoginPage } from '../../pages/auth/login.page';
import { createApiClient, ApiClient } from '../../utils/api-client';
import { DataBuilders } from '../../fixtures/data-builders';
import { ADMIN_USER, REGULAR_USER } from '../../config/test-users';

test.describe('Admin - User Management', () => {
  let adminPage: AdminPage;
  let apiClient: ApiClient;
  let testUsername: string;

  test.beforeEach(async ({ page, request }) => {
    adminPage = new AdminPage(page);
    apiClient = createApiClient(request);
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password);

    // Navigate directly to admin page (already authenticated via global setup)
    await adminPage.navigateToTab('users');
  });

  test.afterEach(async () => {
    // Cleanup: delete test user if created
    if (testUsername) {
      // Find user ID and delete via API
      const usersResponse = await apiClient.adminListUsers();
      if (usersResponse.data) {
        const users =
          (usersResponse.data as { items?: Array<{ id: number; user_name: string }> }).items || [];
        const testUser = users.find(u => u.user_name === testUsername);
        if (testUser) {
          await apiClient.adminDeleteUser(testUser.id).catch(() => {});
        }
      }
      testUsername = '';
    }
  });

  test('should access admin user management page', async () => {
    expect(adminPage.isOnAdminPage()).toBe(true);

    // Should see user list title
    await expect(
      adminPage['page'].locator('h2:has-text("Users"), h2:has-text("用户")')
    ).toBeVisible({
      timeout: 10000,
    });
  });

  test('should display user list', async () => {
    const userCount = await adminPage.getUserCount();
    expect(userCount).toBeGreaterThanOrEqual(1); // At least admin user exists
  });

  test('should open create user dialog', async () => {
    await adminPage.clickCreateUser();

    // Dialog should be visible
    await expect(adminPage['page'].locator('[role="dialog"]')).toBeVisible();

    // Should have username input
    await expect(
      adminPage['page'].locator(
        '[role="dialog"] input[placeholder*="user"], [role="dialog"] input#user_name'
      )
    ).toBeVisible();
  });

  test('should create a new user', async () => {
    testUsername = DataBuilders.uniqueName('e2e-user');

    await adminPage.clickCreateUser();
    await adminPage.fillUserForm({
      username: testUsername,
      password: 'Test@12345',
      role: 'user',
    });
    await adminPage.submitUserForm();

    // Wait for toast or dialog to close
    await adminPage.waitForToast().catch(() => {});

    // Verify user appears in list
    await adminPage['page'].reload();
    await adminPage.waitForPageLoad();

    const exists = await adminPage.userExists(testUsername);
    expect(exists).toBe(true);
  });

  test('should search for users', async () => {
    // Search for admin user
    await adminPage.searchUser('admin');

    // Admin user should be visible
    const exists = await adminPage.userExists('admin');
    expect(exists).toBe(true);
  });

  test('should show edit dialog for existing user', async () => {
    // Create a test user first via API
    testUsername = DataBuilders.uniqueName('e2e-edit-user');
    await apiClient.adminCreateUser({
      user_name: testUsername,
      password: 'Test@12345',
      role: 'user',
    });

    // Refresh page
    await adminPage['page'].reload();
    await adminPage.waitForPageLoad();

    // Click edit
    await adminPage.clickEditUser(testUsername);

    // Dialog should be visible
    await expect(adminPage['page'].locator('[role="dialog"]')).toBeVisible();
  });

  test('should delete a user', async () => {
    // Create a test user first via API
    testUsername = DataBuilders.uniqueName('e2e-delete-user');
    await apiClient.adminCreateUser({
      user_name: testUsername,
      password: 'Test@12345',
      role: 'user',
    });

    // Refresh page
    await adminPage['page'].reload();
    await adminPage.waitForPageLoad();

    // Delete user
    await adminPage.clickDeleteUser(testUsername);
    await adminPage.confirmDelete();

    // Wait for toast
    await adminPage.waitForToast().catch(() => {});

    // Verify user is gone
    await adminPage['page'].reload();
    await adminPage.waitForPageLoad();

    const exists = await adminPage.userExists(testUsername);
    expect(exists).toBe(false);

    // Clear testUsername as it's already deleted
    testUsername = '';
  });

  test('should validate required fields when creating user', async () => {
    await adminPage.clickCreateUser();

    // Try to submit without filling required fields
    await adminPage.submitUserForm();

    // Dialog should still be visible (validation failed)
    await expect(adminPage['page'].locator('[role="dialog"]')).toBeVisible();
  });
});

test.describe('Admin - Access Control', () => {
  test('should deny access to non-admin users', async ({ page, request }) => {
    const adminPage = new AdminPage(page);
    const loginPage = new LoginPage(page);
    const apiClient = createApiClient(request);

    // First, ensure regular user exists
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password);

    // Try to create regular user (may already exist)
    await apiClient
      .adminCreateUser({
        user_name: REGULAR_USER.username,
        password: REGULAR_USER.password,
        role: 'user',
      })
      .catch(() => {});

    // Login as regular user
    await loginPage.login(REGULAR_USER.username, REGULAR_USER.password);

    // Try to access admin page
    await adminPage.navigate();

    // Should see access denied message
    const isAccessDenied = await adminPage.isAccessDenied();
    expect(isAccessDenied).toBe(true);
  });
});
