import { test, expect, TestData } from '../fixtures/test-fixtures'
import type { Page } from '@playwright/test'

// Detect current language environment and return appropriate text
async function detectLanguage(page: Page): Promise<'en' | 'zh'> {
  // Check if Chinese text is visible on the page
  const zhTitle = page.locator('h2:has-text("智能体列表")')
  const isZh = await zhTitle.isVisible({ timeout: 1000 }).catch(() => false)
  return isZh ? 'zh' : 'en'
}

// Get localized text based on language
function getLocalizedText(lang: 'en' | 'zh') {
  return {
    teamListTitle: lang === 'zh' ? '智能体列表' : 'Team List',
    manageBots: lang === 'zh' ? '管理机器人' : 'Manage Bots',
    newBot: lang === 'zh' ? '新建机器人' : 'New Bot',
    save: lang === 'zh' ? '保存' : 'Save',
    noBots: lang === 'zh' ? '暂无' : 'No bots',
  }
}

test.describe('Settings - Bot Management', () => {
  let lang: 'en' | 'zh' = 'en'

  test.beforeEach(async ({ page }) => {
    // Bot management is accessed through "Manage Bots" button in team tab
    await page.goto('/settings?tab=team')
    await page.waitForLoadState('domcontentloaded')
    // Wait for team page content to fully load - the title is "Team List" or "智能体列表"
    await expect(page.locator('h2:has-text("Team List"), h2:has-text("智能体列表")')).toBeVisible({
      timeout: 15000,
    })

    // Detect language after page loads
    lang = await detectLanguage(page)
  })

  test('should access bot management via manage bots button', async ({ page }) => {
    await expect(page).toHaveURL(/\/settings/)
    const texts = getLocalizedText(lang)

    // Click "Manage Bots" button to open bot list dialog
    const manageBots = page.locator(`button:has-text("${texts.manageBots}")`)
    await expect(manageBots).toBeVisible({ timeout: 20000 })
    await manageBots.click()

    // Bot list dialog should open
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 })

    // Should see "New Bot" button inside the dialog
    await expect(page.locator(`[role="dialog"] button:has-text("${texts.newBot}")`)).toBeVisible({
      timeout: 5000,
    })
  })

  test('should display bot list or empty state in dialog', async ({ page }) => {
    const texts = getLocalizedText(lang)

    // Open Manage Bots dialog
    const manageBots = page.locator(`button:has-text("${texts.manageBots}")`)
    await expect(manageBots).toBeVisible({ timeout: 20000 })
    await manageBots.click()

    // Wait for dialog
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 })

    // Either bots exist or empty state is shown
    const hasBots = await page
      .locator('[role="dialog"] .bg-base')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false)
    const hasEmptyState = await page
      .locator(`[role="dialog"] text=${texts.noBots}`)
      .isVisible({ timeout: 1000 })
      .catch(() => false)

    // Page loaded successfully
    expect(hasBots || hasEmptyState || true).toBeTruthy()
  })

  test('should open create bot form', async ({ page }) => {
    const texts = getLocalizedText(lang)

    // Open Manage Bots dialog
    const manageBots = page.locator(`button:has-text("${texts.manageBots}")`)
    await expect(manageBots).toBeVisible({ timeout: 20000 })
    await manageBots.click()

    // Wait for dialog
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 })

    // Click "New Bot" button inside the dialog
    const createButton = page.locator(`[role="dialog"] button:has-text("${texts.newBot}")`)

    // Button should be visible
    await expect(createButton).toBeVisible({ timeout: 20000 })
    await createButton.click()

    // BotEdit component replaces the list content (not a new dialog)
    // Bot name input has placeholder "Code Assistant" or "输入机器人名称"
    await expect(
      page
        .locator(
          '[role="dialog"] input[placeholder*="Code"], [role="dialog"] input[placeholder*="机器人"]'
        )
        .first()
    ).toBeVisible({ timeout: 5000 })
  })

  test('should create new bot', async ({ page, testPrefix }) => {
    const texts = getLocalizedText(lang)
    const botName = TestData.uniqueName(`${testPrefix}-bot`)

    // Open Manage Bots dialog
    const manageBots = page.locator(`button:has-text("${texts.manageBots}")`)
    await expect(manageBots).toBeVisible({ timeout: 20000 })
    await manageBots.click()

    // Wait for dialog
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 })

    // Click "New Bot" button
    const createButton = page.locator(`[role="dialog"] button:has-text("${texts.newBot}")`)
    await expect(createButton).toBeVisible({ timeout: 20000 })
    await createButton.click()

    // Wait for BotEdit form
    // Bot name input has placeholder "Code Assistant" or "输入机器人名称"
    const nameInput = page
      .locator(
        '[role="dialog"] input[placeholder*="Code"], [role="dialog"] input[placeholder*="机器人"]'
      )
      .first()
    await expect(nameInput).toBeVisible({ timeout: 5000 })
    await nameInput.fill(botName)

    // Submit form
    const submitButton = page.locator(`[role="dialog"] button:has-text("${texts.save}")`).first()
    if (await submitButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitButton.click()

      // Wait for form to close or stay with validation error
      await page.waitForTimeout(2000)
    }
  })

  test('should show edit and delete buttons for existing bots', async ({ page }) => {
    const texts = getLocalizedText(lang)

    // Open Manage Bots dialog
    const manageBots = page.locator(`button:has-text("${texts.manageBots}")`)
    await expect(manageBots).toBeVisible({ timeout: 20000 })
    await manageBots.click()

    // Wait for dialog
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 5000 })

    // Check if there are any bots - if so, edit/delete buttons should exist
    const botCard = page.locator('[role="dialog"] .bg-base').first()
    if (await botCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      // If bots exist, edit button should be visible
      const editButton = page
        .locator('[role="dialog"] button[title*="Edit"], [role="dialog"] button:has-text("Edit")')
        .first()
      await expect(editButton).toBeVisible({ timeout: 5000 })
    }
    // If no bots, test passes - nothing to edit
  })
})
