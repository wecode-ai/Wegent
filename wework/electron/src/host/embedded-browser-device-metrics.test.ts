import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { expect, test, vi } from 'vitest'
import { FakeWebContents } from '../../test-fixtures/embedded-browser.js'
import { EmbeddedBrowserManager } from './embedded-browser-manager.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function browser() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-browser-metrics-'))
  const manager = new EmbeddedBrowserManager(directory)
  const contents = new FakeWebContents()
  const events = new EventEmitter()
  let attached = false
  let viewportWidth: number | null = null
  contents.debugger.isAttached.mockImplementation(() => attached)
  contents.debugger.attach.mockImplementation(() => {
    attached = true
  })
  contents.debugger.detach.mockImplementation(() => {
    attached = false
    viewportWidth = null
    events.emit('detach')
  })
  contents.debugger.on.mockImplementation((event, listener) => events.on(event, listener))
  contents.debugger.off.mockImplementation((event, listener) => events.off(event, listener))
  const command = async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Emulation.setDeviceMetricsOverride') viewportWidth = params!.width as number
    if (method === 'Emulation.clearDeviceMetricsOverride') viewportWidth = null
    return { result: { value: viewportWidth ?? 259 } }
  }
  contents.debugger.sendCommand.mockImplementation(command)
  manager.attach('browser', contents as unknown as WebContents)
  await manager.open({
    label: 'browser',
    url: 'about:blank',
    bounds: { x: 0, y: 0, width: 259, height: 560 },
    visible: true,
    navigateExisting: false,
  })
  return {
    manager,
    contents,
    command,
    dispose: async () => {
      manager.close('browser')
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('keeps the selected viewport after an overlapping page read releases its debugger', async () => {
  const { manager, contents, command, dispose } = await browser()
  const reading = deferred()
  contents.debugger.sendCommand.mockImplementation(async (method, params) => {
    if (method === 'Runtime.evaluate') await reading.promise
    return command(method, params)
  })
  try {
    const read = manager.evaluate('browser', 'window.innerWidth')
    await manager.setDeviceMetrics('browser', { width: 390, height: 844, scale: 0.664 })
    reading.resolve()
    await expect(read).resolves.toBe(390)
    await expect(manager.evaluate('browser', 'window.innerWidth')).resolves.toBe(390)
    expect(contents.debugger.detach).not.toHaveBeenCalled()
    await manager.setDeviceMetrics('browser', null)
    expect(contents.debugger.detach).toHaveBeenCalledOnce()
  } finally {
    reading.resolve()
    await dispose()
  }
})

test('clears device metrics without disconnecting an overlapping page read', async () => {
  const { manager, contents, command, dispose } = await browser()
  const reading = deferred()
  try {
    await manager.setDeviceMetrics('browser', { width: 390, height: 844, scale: 0.664 })
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Runtime.evaluate') await reading.promise
      return command(method, params)
    })
    const read = manager.evaluate('browser', 'window.innerWidth')
    await manager.setDeviceMetrics('browser', null)
    expect(contents.debugger.detach).not.toHaveBeenCalled()
    reading.resolve()
    await expect(read).resolves.toBe(259)
    expect(contents.debugger.detach).toHaveBeenCalledOnce()
  } finally {
    reading.resolve()
    await dispose()
  }
})

test('applies a replacement viewport after the previous clear acknowledges', async () => {
  const { manager, contents, command, dispose } = await browser()
  const clearing = deferred()
  try {
    await manager.setDeviceMetrics('browser', { width: 390, height: 844, scale: 0.664 })
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Emulation.clearDeviceMetricsOverride') await clearing.promise
      return command(method, params)
    })
    const clear = manager.setDeviceMetrics('browser', null)
    await vi.waitFor(() =>
      expect(contents.debugger.sendCommand).toHaveBeenCalledWith(
        'Emulation.clearDeviceMetricsOverride'
      )
    )
    const replacement = manager.setDeviceMetrics('browser', { width: 844, height: 390, scale: 0.5 })
    clearing.resolve()
    await Promise.all([clear, replacement])
    await expect(manager.evaluate('browser', 'window.innerWidth')).resolves.toBe(844)
    expect(contents.debugger.isAttached()).toBe(true)
  } finally {
    clearing.resolve()
    await dispose()
  }
})

