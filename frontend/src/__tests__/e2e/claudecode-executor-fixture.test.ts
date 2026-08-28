import { readFileSync } from 'fs'
import { join } from 'path'

const dockerfile = readFileSync(
  join(process.cwd(), 'e2e/fixtures/claudecode-executor/Dockerfile'),
  'utf8'
)

describe('ClaudeCode executor E2E fixture image', () => {
  it('keeps source files outside the executor volume mount path', () => {
    expect(dockerfile).toContain('COPY executor/src ./src')
    expect(dockerfile).toContain('COPY shared/assets /workspace/src/shared/assets')
    expect(dockerfile).toContain(
      'COPY --from=builder /workspace/src/executor/target/release/wegent-executor /app/executor'
    )
    expect(dockerfile).not.toContain('COPY executor /app/src/executor')
    expect(dockerfile).not.toContain('python -m executor.main')
  })

  it('keeps toolchain and dependency layers reusable across source changes', () => {
    expect(dockerfile).toContain('ARG BASE_IMAGE=ghcr.io/wecode-ai/wegent-base-python3.12:latest')
    expect(dockerfile).toContain('FROM ${BASE_IMAGE} AS builder-base')
    expect(dockerfile).toContain('COPY executor/Cargo.toml executor/Cargo.lock ./')
    expect(dockerfile).toContain('cargo build --release --locked --bin wegent-executor')
  })
})
