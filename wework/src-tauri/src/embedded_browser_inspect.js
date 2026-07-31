;(() => {
  const rawOptions = __WEWORK_INSPECT_OPTIONS__
  const now = Date.now()
  const warnings = []
  const frames = []
  const nodes = []
  const defaults = {
    mode: 'compact',
    interactiveOnly: false,
    includeTextBlocks: true,
    includeHidden: false,
    maxNodes: 800,
    maxTextChars: 12000,
    maxNameChars: 120,
    maxValueChars: 120,
    viewportMargin: 600,
  }
  const options = { ...defaults, ...(rawOptions || {}) }
  options.maxNodes = clampNumber(options.maxNodes, 1, 2000, defaults.maxNodes)
  options.maxTextChars = clampNumber(options.maxTextChars, 0, 50000, defaults.maxTextChars)
  options.maxNameChars = clampNumber(options.maxNameChars, 20, 500, defaults.maxNameChars)
  options.maxValueChars = clampNumber(options.maxValueChars, 0, 500, defaults.maxValueChars)
  options.viewportMargin = clampNumber(options.viewportMargin, 0, 3000, defaults.viewportMargin)

  const agent = ensureAgent()
  cleanupRegistries(agent, now)
  const inspectId = `wk-inspect-${now}-${agent.inspectSequence++}`
  const documentToken = documentTokenFor(document)
  const registry = {
    inspectId,
    createdAt: now,
    pageUrl: location.href,
    documentToken,
    indexToRef: {},
    refs: {},
  }

  collectDocument(document, {
    frameId: 'main',
    parentFrameId: null,
    depth: 0,
    offsetX: 0,
    offsetY: 0,
    frameElement: null,
  })

  const sortedNodes = rankNodes(nodes).slice(0, options.maxNodes)
  const truncated = nodes.length > sortedNodes.length
  sortedNodes.forEach((node, index) => {
    node.index = index
    node.inspectId = inspectId
    if (node.actionable && node.element) {
      const fingerprint = fingerprintFor(node, node.element)
      node.ref = `wk-mvp:${inspectId}:${node.frameId}:${index}:${hashText(JSON.stringify(fingerprint))}`
      registry.indexToRef[index] = node.ref
      registry.refs[node.ref] = {
        ref: node.ref,
        index,
        frameId: node.frameId,
        element: node.element,
        fingerprint,
        actionable: true,
        role: node.role,
      }
    }
    delete node.element
    delete node.rank
  })

  agent.inspectRegistries.unshift(registry)
  agent.inspectRegistries = agent.inspectRegistries.slice(0, 3)
  agent.latestInspectId = inspectId

  if (truncated) {
    warnings.push(
      warning('inspect_truncated', `Inspect result was truncated to ${options.maxNodes} nodes.`)
    )
  }

  const textPreview = redactText(document.body?.innerText || '').slice(0, options.maxTextChars)
  const viewport = viewportInfo()
  if (viewport.visualViewport && viewport.visualViewport.scale !== 1) {
    warnings.push(
      warning(
        'visual_viewport_scaled',
        'visualViewport scale is not 1; coordinate precision is approximate.'
      )
    )
  }

  return {
    kind: 'browser.inspect',
    backend: 'wkwebview-js',
    bridgeTrust: 'page_world',
    schemaVersion: 1,
    inspectId,
    capturedAt: new Date(now).toISOString(),
    page: pageInfo(),
    viewport,
    frames,
    nodes: sortedNodes,
    textPreview,
    inspectText: buildInspectText(sortedNodes, viewport),
    stats: {
      nodeCount: sortedNodes.length,
      actionableNodeCount: sortedNodes.filter(node => node.actionable).length,
      frameCount: frames.length,
      registryRefCount: Object.keys(registry.refs).length,
      textPreviewChars: textPreview.length,
    },
    partial: warnings.length > 0,
    truncated,
    warnings,
  }

  function ensureAgent() {
    const current = window.__WEWORK_BROWSER_AGENT__ || {}
    current.inspectSequence = Number.isFinite(current.inspectSequence) ? current.inspectSequence : 1
    current.inspectRegistries = Array.isArray(current.inspectRegistries)
      ? current.inspectRegistries
      : []
    current.resolveInspectElement = resolveInspectElement
    current.resolveInspectTarget = resolveInspectTarget
    window.__WEWORK_BROWSER_AGENT__ = current
    if (!current.cleanupInstalled) {
      window.addEventListener('pagehide', () => {
        current.inspectRegistries = []
      })
      window.addEventListener('beforeunload', () => {
        current.inspectRegistries = []
      })
      current.cleanupInstalled = true
    }
    return current
  }

  function cleanupRegistries(current, timestamp) {
    current.inspectRegistries = (current.inspectRegistries || []).filter(registry => {
      return timestamp - Number(registry.createdAt || 0) <= 120000
    })
  }

  function collectDocument(doc, context) {
    frames.push({
      frameId: context.frameId,
      parentFrameId: context.parentFrameId,
      url: safeRead(() => doc.location.href, ''),
      title: safeRead(() => doc.title, ''),
      accessible: true,
    })
    const root = doc.body || doc.documentElement
    if (!root) return
    walkElement(root, doc, context)
  }

  function walkElement(element, doc, context) {
    if (nodes.length >= options.maxNodes * 2) return
    const node = inspectElement(element, doc, context)
    if (node && shouldIncludeNode(node)) {
      nodes.push(node)
    }

    if (element.shadowRoot) {
      for (const child of Array.from(element.shadowRoot.children)) {
        walkElement(child, doc, context)
      }
    }

    if (element.tagName?.toLowerCase() === 'iframe') {
      collectFrame(element, context)
    }

    if (options.includeTextBlocks && !isFormControl(element)) {
      collectDirectText(element, doc, context)
    }

    for (const child of Array.from(element.children || [])) {
      walkElement(child, doc, context)
    }
  }

  function collectFrame(iframe, context) {
    const rect = rectFor(iframe, context)
    const frameId = `frame-${frames.length}`
    try {
      const childDoc = iframe.contentDocument
      if (!childDoc) throw new Error('frame document unavailable')
      collectDocument(childDoc, {
        frameId,
        parentFrameId: context.frameId,
        depth: context.depth + 1,
        offsetX: rect.x,
        offsetY: rect.y,
        frameElement: iframe,
      })
    } catch (error) {
      frames.push({
        frameId,
        parentFrameId: context.frameId,
        url: safeRead(() => iframe.src, ''),
        title: safeRead(() => iframe.title, ''),
        accessible: false,
        reason: 'cross_origin_or_unavailable',
      })
      warnings.push(
        warning('cross_origin_frame_unavailable', 'An iframe could not be inspected.', { frameId })
      )
      nodes.push({
        rank: 60,
        index: -1,
        inspectId,
        frameId: context.frameId,
        role: 'iframe',
        name: trimText(
          iframe.title || iframe.getAttribute('aria-label') || iframe.src || 'iframe',
          options.maxNameChars
        ),
        tagName: 'iframe',
        states: [],
        rect,
        visible: true,
        inViewport: intersectsViewport(rect, 0),
        actionable: false,
        warnings: [warning('cross_origin_frame_unavailable', 'Frame contents are unavailable.')],
        element: iframe,
      })
    }
  }

  function inspectElement(element, doc, context) {
    const tagName = (element.tagName || '').toLowerCase()
    if (!tagName || tagName === 'script' || tagName === 'style' || tagName === 'template') {
      return null
    }
    const role = inferRole(element)
    const states = statesFor(element)
    const name = accessibleName(element, role)
    const rect = rectFor(element, context)
    const visibility = visibilityFor(element, rect, doc, context)
    const href = hrefFor(element)
    const value = valueFor(element)
    const inputType =
      tagName === 'input' ? (element.getAttribute('type') || 'text').toLowerCase() : undefined
    const upload = uploadInfoFor(element, inputType)
    const actionableRole = isActionableRole(role, element)
    const disabled = states.includes('disabled')
    const readonly = states.includes('readonly')
    const nodeWarnings = [...visibility.warnings]
    if (upload) {
      nodeWarnings.push(
        warning(
          'file_upload_requires_user_selection',
          'File upload controls require the user to choose local files.'
        )
      )
    }
    const actionable =
      actionableRole &&
      !upload &&
      visibility.visible &&
      visibility.inViewport &&
      visibility.receivesPointerEvents &&
      !visibility.occluded &&
      !disabled &&
      !(readonly && ['textbox', 'combobox'].includes(role))

    return {
      rank: rankFor(role, visibility, actionable, doc.activeElement === element),
      index: -1,
      inspectId,
      frameId: context.frameId,
      role,
      name: trimText(name, options.maxNameChars),
      text: textFor(element, role),
      value,
      placeholder:
        trimText(element.getAttribute?.('placeholder') || '', options.maxNameChars) || undefined,
      href,
      tagName,
      inputType,
      upload,
      states,
      rect,
      visible: visibility.visible,
      inViewport: visibility.inViewport,
      actionable,
      visibility,
      warnings: nodeWarnings,
      element,
    }
  }

  function collectDirectText(element, doc, context) {
    if (nodes.length >= options.maxNodes * 2) return
    if (['button', 'a', 'label', 'option'].includes(element.tagName?.toLowerCase())) return
    const text = Array.from(element.childNodes || [])
      .filter(child => child.nodeType === Node.TEXT_NODE)
      .map(child => normalizeWhitespace(child.textContent || ''))
      .filter(Boolean)
      .join(' ')
    if (text.length < 2) return
    const rect = rectFor(element, context)
    const visibility = visibilityFor(element, rect, doc, context)
    if (!visibility.visible || !visibility.inViewport) return
    nodes.push({
      rank: 90,
      index: -1,
      inspectId,
      frameId: context.frameId,
      role: 'text',
      name: trimText(text, options.maxNameChars),
      text: trimText(text, options.maxNameChars),
      tagName: element.tagName.toLowerCase(),
      states: [],
      rect,
      visible: visibility.visible,
      inViewport: visibility.inViewport,
      actionable: false,
      visibility,
      warnings: visibility.warnings,
      element,
    })
  }

  function shouldIncludeNode(node) {
    if (options.interactiveOnly) return node.actionable
    if (node.actionable) return true
    if (!options.includeHidden && !node.visible) return false
    return [
      'heading',
      'banner',
      'navigation',
      'main',
      'contentinfo',
      'form',
      'table',
      'list',
      'listitem',
      'status',
      'alert',
      'log',
      'text',
      'iframe',
      'fileUpload',
    ].includes(node.role)
  }

  function inferRole(element) {
    const explicit = element.getAttribute?.('role')
    if (explicit) return explicit.trim().split(/\s+/)[0]
    const tag = element.tagName?.toLowerCase()
    const type = (element.getAttribute?.('type') || '').toLowerCase()
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'a' && element.hasAttribute('href')) return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return 'combobox'
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'file') return 'fileUpload'
      if (type === 'radio') return 'radio'
      if (['range'].includes(type)) return 'slider'
      if (['email', 'number', 'password', 'search', 'tel', 'text', 'url', ''].includes(type))
        return 'textbox'
      return 'textbox'
    }
    if (element.isContentEditable) return 'textbox'
    if (tag === 'nav') return 'navigation'
    if (tag === 'main') return 'main'
    if (tag === 'header') return 'banner'
    if (tag === 'footer') return 'contentinfo'
    if (tag === 'form') return 'form'
    if (tag === 'table') return 'table'
    if (tag === 'ul' || tag === 'ol') return 'list'
    if (tag === 'li') return 'listitem'
    if (tag === 'output') return 'status'
    if (tag === 'iframe') return 'iframe'
    if (element.onclick || element.tabIndex >= 0) return 'button'
    return 'generic'
  }

  function accessibleName(element, role) {
    const labelledBy = element.getAttribute?.('aria-labelledby')
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map(
          id =>
            document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || ''
        )
        .join(' ')
      if (normalizeWhitespace(label)) return normalizeWhitespace(label)
    }
    for (const attr of ['aria-label', 'alt', 'title']) {
      const value = element.getAttribute?.(attr)
      if (normalizeWhitespace(value)) return normalizeWhitespace(value)
    }
    const tag = element.tagName?.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
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
      if (normalizeWhitespace(element.getAttribute('placeholder'))) {
        return normalizeWhitespace(element.getAttribute('placeholder'))
      }
    }
    if (['button', 'link', 'heading', 'checkbox', 'radio', 'tab', 'menuitem'].includes(role)) {
      return normalizeWhitespace(element.innerText || element.textContent || '')
    }
    return normalizeWhitespace(element.innerText || element.textContent || '')
  }

  function statesFor(element) {
    const states = []
    if (element.disabled || element.closest?.('fieldset[disabled]')) states.push('disabled')
    if (element.readOnly) states.push('readonly')
    if (element.checked) states.push('checked')
    if (element.selected) states.push('selected')
    if (element.open) states.push('open')
    for (const [attr, state] of [
      ['aria-expanded', 'expanded'],
      ['aria-pressed', 'pressed'],
      ['aria-selected', 'selected'],
      ['aria-checked', 'checked'],
    ]) {
      const value = element.getAttribute?.(attr)
      if (value === 'true') states.push(state)
      if (value === 'false' && attr === 'aria-expanded') states.push('collapsed')
    }
    if (document.activeElement === element) states.push('focused')
    if (element.hidden || element.getAttribute?.('aria-hidden') === 'true') states.push('hidden')
    return Array.from(new Set(states))
  }

  function rectFor(element, context) {
    const rect = element.getBoundingClientRect()
    return {
      x: round(rect.x + context.offsetX),
      y: round(rect.y + context.offsetY),
      width: round(rect.width),
      height: round(rect.height),
    }
  }

  function visibilityFor(element, rect, doc, context) {
    const style = doc.defaultView.getComputedStyle(element)
    const hasBox = rect.width > 0 && rect.height > 0
    const hidden =
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number(style.opacity || '1') <= 0.01 ||
      element.hidden
    const inViewport = intersectsViewport(rect, 0)
    const visible = hasBox && !hidden && intersectsViewport(rect, options.viewportMargin)
    const visibleRatio = visibleAreaRatio(rect)
    const receivesPointerEvents = style.pointerEvents !== 'none'
    const hitTest = hitTestFor(element, rect, doc, context)
    const occluded = visible && inViewport && hitTest.sampleCount > 0 && hitTest.hitCount === 0
    const visibilityWarnings = []
    if (visible && inViewport && !hitTest.centerHit && hitTest.hitCount > 0) {
      visibilityWarnings.push(
        warning(
          'center_point_occluded',
          'The center point is covered but another sampled point reaches the element.'
        )
      )
    }
    if (visible && inViewport && hitTest.sampleCount === 0) {
      visibilityWarnings.push(
        warning('hit_test_unavailable', 'DOM hit testing could not sample this element.')
      )
    }
    return {
      visible,
      inViewport,
      clipped: visibleRatio > 0 && visibleRatio < 0.5,
      occluded,
      receivesPointerEvents,
      rect,
      visibleRatio: round(visibleRatio),
      hitTest,
      warnings: visibilityWarnings,
    }
  }

  function hitTestFor(element, rect, doc, context) {
    if (rect.width <= 0 || rect.height <= 0 || !intersectsViewport(rect, 0)) {
      return { sampleCount: 0, hitCount: 0, centerHit: false }
    }
    const padding = Math.min(4, rect.width / 4, rect.height / 4)
    const samples = [
      [rect.x + rect.width / 2, rect.y + rect.height / 2, true],
      [rect.x + padding, rect.y + padding, false],
      [rect.x + rect.width - padding, rect.y + padding, false],
      [rect.x + padding, rect.y + rect.height - padding, false],
      [rect.x + rect.width - padding, rect.y + rect.height - padding, false],
    ].filter(([x, y]) => x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight)
    let hitCount = 0
    let centerHit = false
    let topElementSummary
    for (const [x, y, center] of samples) {
      const localX = x - context.offsetX
      const localY = y - context.offsetY
      const hit = doc.elementFromPoint(localX, localY)
      if (!topElementSummary && hit) topElementSummary = summarizeElement(hit)
      if (isHitAccepted(element, hit)) {
        hitCount++
        if (center) centerHit = true
      }
    }
    return {
      sampleCount: samples.length,
      hitCount,
      centerHit,
      topElementSummary,
    }
  }

  function isHitAccepted(element, hit) {
    if (!hit) return false
    if (hit === element || element.contains(hit)) return true
    if (hit.tagName?.toLowerCase() === 'label' && hit.control === element) return true
    if (element.tagName?.toLowerCase() === 'label' && element.contains(hit)) return true
    const root = hit.getRootNode?.()
    return Boolean(root?.host && (root.host === element || element.contains(root.host)))
  }

  function isActionableRole(role, element) {
    if (
      [
        'button',
        'link',
        'textbox',
        'checkbox',
        'radio',
        'combobox',
        'slider',
        'menuitem',
        'tab',
      ].includes(role)
    ) {
      return true
    }
    return Boolean(element.onclick || element.isContentEditable || element.tabIndex >= 0)
  }

  function rankFor(role, visibility, actionable, focused) {
    if (focused) return 0
    if (actionable && visibility.inViewport) return 10
    if (['heading', 'main', 'navigation', 'banner', 'contentinfo', 'form'].includes(role)) return 30
    if (['status', 'alert', 'log'].includes(role)) return 50
    if (actionable) return 40
    if (['table', 'list', 'listitem'].includes(role)) return 70
    return 100
  }

  function rankNodes(values) {
    return values
      .map((node, order) => ({ ...node, order }))
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          a.frameId.localeCompare(b.frameId) ||
          a.rect.y - b.rect.y ||
          a.rect.x - b.rect.x ||
          a.order - b.order
      )
      .map(({ order, ...node }) => node)
  }

  function fingerprintFor(node, element) {
    return {
      tagName: node.tagName,
      role: node.role,
      inputType: node.inputType,
      accessibleName: hashText(node.name || ''),
      hrefSignature: hrefSignature(node.href),
      rectBucket: `${Math.round(node.rect.x / 20)}:${Math.round(node.rect.y / 20)}:${Math.round(node.rect.width / 20)}:${Math.round(node.rect.height / 20)}`,
      domPathHint: domPathHint(element),
    }
  }

  function resolveInspectElement(input) {
    const current = window.__WEWORK_BROWSER_AGENT__
    if (!current || !Array.isArray(current.inspectRegistries)) {
      return { ok: false, errorCode: 'stale_inspect', message: 'No inspect registry is available.' }
    }
    const registry = input.ref
      ? current.inspectRegistries.find(item => item.refs?.[input.ref])
      : input.inspectId
        ? current.inspectRegistries.find(item => item.inspectId === input.inspectId)
        : current.inspectRegistries[0]
    if (!registry) {
      return {
        ok: false,
        errorCode: 'stale_inspect',
        message: 'Inspect result is no longer available.',
      }
    }
    if (Date.now() - Number(registry.createdAt || 0) > 120000) {
      return { ok: false, errorCode: 'stale_inspect', message: 'Inspect result expired.' }
    }
    const ref =
      input.ref ||
      registry.indexToRef?.[String(input.index)] ||
      registry.indexToRef?.[Number(input.index)]
    const record = ref ? registry.refs?.[ref] : null
    if (!record) {
      return { ok: false, errorCode: 'element_not_found', message: 'Inspect target was not found.' }
    }
    if (!record.actionable) {
      return {
        ok: false,
        errorCode: 'element_not_actionable',
        message: 'Inspect target is not actionable.',
      }
    }
    const element = record.element
    if (!element || !element.isConnected) {
      return { ok: false, errorCode: 'stale_ref', message: 'Inspect target is detached.' }
    }
    const role = inferRole(element)
    const name = trimText(accessibleName(element, role), options.maxNameChars)
    const rect = rectFor(element, { offsetX: 0, offsetY: 0 })
    const fingerprint = fingerprintFor(
      {
        tagName: element.tagName.toLowerCase(),
        role,
        inputType:
          element.tagName.toLowerCase() === 'input'
            ? (element.getAttribute('type') || 'text').toLowerCase()
            : undefined,
        name,
        href: hrefFor(element),
        rect,
      },
      element
    )
    if (
      fingerprint.tagName !== record.fingerprint.tagName ||
      fingerprint.role !== record.fingerprint.role ||
      fingerprint.inputType !== record.fingerprint.inputType ||
      fingerprint.accessibleName !== record.fingerprint.accessibleName ||
      fingerprint.hrefSignature !== record.fingerprint.hrefSignature
    ) {
      return { ok: false, errorCode: 'stale_ref', message: 'Inspect target fingerprint changed.' }
    }
    return {
      ok: true,
      ref: record.ref,
      inspectId: registry.inspectId,
      index: record.index,
      frameId: record.frameId,
      role,
      name,
      rect,
      visible: true,
      actionable: true,
      element,
      record,
    }
  }

  function resolveInspectTarget(input) {
    const result = resolveInspectElement(input)
    if (!result.ok) return result
    const { element, record, ...serializable } = result
    return serializable
  }

  function buildInspectText(values, viewport) {
    const lines = [
      `Page: ${trimText(document.title || '(untitled)', 200)}`,
      `URL: ${safeUrl(location.href)}`,
      `InspectId: ${inspectId}`,
      `Viewport: ${viewport.width}x${viewport.height} scroll=(${viewport.scrollX},${viewport.scrollY})`,
    ]
    for (const warningItem of warnings.slice(0, 10)) {
      lines.push(`Warning: ${warningItem.code} - ${warningItem.message}`)
    }
    for (const node of values) {
      const label = node.name || node.text || ''
      const stateText = node.states?.length ? ` states=${node.states.join(',')}` : ''
      const valueText = node.value ? ` value="${trimText(node.value, 120)}"` : ''
      const uploadText = node.upload
        ? ` upload=${node.upload.multiple ? 'multiple' : 'single'}${node.upload.accept ? ` accept="${trimText(node.upload.accept, 80)}"` : ''}${node.upload.fileCount ? ` files=${node.upload.fileCount}` : ''}`
        : ''
      const visibleText = node.visible ? '' : ' visible=false'
      const actionText = node.actionable ? '' : ' actionable=false'
      lines.push(
        `[${node.index}] ${node.role} "${trimText(label, 120)}"${stateText}${valueText}${uploadText}${visibleText}${actionText} rect=(${node.rect.x},${node.rect.y},${node.rect.width},${node.rect.height})`
      )
    }
    return lines.join('\n')
  }

  function pageInfo() {
    return {
      url: location.href,
      safeUrl: safeUrl(location.href),
      title: trimText(document.title || '', 200),
      readyState: document.readyState,
      language: document.documentElement?.lang || undefined,
      characterSet: document.characterSet || undefined,
    }
  }

  function viewportInfo() {
    const viewport = {
      width: Math.round(window.innerWidth),
      height: Math.round(window.innerHeight),
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      deviceScaleFactor: window.devicePixelRatio || 1,
    }
    if (window.visualViewport) {
      viewport.visualViewport = {
        offsetLeft: round(window.visualViewport.offsetLeft),
        offsetTop: round(window.visualViewport.offsetTop),
        width: round(window.visualViewport.width),
        height: round(window.visualViewport.height),
        scale: round(window.visualViewport.scale),
      }
    }
    return viewport
  }

  function textFor(element, role) {
    if (!['heading', 'text', 'button', 'link', 'listitem', 'status', 'alert', 'log'].includes(role))
      return undefined
    return (
      trimText(redactText(element.innerText || element.textContent || ''), options.maxNameChars) ||
      undefined
    )
  }

  function valueFor(element) {
    const tag = element.tagName?.toLowerCase()
    if (!['input', 'textarea', 'select'].includes(tag)) return undefined
    const type = (element.getAttribute('type') || '').toLowerCase()
    if (['password', 'hidden'].includes(type)) return type === 'password' ? '[redacted]' : undefined
    if (type === 'file') {
      const files = Array.from(element.files || [])
        .map(file => file.name)
        .filter(Boolean)
      return files.length ? trimText(files.join(', '), options.maxValueChars) : undefined
    }
    return trimText(redactText(element.value || ''), options.maxValueChars) || undefined
  }

  function uploadInfoFor(element, inputType) {
    if (!(element instanceof HTMLInputElement) || inputType !== 'file') return undefined
    const files = Array.from(element.files || [])
      .map(file => file.name)
      .filter(Boolean)
      .slice(0, 10)
    return {
      accept: trimText(element.getAttribute('accept') || '', 120) || undefined,
      multiple: Boolean(element.multiple),
      fileCount: element.files?.length || 0,
      fileNames: files,
      requiresUserSelection: true,
    }
  }

  function hrefFor(element) {
    if (element.tagName?.toLowerCase() !== 'a') return undefined
    return element.href ? safeUrl(element.href) : undefined
  }

  function hrefSignature(href) {
    if (!href) return undefined
    try {
      const parsed = new URL(href, location.href)
      return `${parsed.origin}${parsed.pathname}`
    } catch {
      return undefined
    }
  }

  function safeUrl(value) {
    try {
      const parsed = new URL(value, location.href)
      const queryKeys = Array.from(parsed.searchParams.keys())
      parsed.search = queryKeys.length
        ? `?${queryKeys.map(key => `${encodeURIComponent(key)}=`).join('&')}`
        : ''
      parsed.hash = ''
      return parsed.href
    } catch {
      return String(value || '').split('#')[0]
    }
  }

  function redactText(value) {
    return String(value || '')
      .replace(/([?&][^=\s]{1,80}=)[^\s&]+/g, '$1[redacted]')
      .replace(/\b\d{6}\b/g, '[redacted-code]')
  }

  function visibleAreaRatio(rect) {
    const x1 = Math.max(0, rect.x)
    const y1 = Math.max(0, rect.y)
    const x2 = Math.min(window.innerWidth, rect.x + rect.width)
    const y2 = Math.min(window.innerHeight, rect.y + rect.height)
    const area = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
    const total = Math.max(1, rect.width * rect.height)
    return area / total
  }

  function intersectsViewport(rect, margin) {
    return (
      rect.x + rect.width >= -margin &&
      rect.y + rect.height >= -margin &&
      rect.x <= window.innerWidth + margin &&
      rect.y <= window.innerHeight + margin
    )
  }

  function summarizeElement(element) {
    return {
      tagName: element.tagName?.toLowerCase() || '',
      role: element.getAttribute?.('role') || undefined,
      name:
        trimText(
          element.getAttribute?.('aria-label') || element.innerText || element.textContent || '',
          60
        ) || undefined,
      className: trimText(String(element.className || ''), 80) || undefined,
    }
  }

  function domPathHint(element) {
    const parts = []
    let current = element
    for (let depth = 0; current && current.nodeType === Node.ELEMENT_NODE && depth < 5; depth++) {
      const tag = current.tagName.toLowerCase()
      const id = current.id ? `#${current.id}` : ''
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            child => child.tagName === current.tagName
          )
        : []
      const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''
      parts.unshift(`${tag}${id}${nth}`)
      current = current.parentElement
    }
    return parts.join('>')
  }

  function hashText(value) {
    let hash = 5381
    const text = String(value || '')
    for (let index = 0; index < text.length; index++) {
      hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
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

  function clampNumber(value, min, max, fallback) {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.round(number)))
  }

  function round(value) {
    return Math.round(Number(value || 0) * 100) / 100
  }

  function isFormControl(element) {
    return ['input', 'textarea', 'select', 'button'].includes(element.tagName?.toLowerCase())
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value)
    return String(value).replace(/["\\]/g, '\\$&')
  }

  function safeRead(read, fallback) {
    try {
      return read()
    } catch {
      return fallback
    }
  }

  function warning(code, message, details) {
    return { code, message, ...(details ? { details } : {}) }
  }
})()
