import { Readable } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { accountCommandResult } from '../e2e/desktop/modules/account-auth-command.mjs'
import { createPluginPythonChat } from '../e2e/desktop/modules/plugin-python-chat.mjs'

vi.mock('../e2e/desktop/modules/shared.mjs', async () => ({
  assert: (await import('node:assert/strict')).default,
  createSingleRootLocalProject: vi.fn(),
  selectE2EModel: vi.fn(),
}))

test.each([false, true])(
  'Python chat starts and polls the shared shell protocol (exec=%s)',
  async exec => {
    const chat = createPluginPythonChat({
      resultDir: '/fixture/results',
      workspacePath: '/fixture/workspace',
      electronUserDataDirectory: '/fixture/user-data',
      uiTimeoutMs: 10_000,
    })
    await chat.start({ command: vi.fn() })
    const tools = {
      exec_command: vi.fn().mockResolvedValue({ session_id: 123, output: 'partial' }),
      write_stdin: vi.fn().mockResolvedValue({ exit_code: 0, output: 'finished' }),
    }
    const history = []
    const respond = async () => {
      const body = {
        ...(exec ? {} : { tools: [{ name: 'exec_command' }, { name: 'write_stdin' }] }),
        input: [
          { role: 'user', content: 'WEWORK_PLUGIN_PYTHON_CHAT Wework Python plugin execution:' },
          ...(exec
            ? [
                {
                  type: 'additional_tools',
                  tools: [
                    {
                      type: 'namespace',
                      name: 'functions',
                      tools: [{ type: 'custom', name: 'exec' }],
                    },
                  ],
                },
              ]
            : []),
          ...history,
        ],
      }
      let contents
      const request = Readable.from([JSON.stringify(body)])
      request.method = 'POST'
      expect(
        await chat.handleHttp(
          request,
          {
            writeHead: vi.fn(),
            end: value => {
              contents = value
            },
          },
          new URL('http://localhost/responses')
        )
      ).toBe(true)
      const events = contents
        .split('\n')
        .filter(line => line.startsWith('data: {'))
        .map(line => JSON.parse(line.slice(6)))
      return events.findLast(event => event.item?.call_id)?.item
    }
    const command = await respond()
    let output
    if (exec) {
      const values = []
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
      await new AsyncFunction('tools', 'text', command.input)(tools, value =>
        values.push({ type: 'text', text: value })
      )
      output = values
      expect(tools.exec_command).toHaveBeenCalledWith({
        cmd: expect.stringContaining('node -e'),
        workdir: '/fixture/workspace',
        yield_time_ms: 1000,
      })
    } else {
      expect(command.name).toBe('exec_command')
      expect(JSON.parse(command.arguments)).toMatchObject({
        cmd: expect.stringContaining('node -e'),
        workdir: '/fixture/workspace',
      })
      output = 'Process running with session ID 123'
    }
    history.push({
      type: exec ? 'custom_tool_call_output' : 'function_call_output',
      call_id: command.call_id,
      output,
    })
    expect(accountCommandResult(history, 'plugin-python-chat').sessionId).toBe(123)
    const poll = await respond()
    if (exec) {
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
      await new AsyncFunction('tools', 'text', poll.input)(tools, vi.fn())
      expect(tools.write_stdin).toHaveBeenCalledWith({
        session_id: 123,
        chars: '',
        yield_time_ms: 1000,
      })
    } else {
      expect(poll.name).toBe('write_stdin')
      expect(JSON.parse(poll.arguments)).toEqual({
        session_id: 123,
        chars: '',
        yield_time_ms: 1000,
      })
    }
  }
)
