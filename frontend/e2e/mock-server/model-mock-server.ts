/**
 * Mock Model Server for E2E Testing
 *
 * This server mocks the OpenAI-compatible API for streaming chat responses.
 * It is used by E2E tests to simulate AI model responses without requiring
 * actual model API calls.
 *
 * Usage:
 *   npx ts-node e2e/mock-server/model-mock-server.ts
 *
 * The server listens on port 9999 by default and provides:
 *   - POST /v1/chat/completions - OpenAI-compatible chat completions endpoint
 *   - POST /v1/messages - Anthropic-compatible messages endpoint
 *   - GET /health - Health check endpoint
 *   - GET /requests - Get recorded requests for verification
 *   - DELETE /requests - Clear recorded requests
 */

import http from 'http';

const PORT = process.env.MOCK_MODEL_PORT || 9999;
const HOST = '0.0.0.0';

// Mock response content
const MOCK_RESPONSE_CONTENT =
  'This is a mock response from the model server. I received your message and I am responding with this test content to verify the chat functionality is working correctly.';

// Store received requests for verification
interface RecordedRequest {
  timestamp: number;
  endpoint: string;
  body: Record<string, unknown>;
  hasImageContent: boolean;
  hasTextContent: boolean;
  extractedTextLength: number;
  imageFormat: string | null;
}

const recordedRequests: RecordedRequest[] = [];

/**
 * Analyze request content to detect attachments
 */
function analyzeRequestContent(body: Record<string, unknown>): {
  hasImageContent: boolean;
  hasTextContent: boolean;
  extractedTextLength: number;
  imageFormat: string | null;
} {
  let hasImageContent = false;
  let hasTextContent = false;
  let extractedTextLength = 0;
  let imageFormat: string | null = null;

  const messages = body.messages as
    | Array<{
        role: string;
        content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
      }>
    | undefined;

  if (messages) {
    for (const message of messages) {
      if (typeof message.content === 'string') {
        hasTextContent = true;
        extractedTextLength += message.content.length;
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'text' && part.text) {
            hasTextContent = true;
            extractedTextLength += part.text.length;
          } else if (part.type === 'image_url' && part.image_url?.url) {
            hasImageContent = true;
            // Detect image format from data URL or URL
            const url = part.image_url.url;
            if (url.startsWith('data:image/')) {
              const match = url.match(/^data:image\/(\w+);/);
              imageFormat = match ? match[1] : 'unknown';
            } else if (url.includes('.png')) {
              imageFormat = 'png';
            } else if (url.includes('.jpg') || url.includes('.jpeg')) {
              imageFormat = 'jpeg';
            } else {
              imageFormat = 'url';
            }
          }
        }
      }
    }
  }

  return { hasImageContent, hasTextContent, extractedTextLength, imageFormat };
}

/**
 * Generate OpenAI-compatible SSE stream
 */
function generateOpenAIStream(content: string): string[] {
  const chunks: string[] = [];

  // Split content into words for streaming
  const words = content.split(' ');
  let currentIndex = 0;

  while (currentIndex < words.length) {
    const chunkSize = Math.min(3, words.length - currentIndex);
    const chunkContent = words.slice(currentIndex, currentIndex + chunkSize).join(' ') + ' ';

    const chunk = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
      choices: [
        {
          index: 0,
          delta: { content: chunkContent },
          finish_reason: null,
        },
      ],
    };

    chunks.push(`data: ${JSON.stringify(chunk)}\n\n`);
    currentIndex += chunkSize;
  }

  // Final chunk with finish_reason
  const finalChunk = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
      },
    ],
  };
  chunks.push(`data: ${JSON.stringify(finalChunk)}\n\n`);
  chunks.push('data: [DONE]\n\n');

  return chunks;
}

/**
 * Generate Anthropic-compatible SSE stream
 */
