import { createSSEParser } from './sse.mjs'

const $ = (id) => document.getElementById(id)
const state = {
  devices: [],
  device: '',
  streaming: false,
  abort: null,
  events: 0,
  after: null,
  before: null,
  historyId: '',
  configuration: '',
  pending: new Set(),
  hasMoreHistory: false,
}
const terminal = new Set(['completed', 'failed', 'cancelled', 'incomplete'])
const statusNames = {
  queued: '已提交 · 排队中',
  in_progress: '执行中',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已停止',
  incomplete: '未完成',
}

function node(tag, text, className) {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  return element
}

function notice(message, error = false) {
  $('notice').hidden = false
  $('notice').classList.toggle('error', error)
  $('notice').textContent = message
}

function configuration() {
  const base = $('base').value.trim().replace(/\/+$/, '')
  const key = $('key').value.trim()
  const url = new URL(base)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.pathname.endsWith('/api/v1')
  ) {
    throw new Error('API 地址应为 http(s)://主机[:端口]/api/v1')
  }
  if (!key) throw new Error('请先填写个人 API Key。')
  return { base, key, auth: $('auth').value }
}

function requestRow(method, path) {
  const log = $('request-log')
  log.querySelector('.empty')?.remove()
  const row = node('div', undefined, 'request')
  const result = node('span', '请求中…', 'result')
  row.append(node('span', method, 'method'), node('span', path, 'path'), result)
  log.prepend(row)
  while (log.children.length > 60) log.lastChild.remove()
  return result
}

function errorText(body) {
  if (typeof body === 'string') return body
  return JSON.stringify(body?.detail ?? body?.error ?? body, null, 2)
}

