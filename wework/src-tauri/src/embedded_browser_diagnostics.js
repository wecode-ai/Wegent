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
