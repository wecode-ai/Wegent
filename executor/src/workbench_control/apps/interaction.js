;(() => {
  const shell = document.getElementById('interaction-shell')
  const content = document.getElementById('interaction-content')
  const error = document.getElementById('interaction-error')
  const pending = new Map()
  let sequence = 0
  let initialized = false
  let mounted = false
  let alive = true
  let payload = null
  let context = {}
  let savedState = null
  let tools = new Map()
  let saving = Promise.resolve()
  const copy = value => JSON.parse(JSON.stringify(value))
  const message = (en, zh) => ((context.locale || navigator.language).startsWith('zh') ? zh : en)
  const notify = (method, params) =>
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*')

  function request(method, params) {
    if (!alive) return Promise.reject(new Error('Interaction closed'))
    const id = `wework-ui-${++sequence}`
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(
          Object.assign(
            new Error(
              message(
                'Request timed out. Check the actual result before retrying.',
                '请求超时，请核实实际结果后再操作。'
              )
            ),
            { code: 'outcome_unknown' }
          )
        )
      }, 60000)
      pending.set(id, { resolve, reject, timeout })
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')
    })
  }

  function applyContext(update) {
    context = { ...context, ...update }
    document.documentElement.lang = context.locale || navigator.language
    if (context.theme) document.documentElement.style.colorScheme = context.theme
    for (const [name, value] of Object.entries(context.styles?.variables || {})) {
      if (/^--(?:color-|font-)/.test(name)) document.documentElement.style.setProperty(name, value)
    }
  }

  function toolData(result) {
    if (result?.structuredContent != null) return result.structuredContent
    if (
      Array.isArray(result?.content) &&
      result.content.length === 1 &&
      result.content[0]?.type === 'text'
    ) {
      try {
        return JSON.parse(result.content[0].text)
      } catch {
        // A successful MCP transport does not make malformed business data usable.
      }
    }
    throw Object.assign(
      new Error(
        message(
          'The tool returned an invalid result. Check the actual result before retrying.',
          '工具返回格式异常，请核实实际结果后再操作。'
        )
      ),
      { code: 'invalid_tool_result', outcomeUnknown: true }
    )
  }

  async function callTool(name, args = {}) {
    if (!tools.has(name)) throw new Error(`Tool is not bound to this interaction: ${name}`)
    const result = await request('tools/call', { name, arguments: args })
    if (result?.isError) {
      const detail = result.content?.find(item => item.type === 'text')?.text || 'Tool failed'
      let parsed
      try {
        parsed = JSON.parse(detail)
      } catch {
        parsed = { error: detail }
      }
      throw Object.assign(new Error(parsed.error || detail), {
        code: parsed.code,
      })
    }
    return toolData(result)
  }

  async function navigate(target) {
    const url = target.startsWith('/') ? `wework://navigate/${encodeURIComponent(target)}` : target
    if (!url.startsWith('wework://')) throw new Error('Use an existing Wework destination')
    const result = await request('ui/open-link', { url })
    if (result.isError)
      throw new Error(message('This destination is unavailable.', '此功能入口当前不可用。'))
  }

  function setState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state))
      return Promise.reject(new Error('State must be an object'))
    const snapshot = copy(state)
    if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 64000)
      return Promise.reject(new Error('State exceeds 64 KiB'))
    saving = saving
      .catch(() => {})
      .then(async () => {
        await request('ui/update-model-context', {
          structuredContent: { state: snapshot },
        })
        savedState = snapshot
      })
    return saving
  }

  Object.defineProperty(window, 'wework', {
    value: Object.freeze({
      callTool,
      navigate,
      setState,
      get state() {
        return copy(savedState)
      },
      get context() {
        return copy(context)
      },
      get navigationTargets() {
        return copy(context.navigationTargets || [])
      },
    }),
  })

  function mount() {
    if (!initialized || mounted || !payload) return
    mounted = true
    tools = new Map(payload.tools.map(tool => [tool.name, tool]))
    document.title = payload.title || 'Wework'
    const template = document.createElement('template')
    template.innerHTML = payload.html
    const scripts = [...template.content.querySelectorAll('script')]
    for (const script of scripts) script.remove()
    content.replaceChildren(template.content)
    for (const original of scripts) {
      if (original.hasAttribute('src')) throw new Error('External scripts are unavailable')
      const script = document.createElement('script')
      if (original.type) script.type = original.type
      script.textContent = original.textContent
      content.append(script)
    }
  }

  function fail(failure) {
    if (!alive) return
    error.textContent = failure.message || String(failure)
    error.hidden = false
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return
    const data = event.data
    const operation = pending.get(data.id)
    if (operation) {
      clearTimeout(operation.timeout)
      pending.delete(data.id)
      if (data.error)
        operation.reject(
          Object.assign(new Error(data.error.message), {
            code: data.error.code,
          })
        )
      else operation.resolve(data.result)
    }
    if (data.method === 'ui/notifications/host-context-changed') applyContext(data.params)
    if (data.method === 'ui/notifications/tool-result') {
      if (data.params?.isError) return fail(new Error('Interaction could not be opened'))
      const html = data.params?._meta?.ui?.html
      if (typeof html === 'string') {
        payload = {
          html,
          title: data.params?.structuredContent?.title,
          tools: data.params._meta.ui.tools || [],
        }
        try {
          mount()
        } catch (failure) {
          fail(failure)
        }
      }
    }
    if (data.method === 'ui/resource-teardown') {
      alive = false
      resize?.disconnect()
      for (const operation of pending.values()) {
        clearTimeout(operation.timeout)
        operation.reject(new Error('Interaction closed'))
      }
      pending.clear()
      window.parent.postMessage({ jsonrpc: '2.0', id: data.id, result: {} }, '*')
    }
  })
  window.addEventListener('error', event => fail(event.error || new Error(event.message)))
  window.addEventListener('unhandledrejection', event => fail(event.reason))

  void request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'wework-interaction', version: '1.0.0' },
    appCapabilities: {},
  })
    .then(async result => {
      applyContext(result.hostContext || {})
      savedState = context.modelContext?.structuredContent?.state ?? null
      initialized = true
      notify('ui/notifications/initialized', {})
      mount()
    })
    .catch(fail)
  const resize =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() =>
          notify('ui/notifications/size-changed', {
            height: Math.ceil(shell.getBoundingClientRect().height),
          })
        )
  resize?.observe(shell)
})()
