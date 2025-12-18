/**
 * Chat Image E2E Test with Mock Model Server
 *
 * This test verifies that when a user uploads an image and sends a message,
 * the backend correctly formats the request to the model with image_url.
 *
 * The test automatically creates:
 * 1. A Model pointing to the mock model server
 * 2. A Bot using Chat Shell and the mock model
 * 3. A Team using the bot
 *
 * Prerequisites:
 * - Start the mock model server: npx ts-node frontend/e2e/utils/mock-model-server.ts
 * - Backend services running
 */

import { test, expect } from '@playwright/test';
import { createApiClient, ApiClient } from '../../utils/api-client';
import { ADMIN_USER } from '../../config/test-users';
import * as fs from 'fs';
import * as path from 'path';

// Mock model server configuration
const MOCK_MODEL_SERVER_URL = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999';
const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000';

// Test resource names (unique per test run)
const TEST_PREFIX = `e2e-image-test-${Date.now()}`;
const TEST_MODEL_NAME = `${TEST_PREFIX}-model`;
const TEST_BOT_NAME = `${TEST_PREFIX}-bot`;
const TEST_TEAM_NAME = `${TEST_PREFIX}-team`;

interface CapturedRequest {
  timestamp: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    messages: Array<{
      role: string;
      content:
        | string
        | Array<{
            type: string;
            text?: string;
            image_url?: {
              url: string;
            };
          }>;
    }>;
    stream?: boolean;
  };
}