async function request(path, { method = 'GET', body, signal, stream = false } = {}) {
  const config = configuration()
  const headers = { 'Content-Type': 'application/json', 'X-Demo-Base': config.base }
  headers[config.auth === 'key' ? 'X-API-Key' : 'Authorization'] =
    config.auth === 'key' ? config.key : `Bearer ${config.key}`
  const result = requestRow(method, path)
  const start = performance.now()
  try {
    const response = await fetch(`/proxy${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
    result.textContent = `${response.status} · ${Math.round(performance.now() - start)} ms`
    if (
      stream &&
      response.ok &&
      response.headers.get('content-type')?.includes('text/event-stream')
    ) {
      return response
    }
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
    $('json').textContent =
      typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
    if (!response.ok) throw new Error(`HTTP ${response.status}\n${errorText(payload)}`)
    if (stream)
      throw new Error('预期 SSE，backend 返回了普通响应。请在 JSON 页签检查详情。')
    if (!payload || typeof payload !== 'object')
      throw new Error('backend 没有返回 JSON，请检查 API 地址。')
    return payload
  } catch (error) {
    if (signal?.aborted) result.textContent += ' · 已断开'
    else if (result.textContent === '请求中…') result.textContent = '连接失败'
    throw error
  }
}

function bind(id, action) {
  $(id).addEventListener('click', async () => {
    const button = $(id)
    state.pending.add(id)
    button.disabled = true
    streamingControls()
    try {
      await action()
    } catch (error) {
      notice(error.message, true)
    } finally {
      state.pending.delete(id)
      button.disabled = false
      streamingControls()
    }
  })
}

function selectTab(name) {
  for (const button of document.querySelectorAll('[data-tab]')) {
    const selected = button.dataset.tab === name
    button.classList.toggle('active', selected)
    button.setAttribute('aria-selected', String(selected))
    $(button.dataset.tab).hidden = !selected
  }
}
for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => selectTab(button.dataset.tab))
}

function textOutput(response) {
  return (response.output || [])
    .flatMap((item) => (item.type === 'message' ? item.content || [] : []))
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text || '')
    .join('\n')
}

function snapshot(response, { answer = true } = {}) {
  if (response.id) $('response-id').value = response.id
  if (response.conversation?.id) $('conversation-id').value = response.conversation.id
  $('run-status').textContent =
    statusNames[response.status] || response.status || '未知状态'
  $('latest').textContent =
    response.is_latest === undefined
      ? ''
      : response.is_latest
        ? '当前会话最后一轮'
        : '历史轮次'
  $('json').textContent = JSON.stringify(response, null, 2)
  if (answer) {
    const text = textOutput(response)
    $('answer').replaceChildren(
      text
        ? document.createTextNode(text)
        : node('p', '暂无文本输出。可查询状态，或订阅后续输出。', 'empty'),
    )
  }
  if (response.error) notice(`任务执行失败\n${errorText(response.error)}`, true)
}

function renderDevices() {
  $('devices').replaceChildren()
  $('device-count').textContent = state.devices.length
  if (!state.devices.length)
    $('devices').append(
      node('p', '暂无设备。请让 Wework 登录同一账号并连接 backend。', 'empty'),
    )
  for (const device of state.devices) {
    const button = node(
      'button',
      undefined,
      `device${state.device === device.device_id ? ' selected' : ''}`,
    )
    button.dataset.testid = `device-${device.device_id}`
    button.setAttribute('aria-pressed', String(state.device === device.device_id))
    const description = node('div')
    description.append(
      node('strong', device.name || device.device_id),
      node(
        'small',
        `${device.status} · ${device.device_type}${device.is_default ? ' · 默认' : ''}`,
      ),
      node('small', device.device_id),
    )
    button.append(node('span', undefined, `dot ${device.status}`), description)
    button.disabled = state.streaming
    button.addEventListener('click', () => {
      state.device = device.device_id
      state.after = null
      $('more-conversations').hidden = true
      renderDevices()
      if (device.status === 'offline')
        notice('已选择离线设备。发送时可验证 backend 是否返回 device_offline。')
    })
    $('devices').append(button)
  }
  const selected = state.devices.find((device) => device.device_id === state.device)
  $('selected-device').textContent = selected
    ? `执行设备：${selected.name} · ${selected.status}`
    : '尚未选择设备'
}

bind('connect', async () => {
  const config = configuration()
  const fingerprint = `${config.base}|${config.auth}|${config.key}`
  if (state.configuration !== fingerprint) {
    state.device = ''
    $('response-id').value = ''
    $('conversation-id').value = ''
    $('conversations').replaceChildren(node('p', '点击刷新查看会话。', 'empty'))
    state.after = null
    $('more-conversations').hidden = true
  }
  state.configuration = fingerprint
  const results = await Promise.allSettled([
    request('/devices'),
    request('/models?execution=wework'),
  ])
  const errors = []
  if (results[0].status === 'fulfilled') {
    state.devices = results[0].value.data || []
    if (!state.devices.some((device) => device.device_id === state.device)) {
      const online = state.devices.filter((device) =>
        ['online', 'busy'].includes(device.status),
      )
      state.device =
        (online.find((device) => device.is_default) || online[0])?.device_id || ''
    }
  } else {
    errors.push(`设备：${results[0].reason.message}`)
    state.devices = []
    state.device = ''
  }
  renderDevices()
  $('model').replaceChildren(node('option', '请选择模型'))
  $('model').firstChild.value = ''
  if (results[1].status === 'fulfilled') {
    for (const model of results[1].value.data || []) {
      const option = node(
        'option',
        `${model.name || model.id} · ${model.owned_by || ''}`,
      )
      option.value = model.id
      $('model').append(option)
    }
    if ($('model').options.length > 1) $('model').selectedIndex = 1
  } else errors.push(`模型：${results[1].reason.message}`)
  $('connection-status').textContent = errors.length
    ? '加载未完成'
    : '已加载 · 设备状态为查询时快照'
  notice(
    errors.length ? errors.join('\n') : '设备和模型已加载。选择目标后即可发送任务。',
    errors.length > 0,
  )
})

function required(id, message) {
  const value = $(id).value.trim()
  if (!value) throw new Error(message)
  return value
}

function updateIntent() {
  const mode = $('intent').value
  $('title-label').hidden = mode !== 'new'
  $('target-label').textContent = {
    new: '新建独立会话',
    conversation: '使用下方 Conversation ID',
    previous: '使用下方 Response ID',
  }[mode]
}
$('intent').addEventListener('change', updateIntent)

function streamingControls() {
  $('disconnect').disabled = !state.streaming
  const submitting =
    state.streaming || state.pending.has('send') || state.pending.has('subscribe')
  for (const id of [
    'send',
    'subscribe',
    'connect',
    'base',
    'key',
    'auth',
    'response-id',
    'conversation-id',
    'intent',
    'model',
  ]) {
    $(id).disabled = submitting || state.pending.has(id)
  }
  $('older-messages').disabled =
    !state.hasMoreHistory || state.pending.has('older-messages')
  $('live-dot').classList.toggle('active', state.streaming)
  for (const button of document.querySelectorAll('.device, .conversation'))
    button.disabled = submitting
}

async function streamRequest(path, options = {}) {
  if (state.streaming) throw new Error('请先断开当前输出连接。')
  state.streaming = true
  state.abort = new AbortController()
  streamingControls()
  state.events = 0
  $('events').replaceChildren()
  $('event-count').textContent = '0'
  $('answer').replaceChildren(node('p', '等待 Runtime 输出…', 'empty'))
  $('heartbeat').textContent = '建立连接中…'
  selectTab('answer')
  let ended = false
  const items = new Map()
  const parser = createSSEParser(
    ({ event, data }) => {
      if (data === '[DONE]') return
      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        throw new Error('收到无法解析的 SSE 数据。')
      }
      const type = payload.type || event
      state.events += 1
      $('event-count').textContent = state.events
      $('heartbeat').textContent = `最近事件 ${new Date().toLocaleTimeString()}`
      const detail = node('details', undefined, 'event')
      detail.dataset.testid = `event-${state.events}`
      detail.append(
        node('summary', `${String(state.events).padStart(2, '0')}  ${type}`),
        node('pre', JSON.stringify(payload, null, 2)),
      )
      $('events').append(detail)
      while ($('events').children.length > 300) $('events').firstChild.remove()
      $('json').textContent = JSON.stringify(payload, null, 2)
      if (payload.response) {
        snapshot(payload.response, { answer: false })
        if (terminal.has(payload.response.status)) {
          ended = true
          const finalText = textOutput(payload.response)
          if (finalText) $('answer').textContent = finalText
        }
      }
      if (
        type === 'response.output_text.delta' ||
        type === 'response.output_text.done'
      ) {
        const key = payload.item_id || 'message'
        items.set(
          key,
          type.endsWith('.delta')
            ? (items.get(key) || '') + (payload.delta || '')
            : payload.text || '',
        )
        $('answer').textContent = [...items.values()].join('\n')
      }
    },
    () => {
      $('heartbeat').textContent = `心跳 ${new Date().toLocaleTimeString()} · 连接正常`
    },
  )
  try {
    const response = await request(path, {
      ...options,
      stream: true,
      signal: state.abort.signal,
    })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        parser.feed(decoder.decode(value, { stream: true }))
      }
      parser.feed(decoder.decode())
      parser.finish()
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    if (!ended)
      notice(
        '输出连接已结束，但未收到终态事件。请查询任务状态；不要据此重复提交任务。',
        true,
      )
    else if (!$('notice').classList.contains('error'))
      notice('已收到任务终态，输出连接结束。')
  } catch (error) {
    if (state.abort.signal.aborted)
      notice('已断开输出连接。任务仍可继续运行，可查询状态或点击“停止任务”。')
    else {
      $('run-status').textContent = '请求或输出连接失败'
      if (!items.size)
        $('answer').textContent =
          '没有收到回答文本，请查看上方错误详情。提交结果不明确时，可刷新会话列表确认。'
      throw error
    }
  } finally {
    $('heartbeat').textContent = ended ? '已收到终态 · 连接结束' : '输出连接已关闭'
    state.streaming = false
    state.abort = null
    streamingControls()
  }
}

bind('send', async () => {
  const config = configuration()
  if (`${config.base}|${config.auth}|${config.key}` !== state.configuration) {
    throw new Error('连接配置已变更，请先重新加载设备和模型。')
  }
  const body = {
    model: required('model', '请先加载并选择模型。'),
    input: required('prompt', '请填写任务内容。'),
    stream: $('mode').value === 'stream',
    background: $('mode').value === 'background',
  }
  if ($('intent').value === 'new') {
    if (!state.device) throw new Error('请先选择执行设备。')
    body.execution = { type: 'wework', device_id: state.device }
    if ($('title').value.trim()) body.execution.title = $('title').value.trim()
  } else if ($('intent').value === 'conversation') {
    body.conversation = required(
      'conversation-id',
      '请填写 Conversation ID，或从列表选择会话。',
    )
  } else
    body.previous_response_id = required('response-id', '请填写要接续的 Response ID。')
  $('response-id').value = ''
  if ($('intent').value === 'new') $('conversation-id').value = ''
  $('latest').textContent = ''
  $('run-status').textContent = '正在提交'
  notice('正在提交任务…')
  if (body.stream) return streamRequest('/responses', { method: 'POST', body })
  const result = await request('/responses', { method: 'POST', body })
  snapshot(result)
  selectTab('answer')
  if (!result.error)
    notice(
      body.background
        ? '异步任务已提交。可点击“查询状态 / 输出”或“订阅新输出”。'
        : '已收到同步响应。',
    )
})

bind('query-response', async () => {
  const id = required('response-id', '请先提交任务或填写 Response ID。')
  const result = await request(`/responses/${encodeURIComponent(id)}`)
  snapshot(result, { answer: !state.streaming })
  if (!state.streaming) selectTab('answer')
})
bind('subscribe', async () => {
  const id = required('response-id', '请填写要订阅的 Response ID。')
  notice('订阅只接收新输出，不重放已有事件。')
  await streamRequest(`/responses/${encodeURIComponent(id)}?stream=true`)
})
bind('cancel', async () => {
  const id = required('response-id', '请填写要停止的 Response ID。')
  const result = await request(`/responses/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  })
  snapshot(result, { answer: !state.streaming })
  notice(
    result.cancellation_requested
      ? 'Runtime 已接受停止请求，请查询状态确认最终结果。'
      : `任务状态：${result.status}`,
  )
})
$('disconnect').addEventListener('click', () => state.abort?.abort())

