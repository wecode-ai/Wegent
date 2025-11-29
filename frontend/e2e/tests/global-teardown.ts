import { test as teardown } from '@playwright/test'

/**
 * Global teardown - run once after all tests
 * Clean up test data if needed
 */
teardown('cleanup', async ({}) => {
  console.log('Global teardown - cleaning up test resources')

  // Add cleanup logic here if needed
  // For example: delete test-created resources via API

  console.log('Cleanup completed')
})
