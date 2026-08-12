import http from 'node:http'

const PORT = Number.parseInt(process.env.WEWORK_SITES_UPSTREAM_MOCK_PORT || '9997', 10)
const DEFAULT_TOKEN = process.env.WEWORK_SITES_UPSTREAM_MOCK_TOKEN || 'e2e-sites-token'

const capturedRequests = []
const projects = new Map()

function seedProjects() {
  projects.clear()
  projects.set('prj_e2e_product', {
    id: 'prj_e2e_product',
    network: 'inner',
    title: 'E2E Product Site',
    url: 'https://sites.internal/e2e-product',
    snapshot: 'https://sites.internal/e2e-product.png',
    created_at: '2026-07-22T00:00:00Z',
  })
  projects.set('prj_e2e_published', {
    id: 'prj_e2e_published',
    network: 'outer',
    title: 'E2E Published Site',
    url: 'https://sites.example.test/e2e-published',
    snapshot: null,
    created_at: '2026-07-22T00:05:00Z',
  })
  projects.set('prj_e2e_mini', {
    id: 'prj_e2e_mini',
    app_type: 'miniapp',
    title: 'E2E Mini Program',
    app_id: 'wx-e2e-mini',
    status: 'experience',
    version: '1.0.0',
    experience_url: 'https://example.test/mini-experience',
    snapshot: null,
    created_at: '2026-07-22T00:10:00Z',
    updated_at: '2026-07-22T00:12:00Z',
  })
}

seedProjects()

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Idempotency-Key,X-Wegent-Username',
    ...extra,
  }
}

function writeJson(res, status, data) {
  res.writeHead(status, corsHeaders({ 'Content-Type': 'application/json' }))
  res.end(JSON.stringify(data, null, 2))
}

function writeOptions(res) {
  res.writeHead(204, corsHeaders())
  res.end()
}

function parseJsonBody(body) {
  try {
    return body ? JSON.parse(body) : null
  } catch {
    return null
  }
}

function capture(req, body) {
  capturedRequests.push({
    timestamp: new Date().toISOString(),
    method: req.method || 'GET',
    url: req.url || '/',
    headers: req.headers,
    body: parseJsonBody(body),
  })
}

function authorized(req) {
  if (!DEFAULT_TOKEN) {
    return true
  }
  return req.headers.authorization === `Bearer ${DEFAULT_TOKEN}`
}

function requireAuth(req, res) {
  if (authorized(req)) {
    return true
  }
  writeJson(res, 401, { detail: 'Invalid Sites upstream token' })
  return false
}

function searchProjects(req, res) {
  if (!requireAuth(req, res)) {
    return
  }

  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  const query = url.searchParams.get('sitename')?.trim().toLowerCase() || ''
  const appType = url.searchParams.get('app_type') || 'web'
  const limit = Math.max(
    1,
    Math.min(100, Number.parseInt(url.searchParams.get('limit') || '100', 10))
  )
  const cursor = url.searchParams.get('cursor')
  const startIndex = cursor ? Number.parseInt(cursor, 10) || 0 : 0
  const allItems = [...projects.values()].filter(project => {
    if ((project.app_type || 'web') !== appType) {
      return false
    }
    if (!query) {
      return true
    }
    return project.title.toLowerCase().includes(query)
  })
  const page = allItems.slice(startIndex, startIndex + limit)
  const nextIndex = startIndex + page.length

  writeJson(res, 200, {
    items: page,
    next_cursor: nextIndex < allItems.length ? String(nextIndex) : null,
  })
}

function updateProjectNetwork(req, res, body) {
  if (!requireAuth(req, res)) {
    return
  }

  const payload = parseJsonBody(body)
  const projectId = payload?.project_id
  if (typeof projectId !== 'string' || !projects.has(projectId)) {
    writeJson(res, 404, { detail: 'Project not found' })
    return
  }

  const project = projects.get(projectId)
  project.network = payload.network === 'outer' ? 'outer' : 'inner'
  if (project.network === 'outer' && project.url.includes('sites.internal')) {
    project.url = `https://sites.example.test/${project.id}`
  }
  if (project.network === 'inner' && project.url.includes('sites.example.test')) {
    project.url = `https://sites.internal/${project.id}`
  }

  writeJson(res, 200, project)
}

