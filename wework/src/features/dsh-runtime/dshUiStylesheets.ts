const stylesheets = new Map<string, Promise<void>>()

export async function loadDshUiStylesheets(module: unknown): Promise<void> {
  const urls = (module as { __weworkStylesheets?: string[] }).__weworkStylesheets ?? []
  await Promise.all(urls.map(loadStylesheet))
}

function loadStylesheet(url: string): Promise<void> {
  const existing = stylesheets.get(url)
  if (existing) return existing
  const loading = new Promise<void>((resolve, reject) => {
    const existingLink = [
      ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
    ].find(link => link.href === url)
    if (existingLink?.sheet) {
      resolve()
      return
    }
    const link = existingLink ?? document.createElement('link')
    link.addEventListener('load', () => resolve(), { once: true })
    link.addEventListener('error', () => reject(new Error('DSH UI stylesheet failed to load')), {
      once: true,
    })
    if (!existingLink) {
      link.rel = 'stylesheet'
      link.href = url
      document.head.appendChild(link)
    }
  })
  stylesheets.set(url, loading)
  return loading
}
