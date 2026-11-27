import { io } from 'socket.io-client'

export function createWorker({
  endpoint,
  token,
  path,
  onError = console.error,
}) {
  const socket = io(new URL('/wework-worker', endpoint).href, {
    auth: { token },
    path,
    transports: ['websocket'],
    autoConnect: false,
  })
  let active = false
  let notified = false
  let claimTimer
  const controller = new AbortController()
  let handler

  function send(invocationId, deliveryId, event, signal) {
    return new Promise((resolve, reject) => {
      const frame = { invocationId, deliveryId, ...event }
      function stop() {
        signal.removeEventListener('abort', stop)
        socket.off('connect', sendFrame)
        reject(signal.reason)
      }
      function sendFrame() {
        socket.timeout(10000).emit('reply', frame, (error, receipt) => {
          if (signal.aborted) return
          if (error) {
            if (socket.connected) sendFrame()
            else socket.once('connect', sendFrame)
            return
          }
          signal.removeEventListener('abort', stop)
          if (receipt?.ok) resolve()
          else
            reject(
              new Error(
                receipt?.error?.message ??
                  receipt?.message ??
                  'Wework rejected the reply',
              ),
            )
        })
      }
      if (signal.aborted) return stop()
      signal.addEventListener('abort', stop, { once: true })
      if (socket.connected) sendFrame()
      else socket.once('connect', sendFrame)
    })
  }

  async function execute(task, deliveryId, signal) {
    let seq = 0
    let pending = Promise.resolve()
    function reply(type, text) {
      const event = { type, text, seq: ++seq }
      pending = pending.then(() =>
        send(task.invocationId, deliveryId, event, signal),
      )
      return pending
    }

    await reply('accepted')
    let result
    try {
      result = await handler(task, {
        signal,
        progress: (text) => reply('progress', text),
        append: (text) => reply('append', text),
      })
    } catch {
      await reply('failed', 'Worker task failed')
      return
    }
    await reply('succeeded', result)
  }

  function scheduleClaim(delay) {
    clearTimeout(claimTimer)
    if (!active && socket.connected) {
      claimTimer = setTimeout(claim, delay)
    }
  }

  async function claim() {
    if (active || !socket.connected) return
    active = true
    notified = false
    let claimed = false
    try {
      const receipt = await socket.timeout(10000).emitWithAck('claim', {})
      if (!receipt?.ok)
        throw new Error(receipt?.message ?? 'Wework rejected the task claim')
      if (receipt.task) {
        claimed = true
        await runLeasedTask(receipt.task)
      }
    } catch (error) {
      if (!controller.signal.aborted) onError(error)
    } finally {
      active = false
      scheduleClaim(notified || claimed ? 0 : 15000)
    }
  }

  async function runLeasedTask({ deliveryId, ...task }) {
    const lease = new AbortController()
    const frame = { invocationId: task.invocationId, deliveryId }
    const timer = setInterval(async () => {
      if (!socket.connected) return
      try {
        const receipt = await socket.timeout(5000).emitWithAck('renew', frame)
        if (!receipt?.ok) lease.abort(new Error('The task lease has expired'))
      } catch {
        // A lost acknowledgement does not establish that the lease was revoked.
      }
    }, 15000)
    try {
      await execute(
        task,
        deliveryId,
        AbortSignal.any([lease.signal, controller.signal]),
      )
    } finally {
      clearInterval(timer)
    }
  }

  socket.on('connect', () => scheduleClaim(0))
  socket.on('work_available', () => {
    notified = true
    scheduleClaim(0)
  })
  socket.on('disconnect', () => clearTimeout(claimTimer))

  return {
    onTask(callback) {
      if (handler) throw new Error('The task handler is already registered')
      handler = callback
    },
    async start() {
      if (!handler) throw new Error('Register the task handler before starting')
      if (controller.signal.aborted) throw controller.signal.reason
      if (socket.connected) return
      await new Promise((resolve, reject) => {
        const signal = controller.signal
        function cleanup() {
          socket.off('connect', connected)
          socket.off('connect_error', failed)
          signal.removeEventListener('abort', stopped)
        }
        function connected() {
          cleanup()
          resolve()
        }
        function failed(error) {
          cleanup()
          socket.disconnect()
          reject(error)
        }
        function stopped() {
          cleanup()
          reject(signal.reason)
        }
        socket.once('connect', connected)
        socket.once('connect_error', failed)
        signal.addEventListener('abort', stopped, { once: true })
        socket.connect()
      })
    },
    stop() {
      controller.abort()
      clearTimeout(claimTimer)
      socket.disconnect()
    },
  }
}
