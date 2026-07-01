import { readFileSync } from 'fs'
import { join } from 'path'

const dockerfile = readFileSync(
  join(process.cwd(), 'e2e/fixtures/claudecode-executor/Dockerfile'),
  'utf8'
)

describe('ClaudeCode executor E2E fixture image', () => {
  it('keeps source files outside the executor volume mount path', () => {
    expect(dockerfile).toContain('COPY executor /workspace/src/executor')
    expect(dockerfile).toContain('cargo build --release --locked')
    expect(dockerfile).toContain('cp target/release/wegent-executor /app/executor')
    expect(dockerfile).not.toContain('COPY executor /app/src/executor')
    expect(dockerfile).not.toContain('python -m executor.main')
  })
})
