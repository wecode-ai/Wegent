;(() => {
  if (window.__WEWORK_BROWSER_DIAGNOSTICS_INSTALLED__) return
  window.__WEWORK_BROWSER_DIAGNOSTICS_INSTALLED__ = true

  const prefix = '[wework-browser-diag]'
  const now = () => Date.now()
  const trim = value => {
    if (value === null || value === undefined) return null
    const text = String(value)
    return text.length > 400 ? `${text.slice(0, 400)}…` : text
  }
  const emit = (event, detail = {}) => {
    try {
      console.log(
        prefix,
        JSON.stringify({
          kind: 'browser.runtimeDiagnostic',
          event,
          href: location.href,
          title: document.title || '',
          readyState: document.readyState,
          visibilityState: document.visibilityState || '',
          referrer: document.referrer || '',
          timestampUnixMs: now(),
          ...detail,
        })
      )
    } catch (_) {
      // Ignore logging failures.
    }
  }

  const popupClickShouldOpenNewTab = event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey) return false
    return event.ctrlKey || event.shiftKey
  }

  const popupAnchorFromEvent = event => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    const pathAnchor = path.find(node => node instanceof Element && node.tagName === 'A')
    if (pathAnchor) return pathAnchor
    return event.target instanceof Element ? event.target.closest('a[href]') : null
  }

  const patchTauriOpenerInvoke = () => {
    const internals = window.__TAURI_INTERNALS__
    if (!internals || typeof internals.invoke !== 'function') return false
    if (internals.__WEWORK_EMBEDDED_BROWSER_OPENER_PATCHED__) return true

    const originalInvoke = internals.invoke.bind(internals)
    internals.invoke = (command, args, options) => {
      if (command === 'plugin:opener|open_url' && typeof args?.url === 'string') {
        try {
          window.open(String(args.url), '_blank', 'noopener,noreferrer')
        } catch (_) {
          // Ignore open failures and let the original command handle the error path.
        }
        return Promise.resolve(undefined)
      }
      return originalInvoke(command, args, options)
    }
    internals.__WEWORK_EMBEDDED_BROWSER_OPENER_PATCHED__ = true
    return true
  }

  patchTauriOpenerInvoke()

  window.addEventListener(
    'click',
    event => {
      const anchor = popupAnchorFromEvent(event)
      if (!anchor?.href) return
      if (anchor.target !== '_blank' && !popupClickShouldOpenNewTab(event)) return
      let url
      try {
        url = new URL(anchor.href, location.href)
      } catch (_) {
        return
      }
      if (!['http:', 'https:', 'file:'].includes(url.protocol)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      emit('popup_link_intercepted', {
        target: trim(anchor.target || null),
        url: trim(url.href),
      })
      window.open(url.href, '_blank', 'noopener,noreferrer')
    },
    true
  )

  emit('init', {
    bodyChildElementCount: document.body ? document.body.children.length : null,
    bodyTextLength: document.body ? (document.body.innerText || '').length : null,
  })

  window.addEventListener(
    'error',
    event => {
      emit('error', {
        message: trim(event.message || event.error?.message || event.error),
        filename: trim(event.filename),
        lineno: event.lineno ?? null,
        colno: event.colno ?? null,
        isTrusted: event.isTrusted === true,
      })
    },
    true
  )

  window.addEventListener('unhandledrejection', event => {
    emit('unhandledrejection', {
      reason: trim(event.reason?.stack || event.reason?.message || event.reason),
    })
  })

  document.addEventListener('DOMContentLoaded', () => {
    emit('domcontentloaded', {
      bodyChildElementCount: document.body ? document.body.children.length : null,
      bodyTextLength: document.body ? (document.body.innerText || '').length : null,
    })
  })

  window.addEventListener('load', () => {
    emit('load', {
      bodyChildElementCount: document.body ? document.body.children.length : null,
      bodyTextLength: document.body ? (document.body.innerText || '').length : null,
    })
  })

  window.addEventListener('pageshow', event => {
    emit('pageshow', {
      persisted: event.persisted === true,
    })
  })

  window.addEventListener('pagehide', event => {
    emit('pagehide', {
      persisted: event.persisted === true,
    })
  })
})()