function updateProjectName(req, res, body) {
  if (!requireAuth(req, res)) {
    return
  }

  const payload = parseJsonBody(body)
  const projectId = payload?.project_id
  if (typeof projectId !== 'string' || !projects.has(projectId)) {
    writeJson(res, 404, { detail: 'Project not found' })
    return
  }

  const project = projects.get(projectId)
  if (typeof payload.sitename === 'string' && payload.sitename.trim()) {
    project.title = payload.sitename.trim()
  }

  writeJson(res, 200, project)
}

function updateProjectMetadata(req, res, body) {
  if (!requireAuth(req, res)) {
    return
  }

  const projectId = new URL(req.url || '/', `http://127.0.0.1:${PORT}`).pathname.split('/').pop()
  if (!req.headers['idempotency-key'] || !req.headers['x-wegent-username']) {
    writeJson(res, 400, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Missing project metadata headers',
      },
    })
    return
  }
  if (!projectId || !projects.has(projectId)) {
    writeJson(res, 404, {
      error: {
        code: 'NOT_FOUND',
        message: 'Project not found',
      },
    })
    return
  }

  const payload = parseJsonBody(body)
  const project = projects.get(projectId)
  if (typeof payload?.title === 'string' && payload.title.trim()) {
    project.title = payload.title.trim()
  }
  if (Object.hasOwn(payload || {}, 'custom_domain_prefix')) {
    project.custom_domain_prefix = payload.custom_domain_prefix || null
  }

  writeJson(res, 200, project)
}

function deleteProject(req, res, body) {
  if (!requireAuth(req, res)) {
    return
  }

  const payload = parseJsonBody(body)
  const projectId = payload?.project_id
  if (typeof projectId === 'string') {
    projects.delete(projectId)
  }

  writeJson(res, 200, { deleted: true, project_id: projectId })
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    writeOptions(res)
    return
  }

  let body = ''
  req.on('data', chunk => {
    body += chunk.toString()
  })

  req.on('end', () => {
    if (req.url === '/health') {
      writeJson(res, 200, {
        status: 'ok',
        capturedCount: capturedRequests.length,
        projectCount: projects.size,
      })
      return
    }

    if (req.url === '/captured-requests') {
      writeJson(res, 200, capturedRequests)
      return
    }

    if (req.url === '/clear-requests' && req.method === 'POST') {
      capturedRequests.length = 0
      writeJson(res, 200, { message: 'Requests cleared' })
      return
    }

    if (req.url === '/reset' && req.method === 'POST') {
      capturedRequests.length = 0
      seedProjects()
      writeJson(res, 200, { message: 'Sites mock reset', projectCount: projects.size })
      return
    }

    capture(req, body)

    if (req.url?.startsWith('/api/v1/projects/search') && req.method === 'GET') {
      searchProjects(req, res)
      return
    }

    if (req.url === '/api/v1/projects/deploy/network' && req.method === 'POST') {
      updateProjectNetwork(req, res, body)
      return
    }

    if (req.url === '/api/v1/projects/update' && req.method === 'POST') {
      updateProjectName(req, res, body)
      return
    }

    if (req.url?.startsWith('/api/v1/projects/') && req.method === 'PATCH') {
      updateProjectMetadata(req, res, body)
      return
    }

    if (req.url === '/api/v1/projects/del' && req.method === 'POST') {
      deleteProject(req, res, body)
      return
    }

    writeJson(res, 404, { detail: 'Not found' })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Wework E2E Sites upstream mock listening on http://127.0.0.1:${PORT}`)
})

function shutdown() {
  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
