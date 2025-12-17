/**
 * E2E Tests for Media File Chat Functionality
 *
 * Tests the ability to upload and chat with different media file types:
 * 1. Image files (PNG, JPG)
 * 2. PDF files
 * 3. DOCX files (Word documents)
 * 4. PPTX files (PowerPoint presentations)
 *
 * Test objectives:
 * 1. Verify requests return successfully
 * 2. Verify non-image attachments (PDF/DOCX/PPTX) have their content extracted and sent to the model
 * 3. Verify image attachments are sent in the correct format (base64 or image_url)
 *
 * IMPORTANT: File upload is only available for Chat Shell teams (agent_type === 'chat').
 * These tests require a Chat type team to exist in the backend with a model configured.
 */

import { test, expect, Page } from '@playwright/test';
import { createApiClient, ApiClient } from '../../utils/api-client';
import { ADMIN_USER } from '../../config/test-users';
import * as path from 'path';

// Test file paths
const FIXTURES_DIR = path.join(__dirname, '../../fixtures/media');
const TEST_IMAGE_PATH = path.join(FIXTURES_DIR, 'test-image.png');
const TEST_PDF_PATH = path.join(FIXTURES_DIR, 'test-document.pdf');
const TEST_DOCX_PATH = path.join(FIXTURES_DIR, 'test-document.docx');
const TEST_PPTX_PATH = path.join(FIXTURES_DIR, 'test-presentation.pptx');

// Mock model server URL for request verification
const MOCK_MODEL_SERVER_URL = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999';

// Timeout for waiting for file upload and processing
const FILE_UPLOAD_TIMEOUT = 10000;
const CHAT_RESPONSE_TIMEOUT = 30000;

/**
 * Interface for recorded request from mock model server
 */
interface RecordedRequest {
  timestamp: number;
  endpoint: string;
  body: Record<string, unknown>;
  hasImageContent: boolean;
  hasTextContent: boolean;
  extractedTextLength: number;
  imageFormat: string | null;
}

/**
 * Helper to get recorded requests from mock model server
 */
async function getRecordedRequests(): Promise<RecordedRequest[]> {
  try {
    const response = await fetch(`${MOCK_MODEL_SERVER_URL}/requests`);
    if (response.ok) {
      const data = await response.json();
      return data.requests || [];
    }
  } catch (error) {
    console.log('Failed to get recorded requests:', error);
  }
  return [];
}

/**
 * Helper to clear recorded requests from mock model server
 */
async function clearRecordedRequests(): Promise<void> {
  try {
    await fetch(`${MOCK_MODEL_SERVER_URL}/requests`, { method: 'DELETE' });
  } catch (error) {
    console.log('Failed to clear recorded requests:', error);
  }
}

/**
 * Helper to get the latest request from mock model server
 */
async function getLatestRequest(): Promise<RecordedRequest | null> {
  const requests = await getRecordedRequests();
  return requests.length > 0 ? requests[requests.length - 1] : null;
}

/**
 * Helper to select a Chat type team from the QuickAccessCards or dropdown.
 * File upload is only available for Chat Shell teams (agent_type === 'chat').
 *
 * The /chat page uses QuickAccessCards component for team selection:
 * 1. First try to find chat-team in the quick access cards
 * 2. If not found, click "More" button and search in dropdown
 *
 * Throws error if chat-team cannot be selected.
 */
