;(() => {
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

    const preflight = inspectPreflight(target.element, action)
    warnings.push(...preflight.warnings)
    if (!preflight.ok) return failure(action, preflight, startedAt, warnings, target, before)

    const risk = classifyActionRisk(action, target.element, input.text || '', preflight.summary)
    if (risk.risk === 'high' && !input.options?.riskApproved) {
      return approvalRequired(action, risk, startedAt, warnings, target, before, preflight)
    }

    const execution = executeAction(action, target.element, input.text || '')
    warnings.push(...execution.warnings)
    if (!execution.ok) return failure(action, execution, startedAt, warnings, target, before)

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
    const index = Number(request.index)
    const hasIndex =
      request.index !== null && request.index !== undefined && Number.isInteger(index) && index >= 0
    if (request.ref || hasIndex) {
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
        index: hasIndex ? index : undefined,
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

    if (action === 'press') {
      return {
        ok: true,
        element: document.activeElement || document.body || document.documentElement,
        summary: { source: 'activeElement' },
      }
    }

    if (action === 'scroll') {
      return {
        ok: true,
        element: scrollOriginElement(request),
        summary: { source: 'smartScroll' },
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
    if (['click', 'type', 'fill'].includes(actionName) && inputType(element) === 'file') {
      return errorResult(
        'unsupported_file_input',
        'File input requires the user to choose local files.',
        'user_control'
      )
    }
    if ((actionName === 'type' || actionName === 'fill') && !isEditable(element)) {
      return errorResult('element_not_editable', 'Target element is not editable.', 'inspect')
    }
    if (actionName === 'click' && !isClickActionable(element)) {
      preflightWarnings.push(
        warning('actionability_heuristic', 'Click target actionability is heuristic.')
      )
    }
    if (actionName === 'select' && !(element instanceof HTMLSelectElement)) {
      return errorResult(
        'unsupported_select_target',
        'Select action requires a native select element.',
        'inspect'
      )
    }
    if (actionName === 'setChecked' && !isCheckable(element)) {
      return errorResult(
        'unsupported_select_target',
        'setChecked action requires a checkbox or radio input.',
        'inspect'
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

    if (actionName === 'hover') {
      element.focus?.({ preventScroll: true })
      const rect = rectFor(element)
      const clientX = rect.x + rect.width / 2
      const clientY = rect.y + rect.height / 2
      for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
        element.dispatchEvent(
          new MouseEvent(type, {
            bubbles: !['pointerenter', 'mouseenter'].includes(type),
            cancelable: true,
            clientX,
            clientY,
          })
        )
      }
      return {
        ok: true,
        warnings: [
          warning('synthetic_hover', 'Hover was dispatched with DOM synthetic events.'),
          warning('css_hover_not_guaranteed', 'CSS :hover state may require trusted input.'),
        ],
      }
    }

    if (actionName === 'focus') {
      element.focus?.({ preventScroll: true })
      if (document.activeElement !== element && !element.contains(document.activeElement)) {
        return {
          ok: false,
          error: errorObject('focus_rejected', 'Page did not keep focus on the target.', 'inspect'),
          warnings: [],
        }
      }
      return { ok: true, warnings: [] }
    }

    if (actionName === 'press') {
      return pressKey(element, input.key || text)
    }

    if (actionName === 'select') {
      return selectOption(element, input.options || {}, text)
    }

    if (actionName === 'setChecked') {
      return setChecked(element, input.options || {})
    }

    if (actionName === 'scrollIntoView') {
      const before = scrollStateFor(nearestScrollContainer(element))
      element.scrollIntoView?.({ block: 'center', inline: 'nearest' })
      const container = nearestScrollContainer(element)
      const after = scrollStateFor(container)
      return {
        ok: true,
        warnings: scrollWarnings(container, before, after),
      }
    }

    if (actionName === 'scroll') {
      return scrollSmart(element, input.options || {})
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

  function pressKey(element, keyText) {
    const key = normalizeKey(keyText)
    if (!key) {
      return {
        ok: false,
        error: errorObject('unsupported_key', 'Press action requires a key.', 'inspect'),
        warnings: [],
      }
    }
    const target = element || document.activeElement || document.body
    target.focus?.({ preventScroll: true })
    const eventInit = keyboardEventInit(key)
    target.dispatchEvent(new KeyboardEvent('keydown', eventInit))
    if (key.length === 1) {
      target.dispatchEvent(new KeyboardEvent('keypress', eventInit))
    }
    target.dispatchEvent(new KeyboardEvent('keyup', eventInit))
    return {
      ok: true,
      warnings: [
        warning('synthetic_keyboard_event', 'Key press was dispatched with DOM synthetic events.'),
        ...(eventInit.key === 'Tab'
          ? [warning('tab_focus_not_guaranteed', 'Synthetic Tab may not move browser focus.')]
          : []),
        ...(eventInit.metaKey || eventInit.ctrlKey || eventInit.altKey
          ? [warning('shortcut_may_be_ignored', 'Page or browser may ignore synthetic shortcut.')]
          : []),
      ],
    }
  }

  function selectOption(element, options, fallbackText) {
    const rawValues = Array.isArray(options.values)
      ? options.values
      : options.value !== undefined
        ? [options.value]
        : fallbackText
          ? [fallbackText]
          : []
    const by = options.by || 'value'
    const values = rawValues.map(value => String(value))
    if (values.length === 0) {
      return {
        ok: false,
        error: errorObject(
          'option_not_found',
          'Select action requires at least one value.',
          'inspect'
        ),
        warnings: [],
      }
    }
    const matched = []
    for (const option of Array.from(element.options || [])) {
      const candidate =
        by === 'label'
          ? normalizeWhitespace(option.label || option.textContent)
          : by === 'index'
            ? String(option.index)
            : String(option.value)
      const selected = values.includes(candidate)
      option.selected = element.multiple ? selected : selected && matched.length === 0
      if (selected) matched.push(candidate)
    }
    if (matched.length === 0) {
      return {
        ok: false,
        error: errorObject(
          'option_not_found',
          'No select option matched the requested value.',
          'inspect'
        ),
        warnings: [],
      }
    }
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return {
      ok: true,
      warnings: [warning('synthetic_event', 'Select was changed with DOM synthetic events.')],
    }
  }

  function setChecked(element, options) {
    const desired = options.checked !== undefined ? Boolean(options.checked) : true
    if (element.checked !== desired) {
      element.focus?.({ preventScroll: true })
      element.click()
    }
    if (element.checked !== desired) {
      return {
        ok: false,
        error: errorObject(
          'value_rejected',
          'Checked state did not change as requested.',
          'inspect'
        ),
        warnings: [],
      }
    }
    return {
      ok: true,
      warnings: [
        warning('synthetic_event', 'Checked state was changed with DOM synthetic events.'),
      ],
    }
  }

  function scrollSmart(element, options) {
    const direction = String(options.direction || 'down')
    const amount = Math.max(1, Number(options.amount || 600))
    const axis = direction === 'left' || direction === 'right' ? 'x' : 'y'
    const sign = direction === 'up' || direction === 'left' ? -1 : 1
    const container = nearestScrollContainer(element, axis) || document.scrollingElement
    if (!container) {
      return {
        ok: false,
        error: errorObject(
          'scroll_container_not_found',
          'No scrollable container is available.',
          'inspect'
        ),
        warnings: [],
      }
    }
    const before = scrollStateFor(container)
    if (axis === 'x') container.scrollLeft += sign * amount
    else container.scrollTop += sign * amount
    const after = scrollStateFor(container)
    const scrolled = before.left !== after.left || before.top !== after.top
    if (!scrolled) {
      return {
        ok: false,
        error: errorObject('scroll_not_possible', 'Scroll position did not change.', 'inspect'),
        warnings: scrollWarnings(container, before, after),
      }
    }
    return {
      ok: true,
      warnings: scrollWarnings(container, before, after),
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

  function observePage(element) {
    const active = document.activeElement
    return {
      url: location.href,
      title: document.title || '',
      readyState: document.readyState,
      documentToken: documentTokenFor(document),
      domRevision: Number(agent.domRevision || 0),
      viewportRevision: Number(agent.viewportRevision || 0),
      bodyTextHash: hashText(document.body?.innerText || ''),
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
      domChanged:
        before.domRevision !== after.domRevision || before.bodyTextHash !== after.bodyTextHash,
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

  function approvalRequired(actionName, risk, start, actionWarnings, target, before, preflight) {
    const targetSummary = {
      ...(target?.summary || {}),
      ...(preflight?.summary || {}),
    }
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
      approval: {
        risk: risk.risk,
        actionKind: actionName,
        reason: risk.reason,
        target: {
          role: targetSummary.role,
          name: targetSummary.name,
          index: targetSummary.index,
          ref: targetSummary.ref,
        },
      },
      error: errorObject('approval_required', risk.reason, 'ask_user_to_confirm'),
    }
  }

  function classifyActionRisk(actionName, element, text, summary) {
    if (input.options?.riskApproved) return { risk: 'low' }
    const role = inferRole(element)
    const name = accessibleName(element, role)
    const combined = [
      actionName,
      role,
      name,
      element.getAttribute?.('type'),
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.getAttribute?.('href'),
      element.closest?.('form')?.getAttribute('action'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    if ((actionName === 'type' || actionName === 'fill') && isSensitiveInput(element, text)) {
      return {
        risk: 'high',
        reason: 'AI is about to enter sensitive credentials or verification text.',
      }
    }
    if (
      actionName === 'click' &&
      /(delete|remove|destroy|authorize|auth|pay|payment|purchase|checkout|order|transfer|删除|移除|授权|支付|购买|下单|转账)/i.test(
        combined
      )
    ) {
      return {
        risk: 'high',
        reason: `AI wants to click "${trimText(summary?.name || name || role, 80)}".`,
      }
    }
    if (
      actionName === 'click' &&
      /(submit|send|post|confirm|提交|发送|发布|确认)/i.test(combined) &&
      !isSearchLikeSubmission(element, combined)
    ) {
      return {
        risk: 'high',
        reason: `AI wants to click "${trimText(summary?.name || name || role, 80)}".`,
      }
    }
    if (
      ['fill', 'type', 'select', 'setChecked'].includes(actionName) &&
      /(password|otp|totp|verification|verify|code|secret|token|密码|验证码|口令|密钥)/i.test(
        combined
      )
    ) {
      return {
        risk: 'high',
        reason: 'AI is about to change a sensitive form field.',
      }
    }
    return { risk: 'low' }
  }

  function isSearchLikeSubmission(element, combined) {
    const form = element.closest?.('form')
    const formText = [
      form?.getAttribute('role'),
      form?.getAttribute('aria-label'),
      form?.getAttribute('action'),
      form?.getAttribute('name'),
      form?.id,
      form?.className,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    const hasSearchField = Boolean(
      form?.querySelector?.(
        'input[type="search"], input[name="q"], input[name="wd"], input[name="query"], input[name="keyword"], input[id="kw"], textarea[name="q"]'
      )
    )
    const labelLooksLikeSearch = /(search|query|百度一下|搜索|搜一下|检索)/i.test(
      `${combined} ${formText}`
    )
    return hasSearchField || labelLooksLikeSearch
  }

  function isSensitiveInput(element, text) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      return false
    }
    const type = inputType(element)
    const descriptor = [
      type,
      element.name,
      element.id,
      element.autocomplete,
      element.placeholder,
      element.getAttribute('aria-label'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (type === 'password') return true
    if (/(otp|totp|verification|verify|code|secret|token|验证码|口令|密钥)/i.test(descriptor)) {
      return true
    }
    return /^\d{4,8}$/.test(String(text || '').trim()) && /code|验证码|otp|totp/i.test(descriptor)
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
      category: errorCategory(code),
      suggestedNextAction: suggestedNextAction || 'inspect',
    }
  }

  function errorCategory(code) {
    if (
      [
        'element_not_found',
        'ambiguous_target',
        'target_stale',
        'stale_ref',
        'stale_inspect',
        'selector_invalid',
      ].includes(code)
    ) {
      return 'target'
    }
    if (
      [
        'element_not_visible',
        'element_occluded',
        'surface_occluded',
        'coordinate_out_of_viewport',
      ].includes(code)
    ) {
      return 'visibility'
    }
    if (
      [
        'element_not_editable',
        'value_rejected',
        'unsupported_file_input',
        'unsupported_select_target',
        'option_not_found',
        'unsupported_key',
      ].includes(code)
    ) {
      return 'input'
    }
    if (['requires_trusted_input', 'unsupported_browser_capability'].includes(code)) {
      return 'capability'
    }
    if (['approval_required', 'approval_rejected', 'approval_expired'].includes(code)) {
      return 'approval'
    }
    if (['operation_timed_out', 'wait_timeout'].includes(code)) return 'timeout'
    return 'unknown'
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

  function scrollOriginElement(request) {
    if (Number.isFinite(Number(request.x)) && Number.isFinite(Number(request.y))) {
      return document.elementFromPoint(Number(request.x), Number(request.y)) || document.body
    }
    return document.activeElement || document.body || document.documentElement
  }

  function nearestScrollContainer(element, axis = 'y') {
    let current = element
    while (current && current !== document.documentElement) {
      if (isScrollable(current, axis)) return current
      current = current.parentElement || current.getRootNode?.().host
    }
    return document.scrollingElement || document.documentElement
  }

  function isScrollable(element, axis) {
    if (!element || element === document.body || element === document.documentElement) return false
    const style = getComputedStyle(element)
    const overflow = axis === 'x' ? style.overflowX : style.overflowY
    const canOverflow = /(auto|scroll|overlay)/.test(overflow)
    const hasRoom =
      axis === 'x'
        ? element.scrollWidth > element.clientWidth + 1
        : element.scrollHeight > element.clientHeight + 1
    return canOverflow && hasRoom
  }

  function scrollStateFor(element) {
    return {
      tagName: element?.tagName?.toLowerCase() || 'document',
      id: element?.id || undefined,
      top: round(element?.scrollTop || 0),
      left: round(element?.scrollLeft || 0),
      height: round(element?.clientHeight || window.innerHeight),
      width: round(element?.clientWidth || window.innerWidth),
      scrollHeight: round(element?.scrollHeight || document.documentElement.scrollHeight),
      scrollWidth: round(element?.scrollWidth || document.documentElement.scrollWidth),
    }
  }

  function scrollWarnings(container, before, after) {
    const result = []
    if (container === document.scrollingElement || container === document.documentElement) {
      result.push(warning('body_scroll_fallback', 'Scroll used the document scrolling element.'))
    } else {
      result.push(warning('nested_scroll_container_selected', 'Scroll used a nested container.'))
    }
    if (
      (before.top === after.top && before.left === after.left) ||
      after.top <= 0 ||
      after.left <= 0 ||
      after.top + after.height >= after.scrollHeight ||
      after.left + after.width >= after.scrollWidth
    ) {
      result.push(warning('scroll_delta_clamped', 'Scroll delta was clamped by container bounds.'))
    }
    if (looksVirtualized(container)) {
      result.push(
        warning(
          'virtualized_list_may_rerender',
          'Scrollable container may rerender visible items; inspect again before acting.'
        )
      )
    }
    return result
  }

  function looksVirtualized(element) {
    if (!element) return false
    const marker = `${element.id || ''} ${element.className || ''}`.toLowerCase()
    if (/virtual|infinite|react-window|virtualized/.test(marker)) return true
    if (element.getAttribute?.('aria-rowcount')) return true
    const children = Array.from(element.children || [])
    return (
      element.scrollHeight > element.clientHeight * 4 &&
      children.length > 0 &&
      children.length < 40 &&
      children.some(child => /translate(?:3d|y)?\(/i.test(getComputedStyle(child).transform || ''))
    )
  }

  function isCheckable(element) {
    return (
      element instanceof HTMLInputElement &&
      ['checkbox', 'radio'].includes((element.getAttribute('type') || '').toLowerCase())
    )
  }

  function normalizeKey(value) {
    return String(value || '').trim()
  }

  function keyboardEventInit(keyText) {
    const parts = keyText.split('+').filter(Boolean)
    const key = parts.pop() || keyText
    return {
      key: normalizedKeyName(key),
      bubbles: true,
      cancelable: true,
      composed: true,
      metaKey: parts.includes('Meta') || parts.includes('Cmd') || parts.includes('Command'),
      ctrlKey: parts.includes('Control') || parts.includes('Ctrl'),
      shiftKey: parts.includes('Shift'),
      altKey: parts.includes('Alt') || parts.includes('Option'),
    }
  }

  function normalizedKeyName(key) {
    const aliases = {
      Space: ' ',
      Esc: 'Escape',
      Return: 'Enter',
      Del: 'Delete',
      Cmd: 'Meta',
    }
    return aliases[key] || key
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
    if (['textbox', 'checkbox', 'radio', 'combobox'].includes(role)) {
      const id = element.id
      if (id) {
        const label = document.querySelector(`label[for="${cssEscape(id)}"]`)
        if (label && normalizeWhitespace(label.innerText || label.textContent)) {
          return normalizeWhitespace(label.innerText || label.textContent)
        }
      }
      const wrappingLabel = element.closest?.('label')
      if (
        wrappingLabel &&
        normalizeWhitespace(wrappingLabel.innerText || wrappingLabel.textContent)
      ) {
        return normalizeWhitespace(wrappingLabel.innerText || wrappingLabel.textContent)
      }
    }
    return normalizeWhitespace(element.innerText || element.textContent || '')
  }

  function valueFor(element) {
    if (!element || !element.isConnected) return undefined
    if (element instanceof HTMLSelectElement) {
      return Array.from(element.selectedOptions || [])
        .map(option => option.value)
        .join(',')
    }
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

  function hashText(value) {
    const text = String(value || '')
    let hash = 0
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) | 0
    }
    return String(hash >>> 0)
  }
})()