async function loadConversations(more = false) {
  const query = new URLSearchParams({ execution: 'wework', limit: '20' })
  if ($('filter-device').checked) {
    if (!state.device) throw new Error('请先选择设备。')
    query.set('device_id', state.device)
  }
  if (more && state.after) query.set('after', state.after)
  const result = await request(`/conversations?${query}`)
  if (!more) $('conversations').replaceChildren()
  for (const conversation of result.data || []) {
    const button = node('button', undefined, 'conversation')
    button.dataset.testid = `conversation-${conversation.id}`
    button.disabled = state.streaming
    button.append(
      node('strong', conversation.title || '未命名会话'),
      node(
        'small',
        `${conversation.running ? '执行中' : conversation.status || '空闲'} · ${conversation.device_id}`,
      ),
    )
    button.addEventListener('click', async () => {
      if (state.streaming) return notice('请先断开当前输出连接，再切换会话。')
      $('conversation-id').value = conversation.id
      $('intent').value = 'conversation'
      updateIntent()
      try {
        await loadConversation()
      } catch (error) {
        notice(error.message, true)
      }
    })
    $('conversations').append(button)
  }
  if (!$('conversations').children.length)
    $('conversations').append(node('p', '没有可用的独立会话。设备需要在线。', 'empty'))
  state.after = result.last_id
  $('more-conversations').hidden = !result.has_more
}
bind('refresh-conversations', () => loadConversations())
bind('more-conversations', () => loadConversations(true))
$('filter-device').addEventListener('change', () => {
  state.after = null
  $('more-conversations').hidden = true
  loadConversations().catch((error) => notice(error.message, true))
})

