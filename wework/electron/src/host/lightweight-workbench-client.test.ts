import { runInNewContext } from 'node:vm'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createLightweightClientSource } from './lightweight-workbench-client.js'

type Listener = (event: Record<string, unknown>) => void
type Message = { source: unknown; data: unknown; origin: string; ports: MessagePort[] }
interface FrameProperties {
  ref(element: unknown): void
  onLoad(): void
  srcDoc: string
}
interface Sdk {
  storage: { get(): Promise<unknown>; set(value: unknown): Promise<unknown> }
  notifications: { show(value: unknown): Promise<unknown> }
}
type BridgeResponse = { ok: boolean; json(): Promise<{ result: number }> }
type BridgeFetch = (url: string, options: { body: string }) => Promise<BridgeResponse>
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(dispose => dispose()))

/** Execute the generated parent and SDK with real document-owned MessagePorts. */
function fixture(
  fetch = vi.fn<BridgeFetch>(async () => ({ ok: true, json: async () => ({ result: 42 }) }))
) {
  const parentListeners = new Set<(event: Message) => void>()
  const childListeners = new Map<string, Set<Listener>>()
  const channels: MessageChannel[] = []
  const createChannel = () => {
    const channel = new MessageChannel()
    channels.push(channel)
    return channel
  }
  let Root!: () => { children: { props: FrameProperties }[] }
  const childWindow: { postMessage: (data: unknown) => void } = {
    postMessage(data) {
      for (const receive of childListeners.get('message') ?? [])
        receive({ source: parentWindow, data })
    },
  }
  const parentWindow = {
    postMessage(data: unknown, _target: string, ports: MessagePort[]) {
      for (const receive of parentListeners)
        receive({ source: childWindow, origin: 'null', data, ports })
    },
  }
  const React = {
    useRef: (current: unknown) => ({ current }),
    useCallback: (callback: unknown) => callback,
    createElement: (type: string, props: unknown, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
  }
  runInNewContext(createLightweightClientSource('@wework/test', '<main>App</main>'), {
    window: {
      __ModuleLoader__: {
        load: ({
          factory,
        }: {
          factory(require: () => typeof React): { apply(ctx: unknown): void }
        }) =>
          factory(() => React).apply({
            slots: {
              register: (_slot: unknown, component: typeof Root) => {
                Root = component
              },
            },
          }),
      },
    },
    crypto: { randomUUID: () => 'initial-document-token' },
    fetch,
    addEventListener: (_name: string, receive: (event: Message) => void) =>
      parentListeners.add(receive),
    removeEventListener: (_name: string, receive: (event: Message) => void) =>
      parentListeners.delete(receive),
  })
  const props = Root().children[0].props
  props.ref({ contentWindow: childWindow })
  const sdkWindow = {} as { weworkWorkbench: Sdk }
  const sdk = props.srcDoc.match(/<script>([\s\S]*?)<\/script>/)![1]
  runInNewContext(sdk, {
    window: sdkWindow,
    parent: parentWindow,
    MessageChannel: function () {
      return createChannel()
    },
    addEventListener: (name: string, receive: Listener) => {
      const listeners = childListeners.get(name) ?? new Set<Listener>()
      listeners.add(receive)
      childListeners.set(name, listeners)
    },
  })
  const dispose = () => {
    props.ref(null)
    for (const channel of channels) {
      channel.port1.close()
      channel.port2.close()
    }
  }
  cleanups.push(dispose)
  return {
    props,
    fetch,
    channels,
    sdk: sdkWindow.weworkWorkbench,
    childWindow,
    createChannel,
    send: (data: unknown, ports: MessagePort[] = [], source: unknown = childWindow) => {
      for (const receive of parentListeners) receive({ source, origin: 'null', data, ports })
    },
    pagehide: () => {
      for (const receive of childListeners.get('pagehide') ?? []) receive({})
    },
  }
}

describe('lightweight document bridge', () => {
  test('exposes ordinary state and immediate notifications without scheduled-reminder APIs', async () => {
    const app = fixture()
    expect(Object.keys(app.sdk.storage).sort()).toEqual(['get', 'set'])
    expect(Object.hasOwn(app.sdk, 'reminders')).toBe(false)
    expect(app.sdk.notifications.show).toBeTypeOf('function')
    app.props.onLoad()
    const value = [{ id: 'one', text: 'Keep my task', done: false }]
    await app.sdk.storage.set(value)
    expect(JSON.parse(app.fetch.mock.calls[0][1].body)).toEqual({
      capability: 'workbench.invoke',
      params: { method: 'storage.set', params: { value } },
    })
  })

  test('queues startup SDK calls until the initial load and invokes through the private port', async () => {
    const app = fixture()
    const pending = app.sdk.storage.get()
    expect(app.fetch).not.toHaveBeenCalled()
    app.props.onLoad()
    await expect(pending).resolves.toBe(42)
    expect(app.fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(app.fetch.mock.calls[0][1].body)).toEqual({
      capability: 'workbench.invoke',
      params: { method: 'storage.get', params: {} },
    })
  })

  test('rejects public RPC messages and a replacement document without the initial token', async () => {
    const app = fixture()
    // Model a remote document that kept the same WindowProxy and opaque origin.
    app.childWindow.postMessage = vi.fn()
    app.props.onLoad()
    app.send({ channel: 'wework-workbench', id: 1, method: 'storage.get', params: {} })
    const channel = app.createChannel()
    app.send({ channel: 'wework-workbench-ready', token: 'remote-document-token' }, [channel.port2])
    app.send(
      { channel: 'wework-workbench-ready', token: 'initial-document-token' },
      [channel.port2],
      {}
    )
    expect(channel.port2.onmessage).toBeNull()
    expect(app.fetch).not.toHaveBeenCalled()
    // A rejected handshake must leave the initial document able to connect.
    app.send({ channel: 'wework-workbench-ready', token: 'initial-document-token' }, [
      channel.port2,
    ])
    const reply = new Promise(resolve => {
      channel.port1.onmessage = event => resolve(event.data)
    })
    channel.port1.postMessage({ id: 2, method: 'storage.get', params: {} })
    await expect(reply).resolves.toEqual({ id: 2, result: 42 })
  })

  test.each(['load', 'detach'] as const)(
    'revokes the channel and drops an in-flight result on %s',
    async transition => {
      let finish!: (value: BridgeResponse) => void
      const app = fixture(vi.fn(() => new Promise<BridgeResponse>(resolve => (finish = resolve))))
      app.props.onLoad()
      const port = app.channels[0].port2
      const post = vi.spyOn(port, 'postMessage')
      const receive = port.onmessage!
      let inFlight: unknown
      port.onmessage = event => {
        inFlight = receive.call(port, event)
      }
      const pending = app.sdk.storage.get()
      const rejected = expect(pending).rejects.toThrow('Workbench document is closed')
      await vi.waitFor(() => expect(app.fetch).toHaveBeenCalledOnce())
      if (transition === 'load') app.props.onLoad()
      else app.props.ref(null)
      // Even an already queued callback must not start another native request.
      await receive.call(port, {
        data: { id: 99, method: 'storage.get', params: {} },
      } as MessageEvent)
      finish({ ok: true, json: async () => ({ result: 84 }) })
      await inFlight
      expect(post).not.toHaveBeenCalled()
      expect(app.fetch).toHaveBeenCalledOnce()
      const replacement = app.createChannel()
      app.send({ channel: 'wework-workbench-ready', token: 'initial-document-token' }, [
        replacement.port2,
      ])
      expect(replacement.port2.onmessage).toBeNull()
      app.pagehide()
      await rejected
    }
  )

  test('rejects pending and future SDK calls when the initial document leaves', async () => {
    const app = fixture()
    const pending = app.sdk.storage.get()
    const rejected = expect(pending).rejects.toThrow('Workbench document is closed')
    app.pagehide()
    await rejected
    await expect(app.sdk.storage.get()).rejects.toThrow('Workbench document is closed')
    app.props.onLoad()
    expect(app.fetch).not.toHaveBeenCalled()
  })
})
