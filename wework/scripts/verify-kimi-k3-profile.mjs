#!/usr/bin/env node

const apiKey = process.env.KIMI_API_KEY?.trim()
const baseUrl = (process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/v1').replace(/\/+$/, '')
const attempts = Number(process.env.KIMI_PARALLEL_TOOL_ATTEMPTS || '3')

if (!apiKey) {
  console.error('KIMI_API_KEY is required')
  process.exit(2)
}

const tools = ['lookup_alpha', 'lookup_beta'].map(name => ({
  type: 'function',
  function: {
    name,
    description: `Return the fixed value for ${name}`,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
}))

async function probeParallelToolCalls() {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'k3',
      messages: [
        {
          role: 'user',
          content:
            'Call lookup_alpha and lookup_beta now. Both calls are independent and both are required. Do not answer with text.',
        },
      ],
      tools,
      tool_choice: 'required',
      parallel_tool_calls: true,
      reasoning_effort: 'low',
      stream: false,
    }),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body?.error?.message || body?.message || response.statusText
    throw new Error(`HTTP ${response.status}: ${message}`)
  }
  const calls = body?.choices?.[0]?.message?.tool_calls
  return Array.isArray(calls)
    ? new Set(calls.map(call => call?.function?.name).filter(Boolean))
    : null
}

const results = []
for (let index = 0; index < attempts; index += 1) {
  const calls = await probeParallelToolCalls()
  results.push(calls?.has('lookup_alpha') && calls.has('lookup_beta'))
}

const passed = results.every(Boolean)
console.log(
  JSON.stringify({
    model: 'k3',
    attempts,
    successfulParallelResponses: results.filter(Boolean).length,
    supportsParallelToolCalls: passed,
  })
)
process.exit(passed ? 0 : 1)
