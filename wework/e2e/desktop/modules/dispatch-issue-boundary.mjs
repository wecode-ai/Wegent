import assert from 'node:assert/strict'
import { mcpToolRequestEvents, requestContainsToolOutput } from './response-protocol.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'

export function createDispatchIssueBoundaryRegression(request) {
  const targets = []
  let verified = false
  let index = 0
  let modelRequests = 0
  return {
    async prepare(project) {
      const otherProject = await request('/api/v1/cloud-projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'Dispatch scope target', workspace_id: project.workspace_id }),
      })
      for (const owner of [project, otherProject]) {
        const issue = await request(`/api/v1/cloud-projects/${owner.id}/loop-items`, {
          method: 'POST',
          body: JSON.stringify({ title: 'Authorized user, out of dispatch scope' }),
        })
        targets.push({ space_id: String(owner.id), item_id: issue.id, version: issue.version })
      }
    },
    script() {
      assert.equal(targets.length, 2)
      return [
        `for (const target of ${JSON.stringify(targets)}) {`,
        `  const denied = await tools[read.name]({ space_id: target.space_id, item_id: target.item_id })`,
        `  if (!denied.isError || !JSON.stringify(denied).includes('outside this Agent session'))`,
        `    throw new Error('Dispatch role escaped its assigned scope: ' + JSON.stringify(denied))`,
        `}`,
      ].join('\n')
    },
    async events(body) {
      const callId = () => `dispatch-boundary-${index}`
      if (requestContainsToolOutput(body, callId())) {
        const result = readMcpToolOutput(body, callId())
        assert.match(
          result,
          /^The requested (board item|project space) is outside this Agent session$/,
          'Dispatch role escaped its assigned scope'
        )
        index += 1
      }
      if (index === targets.length) {
        await this.verify()
        return null
      }
      modelRequests += 1
      return mcpToolRequestEvents(body, {
        toolName: 'get_board_item',
        argumentsValue: { space_id: targets[index].space_id, item_id: targets[index].item_id },
        directToolName: (body.tools ?? [])
          .map(tool => tool.name)
          .find(name => name?.endsWith('__get_board_item')),
        searchCallId: `${callId()}-search`,
        toolCallId: callId(),
      }).events
    },
    async verify() {
      for (const target of targets) {
        const issue = await request(`/api/v1/loop-items/${target.item_id}`)
        assert.equal(issue.version, target.version)
        assert.equal(issue.title, 'Authorized user, out of dispatch scope')
        assert.deepEqual(await request(`/api/v1/loop-items/${target.item_id}/tasks`), [])
      }
      verified = true
    },
    get verified() {
      return verified
    },
    get modelRequests() {
      return modelRequests
    },
  }
}
