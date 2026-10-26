import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'vitest'
import { createDesktopScenario } from '../e2e/desktop/scenarios/stand-in-workspace.scenario.mjs'

test('serves the network permission probe as text for shell clients', async () => {
  const scenario = createDesktopScenario({ workspacePath: '/tmp/workspace', homePath: '/tmp/home' })
  const server = createServer((request, response) => {
    void scenario.handleHttp(request, response, new URL(request.url, 'http://localhost'))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/external-source-probe`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^text\/plain; charset=utf-8$/)
    assert.equal(await response.text(), 'AUTHORIZED_NETWORK_READ')
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  }
})
