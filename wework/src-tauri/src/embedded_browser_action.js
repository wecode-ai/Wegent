;(async () => {
  const input = __WEWORK_ACTION_INPUT__
  const startedAt = performance.now()
  const warnings = []
  const agent = ensureAgentRuntime()
  const action = input.action

  try {
    const target = resolveTarget(input)
    if (!target.ok) return failure(action, target, startedAt, warnings)

    const before = observePage(target.element)
    target.element.scrollIntoView?.({ block: 'center', inline: 'center' })
    await nextFrame()

    const preflight = inspectPreflight(target.element, action)
    warnings.push(...preflight.warnings)
    if (!preflight.ok) return failure(action, preflight, startedAt, warnings, target, before)

    const execution = executeAction(action, target.element, input.text || '')
    warnings.push(...execution.warnings)
    if (!execution.ok) return failure(action, execution, startedAt, warnings, target, before)

    await settleAfterAction(agent, before)
    const after = observePage(target.element)
    const effect = effectFor(before, after)
    if (!hasObservableEffect(effect)) {
      warnings.push(
        warning('no_observable_effect', `${action} was dispatched but no page change was observed.`)
      )
    }

    return {
      ok: true,
      action,
      backend: 'wkwebview-js',
      executionKind: 'synthetic-event',
      synthetic: true,
      target: {
        ...target.summary,
        ...preflight.summary,
      },
      before,
      after,
      effect,
      elapsedMs: elapsed(startedAt),
      warnings,
    }
  } catch (error) {
    return {
      ok: false,
      action,
      backend: 'wkwebview-js',
      executionKind: 'synthetic-event',
      synthetic: true,
      target: {},
      before: observePage(null),
      after: observePage(null),
      effect: emptyEffect(),
      elapsedMs: elapsed(startedAt),
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

  function resolveTarget(request) {
    if (request.ref || (request.inspectId && Number.isFinite(Number(request.index)))) {
      const resolver = window.__WEWORK_BROWSER_AGENT__?.resolveInspectElement
      if (typeof resolver !== 'function') {
        return errorResult(
          'stale_inspect',
          'No inspect registry is available. Run browser_inspect again.',
          'inspect'
        )
      }
      const resolved = resolver({
        ref: request.ref || undefined,
        inspectId: request.inspectId || undefined,
        index: request.index,
      })
      if (!resolved.ok) {
        return errorResult(
          resolved.errorCode || 'element_not_found',
          resolved.message || 'Inspect target could not be resolved.',
          'inspect'
        )
      }
      return {
        ok: true,
        element: resolved.element,
        summary: {
          ref: resolved.ref,
          inspectId: resolved.inspectId,
          index: resolved.index,
          frameId: resolved.frameId,
          role: resolved.role,
          name: resolved.name,
          rect: resolved.rect,
        },
      }
    }

    if (request.selector) {
      const selector = String(request.selector).replace(/^css=/, '')
      let matches
      try {
        matches = Array.from(document.querySelectorAll(selector))
      } catch {
        return errorResult('selector_invalid', `Invalid selector: ${selector}`, 'inspect')
      }
      if (matches.length === 0) {
        return errorResult(
          'element_not_found',
          `No element matched selector: ${selector}`,
          'inspect'
        )
      }
      if (matches.length > 1) {
        warnings.push(
          warning('ambiguous_selector', `Selector matched ${matches.length} elements; using first.`)
        )
      }
      return {
        ok: true,
        element: matches[0],
        summary: { selector },
      }
    }

    if (Number.isFinite(Number(request.x)) && Number.isFinite(Number(request.y))) {
      const x = Number(request.x)
      const y = Number(request.y)
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        return errorResult(
          'coordinate_out_of_viewport',
          `Coordinates (${x}, ${y}) are outside the viewport.`,
          'inspect'
        )
      }
      const hit = document.elementFromPoint(x, y)
      const element = closestActionable(hit)
      if (!element) {
        return errorResult(
          'element_not_actionable',
          'No actionable element was found at the requested coordinates.',
          'inspect'
        )
      }
      warnings.push(
        warning('coordinate_without_screenshot', 'Coordinate click has no screenshot id.')
      )
      return {
        ok: true,
        element,
        summary: { x, y },
      }
    }

    if ((action === 'type' || action === 'fill') && isEditable(document.activeElement)) {
      return {
        ok: true,
        element: document.activeElement,
        summary: { source: 'activeElement' },
      }
    }

    return errorResult(
      'element_not_found',
      'No target was provided and no editable element is focused.',
      'inspect'
    )
  }

  function inspectPreflight(element, actionName) {
    if (!element || !element.isConnected) {
      return errorResult('stale_ref', 'Target element is detached.', 'inspect')
    }
    const summary = summarizeElement(element)
    const rect = rectFor(element)
    const visibility = visibilityFor(element, rect)
    const states = statesFor(element)
    const preflightWarnings = []

    if (!visibility.visible) {
      return errorResult('element_not_visible', 'Target element is not visible.', 'inspect')
    }
    if (!visibility.inViewport) {
      return errorResult(
        'element_not_visible',
        'Target element is outside the viewport.',
        'scroll_then_inspect'
      )
    }
    if (visibility.occluded) {
      return errorResult(
        'element_occluded',
        'Target element is covered by another element.',
        'inspect'
      )
    }
    if (states.includes('disabled') || states.includes('aria-disabled')) {
      return errorResult('element_not_actionable', 'Target element is disabled.', 'inspect')
    }
    if ((actionName === 'type' || actionName === 'fill') && !isEditable(element)) {
      return errorResult('element_not_editable', 'Target element is not editable.', 'inspect')
    }
    if ((actionName === 'type' || actionName === 'fill') && inputType(element) === 'file') {
      return errorResult(
        'unsupported_file_input',
        'File input cannot be filled with text.',
        'user_control'
      )
    }
    if (actionName === 'click' && !isClickActionable(element)) {
      preflightWarnings.push(
        warning('actionability_heuristic', 'Click target actionability is heuristic.')
      )
    }

    return {
      ok: true,
      summary: {
        ...summary,
        rect,
        visible: visibility.visible,
        inViewport: visibility.inViewport,
        actionable: true,
        states,
      },
      warnings: preflightWarnings,
    }
  }

  function executeAction(actionName, element, text) {
    if (actionName === 'click') {
      element.focus?.({ preventScroll: true })
      const rect = rectFor(element)
      const clientX = rect.x + rect.width / 2
      const clientY = rect.y + rect.height / 2
      for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup']) {
        element.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
          })
        )
      }
      element.click()
      return {
        ok: true,
        warnings: [
          warning('synthetic_event', 'Click was dispatched with DOM synthetic events.'),
          warning(
            'trusted_input_not_available',
            'WKWebView trusted input is not available in MVP.'
          ),
        ],
      }
    }

    const fill = actionName === 'fill'
    const written = writeText(element, text, fill)
    return {
      ok: written.ok,
      error: written.error,
      warnings: [
        warning('synthetic_event', `${actionName} was dispatched with DOM synthetic events.`),
        ...written.warnings,
      ],
    }
  }

  function writeText(element, text, replace) {
    if (inputType(element) === 'file') {
      return {
        ok: false,
        error: errorObject(
          'unsupported_file_input',
          'File input cannot be filled with text.',
          'user_control'
        ),
        warnings: [],
      }
    }
    element.focus()
    if (isValueElement(element)) {
      const oldValue = String(element.value || '')
      const nextValue = replace ? String(text) : `${oldValue}${text}`
      setNativeValue(element, nextValue)
      element.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: replace ? 'insertReplacementText' : 'insertText',
          data: String(text),
        })
      )
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: replace ? 'insertReplacementText' : 'insertText',
          data: String(text),
        })
      )
      element.dispatchEvent(new Event('change', { bubbles: true }))
      const actualValue = String(element.value || '')
      if (actualValue === oldValue && nextValue !== oldValue) {
        return {
          ok: false,
          error: errorObject('value_rejected', 'Element value did not change.', 'inspect'),
          warnings: [],
        }
      }
      const actionWarnings =
        actualValue !== nextValue
          ? [warning('value_formatted', 'Element value was changed by page logic after input.')]
          : []
      return { ok: true, warnings: actionWarnings }
    }

    if (element.isContentEditable) {
      if (replace) element.textContent = ''
      const ok = document.execCommand?.('insertText', false, String(text))
      if (!ok) {
        element.textContent = replace ? String(text) : `${element.textContent || ''}${text}`
      }
      element.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(text) })
      )
      return {
        ok: true,
        warnings: [
          warning(
            'contenteditable_synthetic_input',
            'contenteditable input used synthetic DOM insertion.'
          ),
        ],
      }
    }

    return {
      ok: false,
      error: errorObject('element_not_editable', 'Target element is not editable.', 'inspect'),
      warnings: [],
    }
  }

  function setNativeValue(element, value) {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter) setter.call(element, value)
    else element.value = value
  }

  async function settleAfterAction(current, before) {
    await Promise.resolve()
    await sleep(200)
    const deadline = performance.now() + 800
    while (performance.now() < deadline) {
      const domStable = performance.now() - Number(current.lastDomMutationAt || 0) >= 200
      const viewportStable = performance.now() - Number(current.lastViewportMutationAt || 0) >= 100
      if (domStable && viewportStable) break
      await sleep(100)
    }
    if (before.url !== location.href) {
      await sleep(100)
    }
  }

  function observePage(element) {
    const active = document.activeElement
    return {
      url: location.href,
      title: document.title || '',
      readyState: document.readyState,
      documentToken: documentTokenFor(document),
      domRevision: Number(agent.domRevision || 0),
      viewportRevision: Number(agent.viewportRevision || 0),
      focused: active ? summarizeElement(active) : undefined,
      targetValue: element && element.isConnected ? valueFor(element) : undefined,
      targetChecked:
        element && element.isConnected && 'checked' in element
          ? Boolean(element.checked)
          : undefined,
      targetSelectedText:
        element && element.isConnected && 'selectionStart' in element && 'selectionEnd' in element
          ? String(element.value || '').slice(
              element.selectionStart || 0,
              element.selectionEnd || 0
            )
          : undefined,
      targetStillConnected: Boolean(element?.isConnected),
      targetRect: element && element.isConnected ? rectFor(element) : undefined,
      dialogCount: visibleDialogs().length,
    }
  }

  function effectFor(before, after) {
    return {
      urlChanged: before.url !== after.url,
      titleChanged: before.title !== after.title,
      domChanged: before.domRevision !== after.domRevision,
      focusChanged:
        JSON.stringify(before.focused || null) !== JSON.stringify(after.focused || null),
      valueChanged: before.targetValue !== after.targetValue,
      checkedChanged: before.targetChecked !== after.targetChecked,
      selectedChanged: before.targetSelectedText !== after.targetSelectedText,
      targetDetached: before.targetStillConnected && !after.targetStillConnected,
      navigationLikely:
        before.url !== after.url ||
        before.documentToken !== after.documentToken ||
        (!after.targetStillConnected && (before.url !== after.url || before.title !== after.title)),
      dialogLikely: after.dialogCount > before.dialogCount,
    }
  }

  function hasObservableEffect(effect) {
    return Object.values(effect).some(Boolean)
  }

  function emptyEffect() {
    return {
      urlChanged: false,
      titleChanged: false,
      domChanged: false,
      focusChanged: false,
      targetDetached: false,
      navigationLikely: false,
      dialogLikely: false,
    }
  }

  function failure(actionName, result, start, actionWarnings, target, before) {
    const targetSummary = target?.summary || {}
    const beforeObservation = before || observePage(target?.element || null)
    return {
      ok: false,
      action: actionName,
      backend: 'wkwebview-js',
      executionKind: 'synthetic-event',
      synthetic: true,
      target: targetSummary,
      before: beforeObservation,
      after: observePage(target?.element || null),
      effect: emptyEffect(),
      elapsedMs: elapsed(start),
      warnings: actionWarnings,
      error:
        result.error || errorObject(result.errorCode, result.message, result.suggestedNextAction),
    }
  }

  function errorResult(code, message, suggestedNextAction) {
    return {
      ok: false,
      errorCode: code,
      message,
      suggestedNextAction,
      error: errorObject(code, message, suggestedNextAction),
    }
  }

  function errorObject(code, message, suggestedNextAction) {
    return {
      code,
      message,
      recoverable: !['unsupported_file_input', 'requires_trusted_input'].includes(code),
      suggestedNextAction: suggestedNextAction || 'inspect',
    }
  }

  function isEditable(element) {
    if (!element) return false
    if (element.isContentEditable) return true
    if (!isValueElement(element)) return false
    if (element.disabled || element.readOnly) return false
    return !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'reset', 'submit'].includes(
      inputType(element)
    )
  }

  function isValueElement(element) {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
  }

  function isClickActionable(element) {
    const role = inferRole(element)
    if (['button', 'link', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab'].includes(role)) {
      return true
    }
    const style = getComputedStyle(element)
    return Boolean(element.onclick || element.tabIndex >= 0 || style.cursor === 'pointer')
  }

  function closestActionable(element) {
    let current = element
    while (current && current !== document.documentElement) {
      if (isClickActionable(current) || isEditable(current)) return current
      current = current.parentElement
    }
    return null
  }

  function visibilityFor(element, rect) {
    const style = getComputedStyle(element)
    const hasBox = rect.width > 0 && rect.height > 0
    const visible =
      hasBox &&
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
    const hit = elementFromRect(rect)
    const occluded = visible && inViewport && hit && !(hit === element || element.contains(hit))
    return { visible, inViewport, occluded }
  }

  function elementFromRect(rect) {
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.x + rect.width / 2))
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.y + rect.height / 2))
    return document.elementFromPoint(x, y)
  }

  function rectFor(element) {
    const rect = element.getBoundingClientRect()
    return {
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
    }
  }

  function summarizeElement(element) {
    if (!element) return undefined
    const role = inferRole(element)
    return {
      role,
      name: trimText(accessibleName(element, role), 120),
      tagName: element.tagName?.toLowerCase() || '',
      inputType: element instanceof HTMLInputElement ? inputType(element) : undefined,
    }
  }

  function statesFor(element) {
    const states = []
    if (element.disabled || element.closest?.('fieldset[disabled]')) states.push('disabled')
    if (element.readOnly) states.push('readonly')
    if (element.getAttribute?.('aria-disabled') === 'true') states.push('aria-disabled')
    if (element.checked) states.push('checked')
    if (element.selected) states.push('selected')
    if (document.activeElement === element) states.push('focused')
    return states
  }

  function inferRole(element) {
    const explicit = element.getAttribute?.('role')
    if (explicit) return explicit.trim().split(/\s+/)[0]
    const tag = element.tagName?.toLowerCase()
    const type = inputType(element)
    if (tag === 'a' && element.hasAttribute('href')) return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      return 'textbox'
    }
    if (element.isContentEditable) return 'textbox'
    if (element.onclick || element.tabIndex >= 0) return 'button'
    return 'generic'
  }

  function accessibleName(element, role) {
    for (const attr of ['aria-label', 'alt', 'title', 'placeholder']) {
      const value = element.getAttribute?.(attr)
      if (normalizeWhitespace(value)) return normalizeWhitespace(value)
    }
    if (role === 'textbox') {
      const id = element.id
      if (id) {
        const label = document.querySelector(`label[for="${cssEscape(id)}"]`)
        if (label && normalizeWhitespace(label.innerText || label.textContent)) {
          return normalizeWhitespace(label.innerText || label.textContent)
        }
      }
    }
    return normalizeWhitespace(element.innerText || element.textContent || '')
  }

  function valueFor(element) {
    if (!element || !element.isConnected) return undefined
    if (isValueElement(element)) {
      if (inputType(element) === 'password') return '[redacted]'
      return trimText(String(element.value || ''), 120)
    }
    if (element.isContentEditable)
      return trimText(element.innerText || element.textContent || '', 120)
    return undefined
  }

  function visibleDialogs() {
    return Array.from(
      document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]')
    ).filter(element => {
      const rect = rectFor(element)
      return visibilityFor(element, rect).visible
    })
  }

  function documentTokenFor(doc) {
    if (doc.__weworkDocumentToken) return doc.__weworkDocumentToken
    const token = `doc-${Date.now()}-${Math.random().toString(16).slice(2)}`
    try {
      Object.defineProperty(doc, '__weworkDocumentToken', { value: token, configurable: true })
    } catch {
      doc.__weworkDocumentToken = token
    }
    return token
  }

  function inputType(element) {
    return element instanceof HTMLInputElement
      ? (element.getAttribute('type') || 'text').toLowerCase()
      : ''
  }

  function normalizeWhitespace(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function trimText(value, maxChars) {
    const text = normalizeWhitespace(value)
    if (text.length <= maxChars) return text
    return `${text.slice(0, Math.max(0, maxChars - 3))}...`
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value)
    return String(value).replace(/["\\]/g, '\\$&')
  }

  function round(value) {
    return Math.round(Number(value || 0) * 100) / 100
  }

  function warning(code, message) {
    return { code, message }
  }

  function elapsed(start) {
    return Math.round(performance.now() - start)
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()))
  }
})()
