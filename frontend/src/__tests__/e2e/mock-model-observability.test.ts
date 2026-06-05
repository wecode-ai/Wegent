import { readFileSync } from 'fs'
import { join } from 'path'

const mockServer = readFileSync(join(process.cwd(), 'e2e/utils/mock-model-server.ts'), 'utf8')
const workflow = readFileSync(join(process.cwd(), '../.github/workflows/e2e-tests.yml'), 'utf8')

describe('mock model E2E observability', () => {
  it('logs enough request detail to confirm model traffic from CI logs', () => {
    expect(mockServer).toContain('Request text snippet:')
    expect(mockServer).toContain('Context token:')
    expect(mockServer).toContain('Mock response content:')
  })

  it('uploads E2E service logs only when tests fail', () => {
    expect(workflow).toMatch(/- name: Upload backend logs\s+if: failure\(\)/)
    expect(workflow).toMatch(/- name: Upload executor logs\s+if: failure\(\)/)
  })
})