async function selectChatTeam(page: Page): Promise<void> {
  // Wait for the page to fully load and teams to be fetched
  await page.waitForTimeout(1000);

  // Strategy 1: Try to find chat-team in QuickAccessCards (displayed as rounded pill buttons)
  // QuickAccessCards renders team cards with the team name as text
  const chatTeamCard = page
    .locator('div:has-text("chat-team")')
    .filter({
      has: page.locator('span.text-sm.font-medium'),
    })
    .first();

  if (await chatTeamCard.isVisible({ timeout: 3000 }).catch(() => false)) {
    await chatTeamCard.click();
    await page.waitForTimeout(1000);
    return;
  }

  // Strategy 2: Click "More" button to open dropdown and search for chat-team
  // The "More" button contains text from i18n key 'teams.more'
  const moreButton = page.locator('button:has-text("More"), button:has-text("更多")').first();

  if (await moreButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await moreButton.click();
    await page.waitForTimeout(500);

    // Search for chat-team in the dropdown
    const searchInput = page
      .locator('input[placeholder*="Search"], input[placeholder*="搜索"]')
      .first();
    if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await searchInput.fill('chat-team');
      await page.waitForTimeout(500);
    }

    // Click on chat-team in the dropdown list
    const chatTeamOption = page
      .locator('div:has-text("chat-team")')
      .filter({
        has: page.locator('span.text-sm.font-medium.truncate'),
      })
      .first();

    if (await chatTeamOption.isVisible({ timeout: 3000 }).catch(() => false)) {
      await chatTeamOption.click();
      await page.waitForTimeout(1000);
      return;
    }

    // Close dropdown if chat-team not found
    await page.keyboard.press('Escape');
  }

  // Strategy 3: Check if chat-team is already selected (shown in SelectedTeamBadge)
  // The SelectedTeamBadge shows the currently selected team name
  const selectedBadge = page
    .locator('[class*="badge"]:has-text("chat-team"), span:has-text("chat-team")')
    .first();
  if (await selectedBadge.isVisible({ timeout: 2000 }).catch(() => false)) {
    // chat-team is already selected
    return;
  }

  // If we reach here, chat-team could not be found or selected
  throw new Error('chat-team not found - ensure chat-team exists in the backend init data');
}

/**
 * Helper to get file input element.
 * Throws error if file input is not found.
 */
async function getFileInput(page: Page): Promise<ReturnType<Page['locator']>> {
  const fileInput = page.locator('input[type="file"]').first();

  // File inputs are usually hidden, so we check for attachment (state: 'attached')
  // instead of waiting for visibility
  await fileInput.waitFor({ state: 'attached', timeout: 5000 });
  return fileInput;
}

/**
 * Helper to upload a file and wait for it to be processed.
 * Throws error if upload fails.
 */
async function uploadFile(page: Page, filePath: string): Promise<void> {
  const fileInput = await getFileInput(page);
  await fileInput.setInputFiles(filePath);
  // Wait for upload to complete (look for attachment preview or success indicator)
  await page.waitForTimeout(2000);
}

/**
 * Helper to check if attachment preview is visible
 */
async function isAttachmentPreviewVisible(page: Page): Promise<boolean> {
  const selectors = [
    '[data-testid="attachment"]',
    '[data-testid="attachment-preview"]',
    '.attachment-preview',
    '[class*="attachment"]',
    // File name or icon indicators
    '[data-testid="file-preview"]',
  ];

  for (const selector of selectors) {
    const element = page.locator(selector).first();
    try {
      const visible = await element.isVisible({ timeout: 2000 });
      if (visible) return true;
    } catch {
      // Continue to next selector
    }
  }

  return false;
}

/**
 * Helper to send a chat message.
 * Throws error if chat input is not found.
 */
async function sendChatMessage(page: Page, message: string): Promise<void> {
  // Find the chat input
  const inputSelectors = [
    '[data-testid="chat-input"]',
    '[data-testid="message-input"]',
    'textarea[placeholder*="message" i]',
    '[contenteditable="true"]',
    'div[role="textbox"]',
  ];

  let inputElement = null;
  for (const selector of inputSelectors) {
    const element = page.locator(selector).first();
    try {
      const visible = await element.isVisible({ timeout: 2000 });
      if (visible) {
        inputElement = element;
        break;
      }
    } catch {
      // Continue to next selector
    }
  }

  if (!inputElement) {
    throw new Error('Chat input not found');
  }

  await inputElement.fill(message);
  await page.waitForTimeout(500);

  // Find and click send button
  const sendButton = page.locator(
    '[data-testid="send-button"], button[type="submit"], button:has-text("Send"), button[aria-label*="send" i]'
  );
  if (await sendButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await sendButton.click();
  } else {
    // Try pressing Enter
    await inputElement.press('Enter');
  }
}

/**
 * Helper to wait for assistant response
 */
