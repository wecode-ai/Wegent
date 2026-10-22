import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { waitForSnapshot } from './conversation-layout.mjs'

/** Verify output-budget validation, persistence, editing and clearing through the real host. */
export async function verifyCustomModelOutputBudget(control) {
  const requests = []
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url, body: JSON.parse(body) })
    if (request.headers.authorization !== 'Bearer model-test-key') {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Invalid model test key' } }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        output: [
          {
            type: 'custom_tool_call',
            name: 'apply_patch',
            input: '*** Begin Patch\n*** Add File: probe.txt\n+PING\n*** End Patch',
          },
        ],
      })
    )
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await verifyOutputBudgetAndConnection(control, `http://127.0.0.1:${server.address().port}/v1`)
    assert.equal(requests.length, 3, 'The failed, corrected and saved editor should test the model')
    for (const request of requests) {
      assert.equal(request.path, '/v1/responses')
      assert.equal(request.body.model, 'budget-model')
    }
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  }
}

async function verifyOutputBudgetAndConnection(control, baseUrl) {
  const output = '[data-testid="local-model-max-output-tokens-input"]'
  const context = '[data-testid="local-model-context-window-input"]'
  const save = '[data-testid="provider-editor-save"]'
  await control.command('navigate', 'body', { value: '/settings/personal/models' })
  await control.command('waitFor', '[data-testid="provider-add"]')
  const before = JSON.parse(await control.command('snapshot', 'body')).testIds
  await control.command('clickWhenEnabled', '[data-testid="provider-add"]')
  await control.command('select', '[data-testid="provider-preset"]', { value: 'custom' })
  await control.command('fill', '[data-testid="provider-name"]', { value: 'Output budget E2E' })
  await control.command('fill', '[data-testid="provider-base-url"]', {
    value: baseUrl,
  })
  await control.command('click', '[data-testid="provider-model-add"]')
  await control.command('fill', '[data-testid^="provider-model-id-"]', { value: 'budget-model' })
  await control.command('fill', context, { value: '128000' })
  await control.command('fill', output, { value: '128000' })
  await control.command('clickWhenEnabled', save)
  const rejected = await waitForSnapshot(
    control,
    snapshot => snapshot.testIds.includes('provider-editor-error'),
    'An output limit consuming the entire context window was accepted'
  )
  assert.ok(rejected.text.includes('max_output_tokens'), 'Output-budget validation was not shown')
  await control.command('fill', output, { value: '16000' })
  await control.command('fill', '[data-testid="provider-api-key"]', { value: 'invalid-test-key' })
  await control.command('clickWhenEnabled', '[data-testid="provider-editor-test"]')
  await control.command('waitFor', '[data-testid="provider-editor-test-result"][role="alert"]')
  await control.command('click', '[data-testid="provider-editor-test-error-details"]')
  await control.command('waitFor', '[data-testid="provider-editor-test-result"][open]', {
    text: 'HTTP 401: Invalid model test key',
  })
  await control.command('fill', '[data-testid="provider-api-key"]', { value: 'model-test-key' })
  await control.command('clickWhenEnabled', '[data-testid="provider-editor-test"]')
  await control.command('waitFor', '[data-testid="provider-editor-test-result"][role="status"]')
  await control.command('clickWhenEnabled', save)
  const saved = await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('provider-editor'),
    'The corrected output budget was not saved'
  )
  const row = saved.testIds.find(id => id.startsWith('provider-row-') && !before.includes(id))
  assert.ok(row, 'The new model provider was not persisted')
  const id = row.slice('provider-row-'.length)
  const edit = `[data-testid="provider-edit-${id}"]`
  await control.command('navigate', 'body', { value: '/settings/general' })
  await control.command('navigate', 'body', { value: '/settings/personal/models' })
  await control.command('clickWhenEnabled', edit)
  await control.command('click', '[data-testid^="provider-model-editor-"] > details > summary')
  await control.command('waitFor', output)
  assert.equal(await control.command('getValue', output), '16000')
  assert.equal(await control.command('getValue', context), '128000')
  await control.command('clickWhenEnabled', '[data-testid="provider-editor-test"]')
  await control.command('waitFor', '[data-testid="provider-editor-test-result"][role="status"]')
  await control.command('fill', output, { value: '' })
  await control.command('clickWhenEnabled', save)
  await waitForSnapshot(control, snapshot => !snapshot.testIds.includes('provider-editor'))
  await control.command('clickWhenEnabled', edit)
  await control.command('click', '[data-testid^="provider-model-editor-"] > details > summary')
  await control.command('waitFor', output)
  assert.equal(await control.command('getValue', output), '')
  await control.command('click', '[data-testid="provider-editor-cancel"]')
  await control.command('click', `[data-testid="provider-delete-${id}"]`)
  await control.command('clickWhenEnabled', '[data-testid="provider-action-confirm"]')
  await waitForSnapshot(control, snapshot => !snapshot.testIds.includes(row))
}
