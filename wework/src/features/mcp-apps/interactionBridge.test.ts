import { afterEach, describe, expect, it, vi } from 'vitest'
import source from '../../../../executor/src/workbench_control/apps/interaction.js?raw'
import markup from '../../../../executor/src/workbench_control/apps/interaction.html?raw'
type Json = Record<string, unknown>
interface InteractionApi {
  callTool: (name: string, args?: Json) => Promise<unknown>
  navigate: (target: string) => Promise<void>
  setState: (state: Json) => Promise<void>
  state: Json | null
  context: Json
  navigationTargets: Json[]
}
const disposals: Array<() => void> = []

async function createBridge(state: Json | null = null) {
  const iframe = document.createElement('iframe')
  document.body.append(iframe)
  const child = iframe.contentWindow! as Window & { wework: InteractionApi }
  const doc = child.document
  doc.body.innerHTML = markup.replace('__SCRIPT__', '').replace('__STYLES__', '')
  const post = vi.spyOn(child.parent, 'postMessage').mockImplementation(() => {})
  let onResize = () => {}
  const disconnect = vi.fn()
  class Observer {
    constructor(callback: () => void) {
      onResize = callback
    }
    observe() {}
    disconnect = disconnect
  }
  new Function('window', 'document', 'navigator', 'ResizeObserver', 'TextEncoder', source)(
    child,
    doc,
    child.navigator,
    Observer,
    TextEncoder
  )
  const receive = (data: Json, sender: Window = child.parent) =>
    child.dispatchEvent(
      new MessageEvent('message', { source: sender, data: { jsonrpc: '2.0', ...data } })
    )
  const latest = () => post.mock.lastCall![0] as Json
  const respond = (result: unknown) => receive({ id: latest().id, result })
  const init = latest()
  expect(init.method).toBe('ui/initialize')
  receive({
    id: init.id,
    result: {
      hostContext: {
        locale: 'en-US',
        theme: 'dark',
        navigationTargets: [{ id: 'arbitrary-extension', path: '/extension' }],
        modelContext: { structuredContent: { state } },
        styles: { variables: { '--color-background-primary': 'rgb(24 24 24)' } },
      },
    },
  })
  await Promise.resolve()
  const publish = (html: string, names = ['list_conversations', 'create_automation']) =>
    receive({
      method: 'ui/notifications/tool-result',
      params: {
        structuredContent: { title: 'Generated interaction' },
        _meta: { ui: { html, tools: names.map(name => ({ name })) } },
      },
    })
  disposals.push(() => {
    receive({ id: 'teardown', method: 'ui/resource-teardown' })
    expect(disconnect).toHaveBeenCalled()
    iframe.remove()
  })
  return {
    api: child.wework,
    child,
    doc,
    post,
    latest,
    receive,
    respond,
    publish,
    resize: () => onResize(),
  }
}