async function waitForAssistantResponse(page: Page, timeout: number = 15000): Promise<void> {
  const responseLocator = page.locator(
    '[data-role="assistant"], [data-testid="message-response"], .message-response'
  );
  await responseLocator.first().waitFor({ state: 'visible', timeout });
}

test.describe('Media File Chat Functionality', () => {
  let apiClient: ApiClient;

  test.beforeEach(async ({ page, request }) => {
    apiClient = createApiClient(request);
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password);

    // Navigate to chat page
    await page.goto('/chat');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Select chat-team (required for file upload functionality)
    await selectChatTeam(page);
  });

  test.describe('Image File Upload', () => {
    test('should have file upload button for images', async ({ page }) => {
      const fileInput = await getFileInput(page);
      expect(fileInput).toBeTruthy();

      const acceptAttr = await fileInput.getAttribute('accept');
      // File input should accept image types (among others)
      expect(acceptAttr).toBeTruthy();
    });

    test('should upload PNG image file', async ({ page }) => {
      await uploadFile(page, TEST_IMAGE_PATH);

      // Check for attachment preview or any indication of successful upload
      const hasPreview = await isAttachmentPreviewVisible(page);
      expect(hasPreview).toBe(true);
    });

    test('should display image preview after upload', async ({ page }) => {
      const fileInput = await getFileInput(page);
      await fileInput.setInputFiles(TEST_IMAGE_PATH);
      await page.waitForTimeout(FILE_UPLOAD_TIMEOUT / 2);

      // Look for image preview element
      const imagePreview = page.locator(
        'img[src*="attachment"], img[src*="blob"], img[alt*="preview" i], [class*="attachment"]'
      );
      const hasImagePreview = await imagePreview.count();

      // Image preview should be visible
      expect(hasImagePreview).toBeGreaterThan(0);
    });

    test('should send message with image attachment and receive response', async ({ page }) => {
      await uploadFile(page, TEST_IMAGE_PATH);
      await sendChatMessage(page, 'Please analyze this image');

      // Wait for assistant response
      await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

      // Verify response exists
      const responseCount = await page
        .locator('[data-role="assistant"], [data-testid="message-response"], .message-response')
        .count();
      expect(responseCount).toBeGreaterThan(0);
    });
  });

  test.describe('PDF File Upload', () => {
    test('should upload PDF file', async ({ page }) => {
      await uploadFile(page, TEST_PDF_PATH);

      const hasPreview = await isAttachmentPreviewVisible(page);
      expect(hasPreview).toBe(true);
    });

    test('should display PDF file icon after upload', async ({ page }) => {
      const fileInput = await getFileInput(page);
      await fileInput.setInputFiles(TEST_PDF_PATH);
      await page.waitForTimeout(FILE_UPLOAD_TIMEOUT / 2);

      // Look for PDF icon or file type indicator or attachment preview
      const pdfIndicator = page.locator(
        '[class*="pdf"], [data-file-type="pdf"], [title*="PDF" i], [class*="attachment"]'
      );
      const hasPdfIndicator = await pdfIndicator.count();

      expect(hasPdfIndicator).toBeGreaterThan(0);
    });

    test('should send message with PDF attachment and receive response', async ({ page }) => {
      await uploadFile(page, TEST_PDF_PATH);
      await sendChatMessage(page, 'Please summarize this PDF document');

      // Wait for assistant response
      await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

      const responseCount = await page
        .locator('[data-role="assistant"], [data-testid="message-response"]')
        .count();
      expect(responseCount).toBeGreaterThan(0);
    });
  });

  test.describe('DOCX File Upload', () => {
    test('should upload DOCX (Word) file', async ({ page }) => {
      await uploadFile(page, TEST_DOCX_PATH);

      const hasPreview = await isAttachmentPreviewVisible(page);
      expect(hasPreview).toBe(true);
    });

    test('should display Word document icon after upload', async ({ page }) => {
      const fileInput = await getFileInput(page);
      await fileInput.setInputFiles(TEST_DOCX_PATH);
      await page.waitForTimeout(FILE_UPLOAD_TIMEOUT / 2);

      // Look for Word/DOCX icon or file type indicator or attachment preview
      const docxIndicator = page.locator(
        '[class*="docx"], [class*="word"], [data-file-type="docx"], [class*="attachment"]'
      );
      const hasDocxIndicator = await docxIndicator.count();

      expect(hasDocxIndicator).toBeGreaterThan(0);
    });

    test('should send message with DOCX attachment and receive response', async ({ page }) => {
      await uploadFile(page, TEST_DOCX_PATH);
      await sendChatMessage(page, 'Please review this Word document');

      // Wait for assistant response
      await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

      const responseCount = await page
        .locator('[data-role="assistant"], [data-testid="message-response"]')
        .count();
      expect(responseCount).toBeGreaterThan(0);
    });
  });

  test.describe('PPTX File Upload', () => {
    test('should upload PPTX (PowerPoint) file', async ({ page }) => {
      await uploadFile(page, TEST_PPTX_PATH);

      const hasPreview = await isAttachmentPreviewVisible(page);
      expect(hasPreview).toBe(true);
    });

    test('should display PowerPoint icon after upload', async ({ page }) => {
      const fileInput = await getFileInput(page);
      await fileInput.setInputFiles(TEST_PPTX_PATH);
      await page.waitForTimeout(FILE_UPLOAD_TIMEOUT / 2);

      // Look for PowerPoint/PPTX icon or file type indicator or attachment preview
      const pptxIndicator = page.locator(
        '[class*="pptx"], [class*="powerpoint"], [data-file-type="pptx"], [class*="attachment"]'
      );
      const hasPptxIndicator = await pptxIndicator.count();

      expect(hasPptxIndicator).toBeGreaterThan(0);
    });

    test('should send message with PPTX attachment and receive response', async ({ page }) => {
      await uploadFile(page, TEST_PPTX_PATH);
      await sendChatMessage(page, 'Please analyze this presentation');

      // Wait for assistant response
      await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

      const responseCount = await page
        .locator('[data-role="assistant"], [data-testid="message-response"]')
        .count();
      expect(responseCount).toBeGreaterThan(0);
    });
  });

  test.describe('Common File Upload Behaviors', () => {
    test('should show upload progress indicator', async ({ page }) => {
      const fileInput = await getFileInput(page);

      // Watch for network request
      const uploadPromise = page.waitForResponse(
        response => response.url().includes('/api/attachments') && response.status() === 200,
        { timeout: FILE_UPLOAD_TIMEOUT }
      );

      await fileInput.setInputFiles(TEST_PDF_PATH);

      // Wait for upload to complete
      const response = await uploadPromise;
      expect(response.status()).toBe(200);
    });

    test('should have remove button for uploaded files', async ({ page }) => {
      await uploadFile(page, TEST_IMAGE_PATH);
      await page.waitForTimeout(2000);

      // Look for remove/delete button
      const removeButton = page.locator(
        'button[title*="Remove" i], button[title*="Delete" i], button[aria-label*="remove" i], button:has-text("×"), button:has-text("✕"), [class*="attachment"] button'
      );
      const hasRemoveButton = await removeButton.isVisible({ timeout: 3000 });

      expect(hasRemoveButton).toBe(true);
    });

    test('should clear attachment when remove button clicked', async ({ page }) => {
      await uploadFile(page, TEST_IMAGE_PATH);
      await page.waitForTimeout(2000);

      const hasPreviewBefore = await isAttachmentPreviewVisible(page);
      expect(hasPreviewBefore).toBe(true);

      // Click remove button
      const removeButton = page
        .locator(
          'button[title*="Remove" i], button[title*="Delete" i], button[aria-label*="remove" i], button:has-text("×"), [class*="attachment"] button'
        )
        .first();

      await removeButton.click();
      await page.waitForTimeout(1000);

      // Attachment should be removed
      const hasPreviewAfter = await isAttachmentPreviewVisible(page);
      expect(hasPreviewAfter).toBe(false);
    });

    test('should validate file type before upload', async ({ page }) => {
      // File input should have accept attribute limiting file types
      const fileInput = await getFileInput(page);

      const acceptAttr = await fileInput.getAttribute('accept');
      expect(acceptAttr).toBeTruthy();

      // Should include supported types
      const supportedTypes = [
        '.pdf',
        '.docx',
        '.pptx',
        '.png',
        '.jpg',
        'image/',
        'application/pdf',
      ];
      const hasValidAccept = supportedTypes.some(type =>
        acceptAttr!.toLowerCase().includes(type.toLowerCase())
      );
      expect(hasValidAccept).toBe(true);
    });
  });

  test.describe('Multiple File Handling', () => {
    test('should handle sequential file uploads', async ({ page }) => {
      const fileInput = await getFileInput(page);

      // Upload first file
      await fileInput.setInputFiles(TEST_IMAGE_PATH);
      await page.waitForTimeout(2000);

      // Send message
      await sendChatMessage(page, 'First file');
      await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

      // Upload second file (if UI allows)
      await fileInput.setInputFiles(TEST_PDF_PATH);
      await page.waitForTimeout(2000);

      // Verify second file is attached
      const hasPreview = await isAttachmentPreviewVisible(page);
      expect(hasPreview).toBe(true);
    });
  });
});