function generateAnthropicStream(content: string): string[] {
  const chunks: string[] = [];

  // Message start
  chunks.push(
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'mock-model',
      },
    })}\n\n`
  );

  // Content block start
  chunks.push(
    `data: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}\n\n`
  );

  // Split content into words for streaming
  const words = content.split(' ');
  let currentIndex = 0;

  while (currentIndex < words.length) {
    const chunkSize = Math.min(3, words.length - currentIndex);
    const chunkContent = words.slice(currentIndex, currentIndex + chunkSize).join(' ') + ' ';

    chunks.push(
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: chunkContent },
      })}\n\n`
    );
    currentIndex += chunkSize;
  }

  // Content block stop
  chunks.push(
    `data: ${JSON.stringify({
      type: 'content_block_stop',
      index: 0,
    })}\n\n`
  );

  // Message stop
  chunks.push(
    `data: ${JSON.stringify({
      type: 'message_stop',
    })}\n\n`
  );

  return chunks;
}

/**
 * Handle streaming response
 */
async function streamResponse(
  res: http.ServerResponse,
  chunks: string[],
  delayMs: number = 50
): Promise<void> {
  for (const chunk of chunks) {
    res.write(chunk);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  res.end();
}

/**
 * Parse request body
 */
function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Create HTTP server
 */
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url || '';

  // Health check
  if (url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        server: 'mock-model-server',
        requestCount: recordedRequests.length,
      })
    );
    return;
  }

  // Get recorded requests for verification
  if (url === '/requests' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ requests: recordedRequests }));
    return;
  }

  // Clear recorded requests
  if (url === '/requests' && req.method === 'DELETE') {
    recordedRequests.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Requests cleared' }));
    return;
  }

  // OpenAI-compatible endpoint
  if (url === '/v1/chat/completions' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const stream = (body.stream as boolean) ?? true;

      // Analyze and record the request
      const analysis = analyzeRequestContent(body);
      const record: RecordedRequest = {
        timestamp: Date.now(),
        endpoint: '/v1/chat/completions',
        body: body,
        ...analysis,
      };
      recordedRequests.push(record);

      console.log(`[Mock Server] Received chat completions request, stream=${stream}`);
      console.log(
        `[Mock Server] Analysis: hasImage=${analysis.hasImageContent}, hasText=${analysis.hasTextContent}, textLen=${analysis.extractedTextLength}, imageFormat=${analysis.imageFormat}`
      );

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const chunks = generateOpenAIStream(MOCK_RESPONSE_CONTENT);
        await streamResponse(res, chunks);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: MOCK_RESPONSE_CONTENT },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 },
          })
        );
      }
    } catch (error) {
      console.error('[Mock Server] Error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
    return;
  }

  // Anthropic-compatible endpoint
  if (url === '/v1/messages' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const stream = (body.stream as boolean) ?? true;

      // Analyze and record the request
      const analysis = analyzeRequestContent(body);
      const record: RecordedRequest = {
        timestamp: Date.now(),
        endpoint: '/v1/messages',
        body: body,
        ...analysis,
      };
      recordedRequests.push(record);

      console.log(`[Mock Server] Received messages request, stream=${stream}`);
      console.log(
        `[Mock Server] Analysis: hasImage=${analysis.hasImageContent}, hasText=${analysis.hasTextContent}, textLen=${analysis.extractedTextLength}, imageFormat=${analysis.imageFormat}`
      );

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const chunks = generateAnthropicStream(MOCK_RESPONSE_CONTENT);
        await streamResponse(res, chunks);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: MOCK_RESPONSE_CONTENT }],
            model: 'mock-model',
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 50 },
          })
        );
      }
    } catch (error) {
      console.error('[Mock Server] Error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
    return;
  }

  // 404 for other routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(Number(PORT), HOST, () => {
  console.log(`[Mock Model Server] Running on http://${HOST}:${PORT}`);
  console.log('[Mock Model Server] Endpoints:');
  console.log(`  - POST /v1/chat/completions (OpenAI-compatible)`);
  console.log(`  - POST /v1/messages (Anthropic-compatible)`);
  console.log(`  - GET /health`);
  console.log(`  - GET /requests (get recorded requests for verification)`);
  console.log(`  - DELETE /requests (clear recorded requests)`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Mock Model Server] Shutting down...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Mock Model Server] Shutting down...');
  server.close(() => {
    process.exit(0);
  });
});

export { server };
