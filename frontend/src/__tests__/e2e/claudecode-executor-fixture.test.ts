import { readFileSync } from 'fs'
import { join } from 'path'

const dockerfile = readFileSync(
  join(process.cwd(), 'e2e/fixtures/claudecode-executor/Dockerfile'),
  'utf8'
)

describe('ClaudeCode executor E2E fixture image', () => {
  it('keeps source files outside the executor volume mount path', () => {
    expect(dockerfile).toContain('COPY shared /workspace/src/shared')
    expect(dockerfile).toContain('COPY executor /workspace/src/executor')
    expect(dockerfile).toContain('exec python /workspace/src/executor/main.py "$@"')
    expect(dockerfile).toContain('ENV PYTHONPATH=/workspace/src')
    expect(dockerfile).not.toContain('COPY executor /app/src/executor')
    expect(dockerfile).not.toContain('python -m executor.main')
  })
})