test.describe('Media Chat Integration Tests', () => {
  let apiClient: ApiClient;

  test.beforeEach(async ({ page, request }) => {
    apiClient = createApiClient(request);
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password);

    // Navigate to chat page
    await page.goto('/chat');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Select chat-team (required for file upload functionality)
    await selectChatTeam(page);
  });

  test('should complete full chat flow with image', async ({ page }) => {
    // 1. Upload file
    await uploadFile(page, TEST_IMAGE_PATH);

    // 2. Send message
    await sendChatMessage(page, 'What do you see in this image?');

    // 3. Wait for response
    await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

    // 4. Verify conversation exists
    const messageCount = await page
      .locator('[data-testid="message"], .message, [data-role]')
      .count();

    expect(messageCount).toBeGreaterThan(0);
  });

  test('should complete full chat flow with PDF', async ({ page }) => {
    await uploadFile(page, TEST_PDF_PATH);
    await sendChatMessage(page, 'Summarize this document');
    await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

    const hasContent = await page.locator('[data-role], .message-content').count();
    expect(hasContent).toBeGreaterThan(0);
  });

  test('should complete full chat flow with DOCX', async ({ page }) => {
    await uploadFile(page, TEST_DOCX_PATH);
    await sendChatMessage(page, 'Review this document');
    await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

    const hasContent = await page.locator('[data-role], .message-content').count();
    expect(hasContent).toBeGreaterThan(0);
  });

  test('should complete full chat flow with PPTX', async ({ page }) => {
    await uploadFile(page, TEST_PPTX_PATH);
    await sendChatMessage(page, 'Review this presentation');
    await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

    const hasContent = await page.locator('[data-role], .message-content').count();
    expect(hasContent).toBeGreaterThan(0);
  });
});

