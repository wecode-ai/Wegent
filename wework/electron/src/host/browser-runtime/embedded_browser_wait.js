;(() => {
  const input = __WEWORK_WAIT_INPUT__
  const startedAt = performance.now()
  const warnings = []
  const agent = ensureAgentRuntime()
  const quietMs = clampNumber(input.quietMs || input.options?.quietMs, 0, 5000, 250)
  const condition = normalizeCondition(input)
  const waitId = String(input.waitId || JSON.stringify(condition))
  agent.waitStates =
    agent.waitStates && typeof agent.waitStates === 'object' ? agent.waitStates : {}
  const waitState = agent.waitStates[waitId] || {
    initial: observe(condition),
    startedAt: performance.now(),
  }
  agent.waitStates[waitId] = waitState

  try {
    const observed = observe(condition)
    const matched = evaluateCondition(condition, observed, waitState.initial, quietMs)
    if (matched.ok) {
      delete agent.waitStates[waitId]
      return {
        ok: true,
        kind: 'browser.wait',
        backend: 'wkwebview-js',
        condition,
        reason: matched.reason,
        observed,
        elapsedMs: elapsed(waitState.startedAt || startedAt),
        warnings,
      }
    }

    return {
      ok: false,
      kind: 'browser.wait',
      backend: 'wkwebview-js',
      condition,
      reason: matched.reason,
      observed,
      elapsedMs: elapsed(waitState.startedAt || startedAt),
      warnings,
      error: {
        code: 'wait_condition_not_met',
        message: 'Embedded browser wait condition is not met yet.',
        recoverable: true,
        suggestedNextAction: 'wait',
      },
    }
  } catch (error) {
    return {
      ok: false,
      kind: 'browser.wait',
      backend: 'wkwebview-js',
      condition,
      reason: 'operation_failed',
      observed: observe(condition),
      elapsedMs: elapsed(waitState.startedAt || startedAt),
      warnings,
      error: {
        code: 'operation_failed',
        message: String(error?.stack || error?.message || error),
        recoverable: true,
        suggestedNextAction: 'inspect',
      },
    }
  }

  function ensureAgentRuntime() {
    const current = window.__WEWORK_BROWSER_AGENT__ || {}
    current.domRevision = Number.isFinite(current.domRevision) ? current.domRevision : 0
    current.viewportRevision = Number.isFinite(current.viewportRevision)
      ? current.viewportRevision
      : 0
    current.lastDomMutationAt = Number.isFinite(current.lastDomMutationAt)
      ? current.lastDomMutationAt
      : performance.now()
    current.lastViewportMutationAt = Number.isFinite(current.lastViewportMutationAt)
      ? current.lastViewportMutationAt
      : performance.now()
    window.__WEWORK_BROWSER_AGENT__ = current

    if (!current.revisionObserverInstalled && document.documentElement) {
      const bumpDom = () => {
        current.domRevision += 1
        current.lastDomMutationAt = performance.now()
      }
      const bumpViewport = () => {
        current.viewportRevision += 1
        current.lastViewportMutationAt = performance.now()
      }
      new MutationObserver(bumpDom).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
      window.addEventListener('input', bumpDom, true)
      window.addEventListener('change', bumpDom, true)
      window.addEventListener('scroll', bumpViewport, true)
      window.addEventListener('resize', bumpViewport, true)
      window.visualViewport?.addEventListener('scroll', bumpViewport)
      window.visualViewport?.addEventListener('resize', bumpViewport)
      current.revisionObserverInstalled = true
    }
    return current
  }

  function normalizeCondition(request) {
    const optionCondition =
      request.options && typeof request.options.condition === 'object'
        ? request.options.condition
        : {}
    const condition = { ...optionCondition }
    if (request.selector && !condition.selectorAttached && !condition.selectorVisible) {
      condition.selectorAttached = request.selector
    }
    if (request.text && !condition.textVisible) {
      condition.textVisible = request.text
    }
    if (request.url && !condition.urlIncludes) {
      condition.urlIncludes = request.url
    }
    if (request.expression && !condition.expression) {
      condition.expression = request.expression
    }
    if (request.waitUntil && !condition.waitUntil) {
      condition.waitUntil = request.waitUntil
    }
    if (Object.keys(condition).length === 0) {
      condition.waitUntil = 'pageStable'
    }
    return condition
  }

  function observe(currentCondition) {
    const target = resolveConditionTarget(currentCondition)
    return {
      url: location.href,
      title: document.title || '',
      readyState: document.readyState,
      domRevision: Number(agent.domRevision || 0),
      viewportRevision: Number(agent.viewportRevision || 0),
      domQuietMs: Math.max(0, performance.now() - Number(agent.lastDomMutationAt || 0)),
      viewportQuietMs: Math.max(0, performance.now() - Number(agent.lastViewportMutationAt || 0)),
      textSample: trimText(document.body?.innerText || '', 500),
      target: target.summary,
    }
  }

  function evaluateCondition(currentCondition, observed, initialObserved, stableQuietMs) {
    const checks = []
    if (currentCondition.selectorAttached) {
      checks.push({
        ok: Boolean(query(currentCondition.selectorAttached)),
        reason: 'selector_attached',
      })
    }
    if (currentCondition.selectorVisible) {
      const element = query(currentCondition.selectorVisible)
      checks.push({
        ok: Boolean(element && visibilityFor(element).visible),
        reason: 'selector_visible',
      })
    }
    if (currentCondition.textVisible) {
      checks.push({
        ok: (document.body?.innerText || '').includes(String(currentCondition.textVisible)),
        reason: 'text_visible',
      })
    }
    if (currentCondition.urlIncludes) {
      checks.push({
        ok: location.href.includes(String(currentCondition.urlIncludes)),
        reason: 'url_includes',
      })
    }
    if (currentCondition.urlMatches) {
      checks.push({
        ok: safeRegex(currentCondition.urlMatches).test(location.href),
        reason: 'url_matches',
      })
    }
    if (currentCondition.titleIncludes) {
      checks.push({
        ok: document.title.includes(String(currentCondition.titleIncludes)),
        reason: 'title_includes',
      })
    }
    if (currentCondition.revisionChanged) {
      const revision = currentCondition.revisionChanged
      const domChanged =
        revision === true ||
        revision === 'dom' ||
        (typeof revision === 'object' && revision.dom !== false)
      const viewportChanged =
        revision === 'viewport' || (typeof revision === 'object' && revision.viewport === true)
      checks.push({
        ok:
          (domChanged && observed.domRevision !== initialObserved.domRevision) ||
          (viewportChanged && observed.viewportRevision !== initialObserved.viewportRevision),
        reason: 'revision_changed',
      })
    }
    if (currentCondition.domStable || currentCondition.waitUntil === 'domStable') {
      checks.push({
        ok: observed.domQuietMs >= quietMsFor(currentCondition.domStable, stableQuietMs),
        reason: 'dom_stable',
      })
    }
    if (currentCondition.waitUntil === 'pageStable') {
      checks.push({
        ok:
          ['interactive', 'complete'].includes(document.readyState) &&
          observed.domQuietMs >= stableQuietMs &&
          observed.viewportQuietMs >= Math.min(stableQuietMs, 150),
        reason: 'page_stable',
      })
    }
    if (currentCondition.inputValueChanged) {
      const target = resolveConditionTarget(currentCondition.inputValueChanged)
      checks.push({
        ok:
          target.element &&
          target.summary.value !== undefined &&
          target.summary.value !== initialObserved.target?.value,
        reason: 'input_value_changed',
      })
    }
    if (currentCondition.elementGone) {
      checks.push({
        ok: !resolveConditionTarget(currentCondition.elementGone).element,
        reason: 'element_gone',
      })
    }
    if (currentCondition.expression) {
      checks.push({
        ok: Boolean(safeEvaluateExpression(currentCondition.expression)),
        reason: 'expression',
      })
    }
    if (checks.length === 0) {
      checks.push({
        ok: ['interactive', 'complete'].includes(document.readyState),
        reason: 'load_finished',
      })
    }
    const failed = checks.find(check => !check.ok)
    return failed
      ? { ok: false, reason: failed.reason }
      : { ok: true, reason: checks.at(-1).reason }
  }

  function resolveConditionTarget(value) {
    if (!value || typeof value !== 'object') {
      return { element: null, summary: undefined }
    }
    if (value.ref || (value.inspectId && Number.isFinite(Number(value.index)))) {
      const resolver = window.__WEWORK_BROWSER_AGENT__?.resolveInspectElement
      const resolved =
        typeof resolver === 'function'
          ? resolver({
              ref: value.ref || undefined,
              inspectId: value.inspectId || undefined,
              index: value.index,
            })
          : { ok: false }
      if (resolved.ok) {
        return { element: resolved.element, summary: summarizeElement(resolved.element) }
      }
    }
    const selector = typeof value === 'string' ? value : value.selector
    if (selector) {
      const element = query(selector)
      return { element, summary: summarizeElement(element) }
    }
    return { element: null, summary: undefined }
  }

  function query(selector) {
    try {
      return document.querySelector(String(selector).replace(/^css=/, ''))
    } catch {
      warnings.push({
        code: 'selector_invalid',
        message: `Invalid selector: ${String(selector)}`,
      })
      return null
    }
  }

  function visibilityFor(element) {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' &&
      Number(style.opacity || '1') > 0.01 &&
      !element.hidden
    const inViewport =
      rect.x + rect.width >= 0 &&
      rect.y + rect.height >= 0 &&
      rect.x <= window.innerWidth &&
      rect.y <= window.innerHeight
    return { visible, inViewport }
  }

  function summarizeElement(element) {
    if (!element) return undefined
    const value = valueFor(element)
    const rect = element.getBoundingClientRect()
    return {
      tagName: element.tagName?.toLowerCase() || '',
      id: element.id || undefined,
      name: trimText(
        element.getAttribute?.('aria-label') ||
          element.getAttribute?.('title') ||
          element.innerText ||
          element.textContent ||
          '',
        120
      ),
      value,
      visible: visibilityFor(element).visible,
      rect: {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
      },
    }
  }

  function valueFor(element) {
    if (!element || !element.isConnected) return undefined
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if ((element.getAttribute('type') || '').toLowerCase() === 'password') return '[redacted]'
      return String(element.value || '')
    }
    if (element instanceof HTMLSelectElement) {
      return Array.from(element.selectedOptions || [])
        .map(option => option.value)
        .join(',')
    }
    if (element.isContentEditable) return element.innerText || element.textContent || ''
    return undefined
  }

  function safeRegex(pattern) {
    try {
      return new RegExp(String(pattern))
    } catch {
      warnings.push({
        code: 'regex_invalid',
        message: `Invalid wait regex: ${String(pattern)}`,
      })
      return /a^/
    }
  }

  function safeEvaluateExpression(expression) {
    try {
      return Function(`"use strict"; return (${String(expression)});`)()
    } catch {
      return false
    }
  }

  function quietMsFor(value, fallback) {
    if (typeof value === 'number') return clampNumber(value, 0, 5000, fallback)
    if (value && typeof value === 'object') return clampNumber(value.quietMs, 0, 5000, fallback)
    return fallback
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, number))
  }

  function trimText(value, maxChars) {
    const text = String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
    return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`
  }

  function round(value) {
    return Math.round(Number(value || 0) * 100) / 100
  }

  function elapsed(start) {
    return Math.round(performance.now() - start)
  }
})()