async function createGeneratedCard(state: Json | null = null) {
  const bridge = await createBridge(state)
  bridge.publish('<button data-testid="generated-save">Save</button><output></output><p></p>')
  new Function(
    'window',
    'document',
    `
    const button = document.querySelector('button')
    const status = document.querySelector('output')
    let view = window.wework.state
    function render(state) {
      status.textContent = state?.view === 'created' ? 'Created: ' + state.name : 'Ready'
      button.disabled = state?.view === 'created'
    }
    render(view)
    button.onclick = async () => {
      button.disabled = true
      let created = false
      try {
        const { automation } = await window.wework.callTool('create_automation', {
          name: 'Daily analysis', prompt: 'Check the report',
          schedule: { type: 'interval', value: 1, unit: 'days' },
          timezone: 'Asia/Shanghai', enabled: false
        })
        view = { view: 'created', id: automation.id, name: automation.name }
        created = true
        render(view)
        await window.wework.setState(view)
      } catch (error) {
        if (created) {
          document.querySelector('p').textContent = 'Created; card state was not saved'
        } else {
          status.textContent = error.message
          button.disabled = error.code === 'outcome_unknown' || error.outcomeUnknown === true
        }
      }
    }
  `
  )(bridge.child, bridge.doc)
  return bridge
}

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('HTML host API injection', () => {
  it('hosts unrelated AI-generated documents with the same bridge and no business template', async () => {
    for (const html of [
      '<form id="schedule"><label>Name<input name="name"></label><script>window.wework.state</script></form>',
      '<section id="archives"><h2>Archived conversations</h2><button>Open settings</button></section>',
    ]) {
      const bridge = await createBridge({ view: 'results', selected: ['one'] })
      const append = vi.spyOn(bridge.doc.getElementById('interaction-content')!, 'append')
      bridge.publish(html)
      expect(bridge.doc.getElementById('interaction-content')!.textContent).not.toBe('')
      expect(bridge.api.state).toEqual({ view: 'results', selected: ['one'] })
      expect(bridge.doc.documentElement.style.colorScheme).toBe('dark')
      expect(bridge.doc.documentElement.style.getPropertyValue('--color-background-primary')).toBe(
        'rgb(24 24 24)'
      )
      const scripts = append.mock.calls.length
      bridge.publish(html)
      expect(append).toHaveBeenCalledTimes(scripts)
      expect(bridge.post.mock.calls.some(([value]) => value.method === 'tools/call')).toBe(false)
      bridge.post.mockClear()
    }
  })

  it('passes exact arguments to real tools, returns structured results and propagates errors', async () => {
    const bridge = await createBridge()
    bridge.publish('<p>Generated form</p>')
    const args = { name: 'User supplied', prompt: 'Real instructions', enabled: false }
    const created = bridge.api.callTool('create_automation', args)
    expect(bridge.latest()).toMatchObject({
      method: 'tools/call',
      params: { name: 'create_automation', arguments: args },
    })
    bridge.respond({ structuredContent: { automation: { id: 'real-id' } } })
    await expect(created).resolves.toEqual({ automation: { id: 'real-id' } })
    const failed = bridge.api.callTool('create_automation', args)
    bridge.respond({
      isError: true,
      content: [
        {
          type: 'text',
          text: '{"code":"permission_denied","error":"Denied by native authorization"}',
        },
      ],
    })
    await expect(failed).rejects.toMatchObject({
      code: 'permission_denied',
      message: 'Denied by native authorization',
    })
    const calls = bridge.post.mock.calls.length
    await expect(bridge.api.callTool('delete_automation', {})).rejects.toThrow('not bound')
    expect(bridge.post).toHaveBeenCalledTimes(calls)
  })

  it.each(['structured', 'json-text'])(
    'renders the same success view immediately and after reopening with a %s result',
    async format => {
      const bridge = await createGeneratedCard()
      const data = { automation: { id: 'real-id', version: 1, name: 'Daily analysis' } }
      bridge.doc.querySelector('button')!.click()
      expect(bridge.latest().method).toBe('tools/call')
      bridge.respond(
        format === 'structured'
          ? {
              structuredContent: data,
              content: [{ type: 'text', text: 'Not the business result' }],
            }
          : { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false }
      )
      await vi.waitFor(() => expect(bridge.latest().method).toBe('ui/update-model-context'))
      const immediate = bridge.doc.querySelector('output')!.textContent
      expect(immediate).toBe('Created: Daily analysis')
      expect(bridge.doc.querySelector('button')).toBeDisabled()
      expect(bridge.api.state).toBeNull()
      bridge.respond({})
      await vi.waitFor(() =>
        expect(bridge.api.state).toEqual({
          view: 'created',
          id: 'real-id',
          name: 'Daily analysis',
        })
      )
      expect(
        bridge.post.mock.calls.filter(([value]) => value.method === 'tools/call')
      ).toHaveLength(1)
      const state = bridge.api.state
      bridge.post.mockClear()
      const reopened = await createGeneratedCard(state)
      expect(reopened.doc.querySelector('output')!.textContent).toBe(immediate)
      expect(reopened.doc.querySelector('button')).toBeDisabled()
      expect(reopened.post.mock.calls.some(([value]) => value.method === 'tools/call')).toBe(false)
    }
  )

  it('keeps a confirmed operation successful when saving the card state fails', async () => {
    const bridge = await createGeneratedCard()
    bridge.doc.querySelector('button')!.click()
    bridge.respond({ structuredContent: { automation: { id: 'real-id', name: 'Daily analysis' } } })
    await vi.waitFor(() => expect(bridge.latest().method).toBe('ui/update-model-context'))
    bridge.receive({
      id: bridge.latest().id,
      error: { code: 'mcp_app_storage_failed', message: 'Storage failed' },
    })
    await vi.waitFor(() =>
      expect(bridge.doc.querySelector('p')!.textContent).toBe('Created; card state was not saved')
    )
    expect(bridge.doc.querySelector('output')!.textContent).toBe('Created: Daily analysis')
    expect(bridge.doc.querySelector('button')).toBeDisabled()
    expect(bridge.post.mock.calls.filter(([value]) => value.method === 'tools/call')).toHaveLength(
      1
    )
  })

  it.each([
    null,
    {},
    { content: [{ type: 'text', text: 'Not JSON' }] },
    {
      content: [
        { type: 'text', text: '{}' },
        { type: 'text', text: '{}' },
      ],
    },
  ])('rejects an invalid tool result without returning the protocol envelope: %j', async result => {
    const bridge = await createBridge()
    bridge.publish('<p>Generated form</p>')
    const pending = bridge.api.callTool('create_automation', {})
    bridge.respond(result)
    await expect(pending).rejects.toMatchObject({
      code: 'invalid_tool_result',
      outcomeUnknown: true,
    })
    expect(bridge.post.mock.calls.filter(([value]) => value.method === 'tools/call')).toHaveLength(
      1
    )
  })

  it.each([null, false, [], 'A text result'])(
    'preserves JSON business values from tools without requiring a schedule object: %j',
    async data => {
      const bridge = await createBridge()
      bridge.publish('<p>Generated results</p>')
      const pending = bridge.api.callTool('list_conversations')
      bridge.respond({ content: [{ type: 'text', text: JSON.stringify(data) }] })
      await expect(pending).resolves.toEqual(data)
    }
  )

  it('waits for durable state acknowledgment and restores it before mounting on reopen', async () => {
    const first = await createBridge()
    first.publish('<p>Form</p>')
    const completed = { view: 'results', createdId: 'one' }
    const saving = first.api.setState(completed)
    await vi.waitFor(() =>
      expect(first.latest()).toMatchObject({
        method: 'ui/update-model-context',
        params: { structuredContent: { state: completed } },
      })
    )
    expect(first.api.state).toBeNull()
    first.respond({})
    await saving
    const second = await createBridge(first.api.state)
    second.publish('<p>Original generated document</p>')
    expect(second.api.state).toEqual(completed)
    const snapshot = second.api.state!
    snapshot.view = 'changed outside'
    expect(second.api.state).toEqual(completed)
    const failed = second.api.setState({ view: 'draft' })
    await vi.waitFor(() => expect(second.latest().method).toBe('ui/update-model-context'))
    second.receive({
      id: second.latest().id,
      error: { code: 'mcp_app_storage_failed', message: 'Storage failed' },
    })
    await expect(failed).rejects.toThrow('Storage failed')
    expect(second.api.state).toEqual(completed)
  })

  it('uses native navigation and reports intrinsic content shrinkage', async () => {
    const bridge = await createBridge()
    bridge.publish('<p>Results</p>')
    expect(bridge.api.navigationTargets).toEqual([
      { id: 'arbitrary-extension', path: '/extension' },
    ])
    const navigation = bridge.api.navigate('/extension')
    expect(bridge.latest()).toMatchObject({
      method: 'ui/open-link',
      params: { url: 'wework://navigate/%2Fextension' },
    })
    bridge.respond({})
    await navigation
    const shell = bridge.doc.getElementById('interaction-shell')!
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({ height: 1100 } as DOMRect)
    Object.defineProperty(bridge.doc.documentElement, 'scrollHeight', { value: 1100 })
    bridge.resize()
    expect(bridge.latest()).toMatchObject({
      method: 'ui/notifications/size-changed',
      params: { height: 1100 },
    })
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({ height: 240 } as DOMRect)
    bridge.resize()
    expect(bridge.latest()).toMatchObject({
      method: 'ui/notifications/size-changed',
      params: { height: 240 },
    })
    expect(bridge.doc.documentElement.scrollHeight).toBe(1100)
  })

  it('does not accept foreign messages or automatically retry timed-out writes', async () => {
    vi.useFakeTimers()
    const bridge = await createBridge()
    bridge.publish('<p>Form</p>')
    const result = bridge.api.callTool('create_automation', { name: 'Only once' })
    const rejected = expect(result).rejects.toMatchObject({ code: 'outcome_unknown' })
    bridge.receive(
      { id: bridge.latest().id, result: { structuredContent: { id: 'forged' } } },
      bridge.child
    )
    await vi.advanceTimersByTimeAsync(60000)
    await rejected
    expect(bridge.post.mock.calls.filter(([value]) => value.method === 'tools/call')).toHaveLength(
      1
    )
  })

  it('preserves a native unknown outcome without retrying a completed write', async () => {
    const bridge = await createBridge()
    bridge.publish('<p>Form</p>')
    const result = bridge.api.callTool('create_automation', { name: 'Only once' })
    const rejected = expect(result).rejects.toMatchObject({ code: 'outcome_unknown' })
    bridge.respond({
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            code: 'outcome_unknown',
            error: 'Check the actual result before retrying.',
          }),
        },
      ],
    })
    await rejected
    expect(bridge.post.mock.calls.filter(([value]) => value.method === 'tools/call')).toHaveLength(
      1
    )
  })
})