/**
 * Tests for verifying request content sent to the model
 * These tests verify:
 * 1. Requests return successfully
 * 2. Non-image attachments have their content extracted and sent as text
 * 3. Image attachments are sent in the correct format (base64/image_url)
 */
test.describe('Media Chat Request Verification', () => {
  let apiClient: ApiClient;

  test.beforeEach(async ({ page, request }) => {
    apiClient = createApiClient(request);
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password);

    // Clear recorded requests before each test
    await clearRecordedRequests();

    // Navigate to chat page
    await page.goto('/chat');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // Select chat-team (required for file upload functionality)
    await selectChatTeam(page);
  });

  test.describe('Image Attachment Format Verification', () => {
    test('should send image in correct format (base64 or image_url)', async ({ page }) => {
      // Clear any previous requests
      await clearRecordedRequests();

      await uploadFile(page, TEST_IMAGE_PATH);

      // Send message with image
      await sendChatMessage(page, 'Describe this image');

      // Wait for the request to be processed
      await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

      // Get the recorded request from mock server
      const latestRequest = await getLatestRequest();

      expect(latestRequest).toBeTruthy();
      expect(latestRequest!.endpoint).toBe('/v1/chat/completions');

      // Verify image content was included
      // Image should be sent as image_url with base64 data or URL
      expect(latestRequest!.hasImageContent).toBe(true);

      // Verify image format is detected (png, jpeg, or url)
      expect(latestRequest!.imageFormat).toBeTruthy();
      console.log(`Image format detected: ${latestRequest!.imageFormat}`);
    });
  });

  test.describe('Document Content Extraction Verification', () => {
    test('should extract and send PDF content as text', async ({ page }) => {
      await clearRecordedRequests();

      await uploadFile(page, TEST_PDF_PATH);
      await sendChatMessage(page, 'Summarize this PDF');
      await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

      const latestRequest = await getLatestRequest();

      expect(latestRequest).toBeTruthy();
      expect(latestRequest!.endpoint).toBe('/v1/chat/completions');

      // PDF content should be extracted and sent as text
      expect(latestRequest!.hasTextContent).toBe(true);

      // Extracted text should have some length (PDF content was extracted)
      expect(latestRequest!.extractedTextLength).toBeGreaterThan(0);
      console.log(`PDF extracted text length: ${latestRequest!.extractedTextLength}`);

      // PDF should NOT be sent as image
      expect(latestRequest!.hasImageContent).toBe(false);
    });

    test('should extract and send DOCX content as text', async ({ page }) => {
      await clearRecordedRequests();

      await uploadFile(page, TEST_DOCX_PATH);
      await sendChatMessage(page, 'Review this Word document');
      await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

      const latestRequest = await getLatestRequest();

      expect(latestRequest).toBeTruthy();
      expect(latestRequest!.endpoint).toBe('/v1/chat/completions');

      // DOCX content should be extracted and sent as text
      expect(latestRequest!.hasTextContent).toBe(true);
      expect(latestRequest!.extractedTextLength).toBeGreaterThan(0);
      console.log(`DOCX extracted text length: ${latestRequest!.extractedTextLength}`);

      // DOCX should NOT be sent as image
      expect(latestRequest!.hasImageContent).toBe(false);
    });

    test('should extract and send PPTX content as text', async ({ page }) => {
      await clearRecordedRequests();

      await uploadFile(page, TEST_PPTX_PATH);
      await sendChatMessage(page, 'Analyze this presentation');
      await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

      const latestRequest = await getLatestRequest();

      expect(latestRequest).toBeTruthy();
      expect(latestRequest!.endpoint).toBe('/v1/chat/completions');

      // PPTX content should be extracted and sent as text
      expect(latestRequest!.hasTextContent).toBe(true);
      expect(latestRequest!.extractedTextLength).toBeGreaterThan(0);
      console.log(`PPTX extracted text length: ${latestRequest!.extractedTextLength}`);

      // PPTX should NOT be sent as image
      expect(latestRequest!.hasImageContent).toBe(false);
    });
  });

  test.describe('Request Success Verification', () => {
    test('should receive successful response for image chat', async ({ page }) => {
      await uploadFile(page, TEST_IMAGE_PATH);
      await sendChatMessage(page, 'What is in this image?');

      // Wait for response to appear
      await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

      const responseCount = await page
        .locator('[data-role="assistant"], [data-testid="message-response"]')
        .count();
      expect(responseCount).toBeGreaterThan(0);
    });

    test('should receive successful response for PDF chat', async ({ page }) => {
      await uploadFile(page, TEST_PDF_PATH);
      await sendChatMessage(page, 'What does this PDF contain?');

      await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

      const responseCount = await page
        .locator('[data-role="assistant"], [data-testid="message-response"]')
        .count();
      expect(responseCount).toBeGreaterThan(0);
    });

    test('should receive successful response for DOCX chat', async ({ page }) => {
      await uploadFile(page, TEST_DOCX_PATH);
      await sendChatMessage(page, 'Summarize this document');

      await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

      const responseCount = await page
        .locator('[data-role="assistant"], [data-testid="message-response"]')
        .count();
      expect(responseCount).toBeGreaterThan(0);
    });

    test('should receive successful response for PPTX chat', async ({ page }) => {
      await uploadFile(page, TEST_PPTX_PATH);
      await sendChatMessage(page, 'What is this presentation about?');

      await waitForAssistantResponse(page, CHAT_RESPONSE_TIMEOUT);

      const responseCount = await page
        .locator('[data-role="assistant"], [data-testid="message-response"]')
        .count();
      expect(responseCount).toBeGreaterThan(0);
    });
  });
});