test('keeps device metrics when an overlapping file upload finishes', async () => {
  const { manager, contents, command, dispose } = await browser()
  const uploading = deferred()
  contents.debugger.sendCommand.mockImplementation(async (method, params) => {
    if (method === 'DOM.getDocument') {
      await uploading.promise
      return { root: { nodeId: 1 } }
    }
    if (method === 'DOM.querySelector') return { nodeId: 2 }
    return command(method, params)
  })
  try {
    const upload = manager.uploadFiles('browser', null, ['/tmp/example.txt'])
    await manager.setDeviceMetrics('browser', { width: 390, height: 844, scale: 0.664 })
    uploading.resolve()
    await expect(upload).resolves.toEqual({ selector: 'input[type="file"]' })
    await expect(manager.evaluate('browser', 'window.innerWidth')).resolves.toBe(390)
    expect(contents.debugger.detach).not.toHaveBeenCalled()
  } finally {
    uploading.resolve()
    await dispose()
  }
})

test.each(['close', 'destroy'] as const)('releases device metrics on browser %s', async action => {
  const { manager, contents, dispose } = await browser()
  try {
    await manager.setDeviceMetrics('browser', { width: 390, height: 844, scale: 0.664 })
    if (action === 'close') manager.close('browser')
    else contents.close()
    expect(contents.debugger.detach).toHaveBeenCalledOnce()
    expect(contents.debugger.isAttached()).toBe(false)
  } finally {
    await dispose()
  }
})

test.each(['close', 'destroy'] as const)(
  'does not reacquire a debugger for queued updates after browser %s',
  async action => {
    const { manager, contents, command, dispose } = await browser()
    const applying = deferred()
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      await applying.promise
      return command(method, params)
    })
    try {
      const first = manager.setDeviceMetrics('browser', { width: 390, height: 844, scale: 0.664 })
      await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledOnce())
      const queued = manager.setDeviceMetrics('browser', { width: 844, height: 390, scale: 0.5 })
      const rejected = expect(queued).rejects.toThrow('closed before updating device metrics')
      if (action === 'close') manager.close('browser')
      else contents.close()
      applying.resolve()
      await first
      await rejected
      expect(contents.debugger.attach).toHaveBeenCalledOnce()
      expect(contents.debugger.detach).toHaveBeenCalledOnce()
      expect(contents.debugger.sendCommand).toHaveBeenCalledOnce()
    } finally {
      applying.resolve()
      await dispose()
    }
  }
)

test('preserves device metrics when the same browser entry is relabeled', async () => {
  const { manager, contents, dispose } = await browser()
  try {
    await manager.setDeviceMetrics('browser', { width: 390, height: 844, scale: 0.664 })
    manager.relabel('browser', 'renamed')
    await expect(manager.evaluate('renamed', 'window.innerWidth')).resolves.toBe(390)
    await manager.setDeviceMetrics('renamed', null)
    expect(contents.debugger.detach).toHaveBeenCalledOnce()
  } finally {
    manager.close('renamed')
    await dispose()
  }
})

test('releases a rejected initial override and accepts the next update', async () => {
  const { manager, contents, dispose } = await browser()
  try {
    contents.debugger.sendCommand.mockRejectedValueOnce(new Error('Override rejected'))
    await expect(
      manager.setDeviceMetrics('browser', { width: 390, height: 844, scale: 0.664 })
    ).rejects.toThrow('Override rejected')
    expect(contents.debugger.detach).toHaveBeenCalledOnce()
    await manager.setDeviceMetrics('browser', { width: 390, height: 844, scale: 0.664 })
    await expect(manager.evaluate('browser', 'window.innerWidth')).resolves.toBe(390)
    expect(contents.debugger.isAttached()).toBe(true)
  } finally {
    await dispose()
  }
})

test('borrows an external inspector without disconnecting it after device mode ends', async () => {
  const { manager, contents, dispose } = await browser()
  contents.debugger.attach()
  contents.debugger.attach.mockClear()
  try {
    await manager.setDeviceMetrics('browser', { width: 390, height: 844, scale: 0.664 })
    await manager.setDeviceMetrics('browser', null)
    expect(contents.debugger.attach).not.toHaveBeenCalled()
    expect(contents.debugger.detach).not.toHaveBeenCalled()
    expect(contents.debugger.isAttached()).toBe(true)
  } finally {
    await dispose()
  }
})
