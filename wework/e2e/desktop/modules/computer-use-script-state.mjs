import assert from 'node:assert/strict'
import { withExecutorMcp } from './connector-mcp-client.mjs'

/** Exercise the real Executor, host bridge, and sandbox over separate MCP calls. */
export async function verifyComputerUseScriptState({ executorBinary, recordPath, pid, timeoutMs }) {
  const withMcp = verify =>
    withExecutorMcp(
      {
        binary: executorBinary,
        args: ['computer-use-mcp-server', recordPath],
        environment: process.env,
        serverName: 'wegent-computer-use',
        timeoutMs,
      },
      verify
    )
  const run = async (request, script, stateMode) => {
    const reply = await request('tools/call', {
      name: 'run_script',
      arguments: { script, state_mode: stateMode },
    })
    assert.equal(reply.isError, false, JSON.stringify(reply.content))
    assert.equal(reply.structuredContent?.ok, true)
    assert.deepEqual(
      reply.content,
      [],
      'The script report should be returned only as structured JSON'
    )
    return reply.structuredContent.value
  }

  await withMcp(async ({ request }) => {
    const catalog = await request('tools/list')
    const script = catalog.tools.find(tool => tool.name === 'run_script')
    assert.deepEqual(script?.inputSchema.properties.state_mode.enum, ['reuse', 'reset'])
    const target = await run(
      request,
      `const result = await cua.listWindows({pid:${pid}});
       const windows = Array.isArray(result) ? result : result.windows;
       const window = windows.find(candidate => candidate.bounds.height > 100);
       state.target = {pid:window.pid, windowId:window.window_id};
       return {pid:state.target.pid};`,
      'reset'
    )
    assert.deepEqual(target, { pid })
    assert.equal(
      await run(
        request,
        'const app = await cua.getApp(state.target); const screen = await app.getState({include_screenshot:false}); return screen.pid;',
        'reuse'
      ),
      pid
    )
    await withMcp(async ({ request: otherRequest }) => {
      assert.equal(await run(otherRequest, 'return Object.keys(state).length;', 'reuse'), 0)
    })
    assert.equal(await run(request, 'return Object.keys(state).length;', 'reset'), 0)
  })
}