test.describe('Chat Image E2E with Mock Model Server', () => {
  let apiClient: ApiClient;
  let token: string;
  const testImagePath = path.join(__dirname, '../../fixtures/test-image.png');

  // Created resource IDs for cleanup
  let createdModelId: number | null = null;
  let createdBotId: number | null = null;
  let createdTeamId: number | null = null;

  test.beforeAll(async ({ request }) => {
    // Login and get token
    apiClient = createApiClient(request);
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password);
    token = (apiClient as unknown as { token: string }).token;

    // Check if mock model server is running
    try {
      const healthResponse = await request.get(`${MOCK_MODEL_SERVER_URL}/health`);
      if (healthResponse.status() !== 200) {
        console.warn('Mock model server is not running. Some tests will be skipped.');
        return;
      }
    } catch {
      console.warn(
        'Mock model server is not reachable. Start it with: npx ts-node frontend/e2e/utils/mock-model-server.ts'
      );
      return;
    }

    // Create test resources
    try {
      // Step 1: Create Model pointing to mock server
      console.log('Creating test model...');
      const modelResponse = await request.post(`${API_BASE_URL}/api/models`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: {
            name: TEST_MODEL_NAME,
            namespace: 'default',
          },
          spec: {
            modelConfig: {
              model_id: 'mock-vision-model',
              api_key: 'mock-api-key',
              base_url: `${MOCK_MODEL_SERVER_URL}/v1`,
              protocol: 'openai',
            },
            isCustomConfig: true,
          },
        },
      });

      if (modelResponse.status() === 200 || modelResponse.status() === 201) {
        const modelData = await modelResponse.json();
        createdModelId = modelData.id;
        console.log(`Created model: ${TEST_MODEL_NAME} (ID: ${createdModelId})`);
      } else {
        console.error('Failed to create model:', await modelResponse.text());
      }

      // Step 2: Create Bot with Chat Shell and the mock model
      console.log('Creating test bot...');
      const botResponse = await request.post(`${API_BASE_URL}/api/bots`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Bot',
          metadata: {
            name: TEST_BOT_NAME,
            namespace: 'default',
          },
          spec: {
            ghostRef: {
              name: 'default-ghost',
              namespace: 'default',
            },
            shellRef: {
              name: 'chat',
              namespace: 'default',
            },
            modelRef: {
              name: TEST_MODEL_NAME,
              namespace: 'default',
            },
            agent_config: {
              bind_model: TEST_MODEL_NAME,
              bind_model_type: 'user',
            },
          },
        },
      });

      if (botResponse.status() === 200 || botResponse.status() === 201) {
        const botData = await botResponse.json();
        createdBotId = botData.id;
        console.log(`Created bot: ${TEST_BOT_NAME} (ID: ${createdBotId})`);
      } else {
        console.error('Failed to create bot:', await botResponse.text());
      }

      // Step 3: Create Team using the bot
      console.log('Creating test team...');
      const teamResponse = await request.post(`${API_BASE_URL}/api/teams`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Team',
          metadata: {
            name: TEST_TEAM_NAME,
            namespace: 'default',
          },
          spec: {
            members: [
              {
                botRef: {
                  name: TEST_BOT_NAME,
                  namespace: 'default',
                },
                prompt: 'You are a helpful assistant that can analyze images.',
                role: 'worker',
              },
            ],
            collaborationModel: 'single',
          },
        },
      });

      if (teamResponse.status() === 200 || teamResponse.status() === 201) {
        const teamData = await teamResponse.json();
        createdTeamId = teamData.id;
        console.log(`Created team: ${TEST_TEAM_NAME} (ID: ${createdTeamId})`);
      } else {
        console.error('Failed to create team:', await teamResponse.text());
      }
    } catch (error) {
      console.error('Error creating test resources:', error);
    }
  });

  test.afterAll(async ({ request }) => {
    // Cleanup created resources
    console.log('Cleaning up test resources...');

    if (createdTeamId) {
      try {
        await request.delete(`${API_BASE_URL}/api/v1/namespaces/default/teams/${TEST_TEAM_NAME}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        console.log(`Deleted team: ${TEST_TEAM_NAME}`);
      } catch (e) {
        console.warn(`Failed to delete team: ${e}`);
      }
    }

    if (createdBotId) {
      try {
        await request.delete(`${API_BASE_URL}/api/v1/namespaces/default/bots/${TEST_BOT_NAME}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        console.log(`Deleted bot: ${TEST_BOT_NAME}`);
      } catch (e) {
        console.warn(`Failed to delete bot: ${e}`);
      }
    }

    if (createdModelId) {
      try {
        await request.delete(`${API_BASE_URL}/api/models/${TEST_MODEL_NAME}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        console.log(`Deleted model: ${TEST_MODEL_NAME}`);
      } catch (e) {
        console.warn(`Failed to delete model: ${e}`);
      }
    }
  });

  test.beforeEach(async ({ request }) => {
    // Clear captured requests before each test
    try {
      await request.post(`${MOCK_MODEL_SERVER_URL}/clear-requests`);
    } catch {
      // Server might not be running
    }
  });

  test('should verify mock model server is running', async ({ request }) => {
    const response = await request.get(`${MOCK_MODEL_SERVER_URL}/health`);

    if (response.status() !== 200) {
      test.skip();
      return;
    }

    const data = await response.json();
    expect(data.status).toBe('ok');
  });

  test('should send image_url to model when image is attached', async ({ request }) => {
    // Skip if mock server is not running
    const healthCheck = await request.get(`${MOCK_MODEL_SERVER_URL}/health`).catch(() => null);
    if (!healthCheck || healthCheck.status() !== 200) {
      console.warn('Mock model server not running, skipping test');
      test.skip();
      return;
    }

    // Skip if team was not created
    if (!createdTeamId) {
      console.warn('Test team was not created, skipping test');
      test.skip();
      return;
    }

    // Step 1: Upload image
    const imageBuffer = fs.readFileSync(testImagePath);

    const uploadResponse = await request.post(`${API_BASE_URL}/api/attachments/upload`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      multipart: {
        file: {
          name: 'test-image.png',
          mimeType: 'image/png',
          buffer: imageBuffer,
        },
      },
    });

    expect(uploadResponse.status()).toBe(200);
    const uploadData = await uploadResponse.json();
    const attachmentId = uploadData.id;

    console.log(`Uploaded attachment with ID: ${attachmentId}`);

    // Step 2: Send chat message with attachment using the created team
    console.log(`Sending chat message with team ID: ${createdTeamId}`);

    const chatResponse = await request.post(`${API_BASE_URL}/api/chat/stream`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        message: 'What is in this image?',
        team_id: createdTeamId,
        attachment_id: attachmentId,
      },
    });

    console.log(`Chat response status: ${chatResponse.status()}`);

    // Wait for the request to be processed
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 3: Check captured requests on mock server
    const capturedResponse = await request.get(`${MOCK_MODEL_SERVER_URL}/captured-requests`);
    expect(capturedResponse.status()).toBe(200);

    const capturedRequests = (await capturedResponse.json()) as CapturedRequest[];
    console.log(`Captured ${capturedRequests.length} requests`);

    // Find the chat completion request
    const chatRequest = capturedRequests.find(req => req.url?.includes('/chat/completions'));

    if (!chatRequest) {
      console.error('No chat completion request captured!');
      console.log('Captured requests:', JSON.stringify(capturedRequests, null, 2));
      expect(chatRequest).toBeDefined();
      return;
    }

    // Step 4: Verify the request contains image_url
    expect(chatRequest.body).toBeDefined();
    expect(chatRequest.body.messages).toBeDefined();

    console.log('Captured messages:', JSON.stringify(chatRequest.body.messages, null, 2));

    // Find user message with image
    const userMessage = chatRequest.body.messages.find(
      msg => msg.role === 'user' && Array.isArray(msg.content)
    );

    expect(userMessage).toBeDefined();

    if (userMessage && Array.isArray(userMessage.content)) {
      // Verify text content exists
      const textContent = userMessage.content.find(c => c.type === 'text');
      expect(textContent).toBeDefined();
      expect(textContent?.text).toContain('What is in this image?');

      // Verify image_url content exists
      const imageContent = userMessage.content.find(c => c.type === 'image_url');
      expect(imageContent).toBeDefined();
      expect(imageContent?.image_url).toBeDefined();
      expect(imageContent?.image_url?.url).toMatch(/^data:image\/png;base64,/);

      console.log('✅ Image URL format verified successfully!');
      console.log(`   Prefix: ${imageContent?.image_url?.url.substring(0, 50)}...`);
    }
  });
});

test.describe('Image URL Format Unit Tests', () => {
  test('should validate PNG image data URL format', () => {
    const pngDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC';

    // Verify format
    expect(pngDataUrl).toMatch(/^data:image\/png;base64,/);

    // Extract and verify base64
    const base64 = pngDataUrl.split(',')[1];
    const buffer = Buffer.from(base64, 'base64');

    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
    expect(buffer[2]).toBe(0x4e);
    expect(buffer[3]).toBe(0x47);
  });

  test('should validate JPEG image data URL format', () => {
    // Minimal JPEG header
    const jpegDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/';

    expect(jpegDataUrl).toMatch(/^data:image\/jpeg;base64,/);

    const base64 = jpegDataUrl.split(',')[1];
    const buffer = Buffer.from(base64, 'base64');

    // JPEG signature: FF D8 FF
    expect(buffer[0]).toBe(0xff);
    expect(buffer[1]).toBe(0xd8);
    expect(buffer[2]).toBe(0xff);
  });

  test('should validate vision message structure', () => {
    const visionMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        {
          type: 'image_url',
          image_url: {
            url: 'data:image/png;base64,abc123',
          },
        },
      ],
    };

    // Validate structure
    expect(visionMessage.role).toBe('user');
    expect(Array.isArray(visionMessage.content)).toBe(true);

    // Find text content
    const textContent = visionMessage.content.find(c => c.type === 'text');
    expect(textContent).toBeDefined();
    expect(textContent?.text).toBe('Describe this image');

    // Find image content
    const imageContent = visionMessage.content.find(c => c.type === 'image_url');
    expect(imageContent).toBeDefined();
    expect(imageContent?.image_url?.url).toMatch(/^data:image\//);
  });

  test('should reject invalid image URL formats', () => {
    const invalidFormats = [
      'http://example.com/image.png', // HTTP URL instead of data URL
      'data:text/plain;base64,abc123', // Wrong MIME type
      'data:image/png,abc123', // Missing base64 encoding
      'abc123', // Not a data URL at all
    ];

    for (const url of invalidFormats) {
      expect(url).not.toMatch(/^data:image\/(png|jpeg|gif|webp);base64,/);
    }
  });
});