async function loadConversation(older = false) {
  const id = required('conversation-id', '请填写 Conversation ID 或选择会话。')
  if (older && state.historyId !== id)
    throw new Error('会话 ID 已更改，请先点击“查看会话”。')
  const query = new URLSearchParams({ limit: '20' })
  if (older && state.before) query.set('before', state.before)
  const result = await request(`/conversations/${encodeURIComponent(id)}?${query}`)
  if (!older) $('history').replaceChildren()
  const fragment = document.createDocumentFragment()
  for (const message of result.messages || []) {
    const element = node('article', undefined, 'message')
    element.append(
      node('strong', message.role),
      node('p', message.content || '（非文本消息，详情见 JSON）'),
    )
    fragment.append(element)
  }
  if (older) $('history').prepend(fragment)
  else $('history').append(fragment)
  if (!$('history').children.length)
    $('history').append(node('p', '暂无消息。', 'empty'))
  state.before = result.before
  state.historyId = id
  state.hasMoreHistory = Boolean(result.has_more && result.before)
  $('older-messages').disabled = !result.has_more
  if (result.latest_response && !state.streaming) snapshot(result.latest_response)
  if (!result.latest_response && !state.streaming) {
    $('response-id').value = ''
    $('latest').textContent = '会话暂无轮次'
  }
  $('json').textContent = JSON.stringify(result, null, 2)
  selectTab('history')
}
bind('query-conversation', () => loadConversation())
bind('older-messages', () => loadConversation(true))
$('clear-log').addEventListener('click', () => $('request-log').replaceChildren())
