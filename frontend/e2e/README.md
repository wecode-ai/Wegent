# E2E Testing with Code Coverage

This directory contains end-to-end tests for the Wegent frontend using Playwright.

## Running Tests

### Basic Commands

```bash
# Run all E2E tests
pnpm run e2e

# Run tests with UI mode
pnpm run e2e:ui

# Run tests in debug mode
pnpm run e2e:debug

# Run tests in headed mode (see browser)
pnpm run e2e:headed

# View test report
pnpm run e2e:report
```

### Local Development

```bash
# Run E2E tests locally (starts services automatically)
pnpm run e2e:local

# With UI mode
pnpm run e2e:local:ui

# With debug mode
pnpm run e2e:local:debug
```

## Code Coverage

### Collecting Coverage

The E2E tests can collect code coverage data from the frontend application during test execution.

```bash
# Run tests and generate coverage report
pnpm run e2e:coverage

# Generate coverage report from existing data
pnpm run e2e:coverage:report
```

### Coverage Reports

Coverage reports are generated in the following formats:

- **HTML Report**: `coverage-e2e/index.html` - Interactive HTML report
- **LCOV Report**: `coverage-e2e/lcov.info` - For CI/CD integration
- **Text Report**: Printed to console

### Coverage Configuration

Coverage settings are configured in [`.nycrc.json`](../.nycrc.json):

- **Included**: All files in `src/**/*.{js,jsx,ts,tsx}`
- **Excluded**: Test files, config files, type definitions
- **Thresholds**: 60% lines/statements/functions, 50% branches

### Using Coverage in Tests

To enable coverage collection in your tests, use the coverage helper:

```typescript
import { test } from '@playwright/test'
import { startCoverage, stopCoverage } from '../helpers/coverage'

test('my test with coverage', async ({ page }) => {
  // Start coverage collection
  await startCoverage(page)

  // Your test code here
  await page.goto('/')
  // ... test actions ...

  // Stop coverage and save results
  await stopCoverage(page, 'my-test-name')
})
```

### Coverage in CI/CD

Coverage data is automatically collected during CI/CD runs. The coverage reports are:

1. Uploaded as artifacts
2. Used to generate coverage badges
3. Compared against thresholds

## Test Structure

```
e2e/
├── tests/              # Test files
│   ├── admin/         # Admin panel tests
│   ├── api/           # API tests
│   ├── auth/          # Authentication tests
│   ├── settings/      # Settings page tests
│   └── tasks/         # Task management tests
├── pages/             # Page Object Models
│   ├── auth/          # Auth page objects
│   ├── admin/         # Admin page objects
│   └── settings/      # Settings page objects
├── fixtures/          # Test data and builders
├── helpers/           # Test utilities
│   └── coverage.ts    # Coverage collection helper
├── utils/             # Shared utilities
└── config/            # Test configuration
```

## 钉钉导入 remote 检索验证

`tests/knowledge/dingtalk-import.spec.ts` 的 7 个场景由 CI 的
`provider-native-chromium` 项目执行。Backend 必须设置 `RAG_RUNTIME_MODE=remote`
和 `KNOWLEDGE_RUNTIME_URL`，并启动真实 Knowledge Runtime、Qdrant、MySQL 和 Redis。
Runtime 与 Backend 共用数据库、`INTERNAL_SERVICE_TOKEN` 和 `GIT_TOKEN_AES_KEY/IV`，
通过 `KNOWLEDGE_RUNTIME_DATABASE_URL` 和 `KNOWLEDGE_RUNTIME_BACKEND_INTERNAL_URL` 连接。

测试通过真实 API 创建并清理专用 Embedding Model、Retriever 和各场景知识库，
知识库显式绑定检索配置，不依赖管理员预先配置。只模拟钉钉 MCP 和外部 embedding HTTP
接口；导入任务、remote 索引、Qdrant 存储及分块读取均走真实链路。

格式可选性单独验证：PDF 可选，普通表格和 AI 表格缺少各自 MCP 配置时不可选并展示配置入口。
批量导入目录固定为三篇在线文档；文件下载契约由后端 Provider 测试覆盖，
本套 E2E 不覆盖 PDF 下载到检索的完整链路。

本地服务就绪后，在 `frontend` 目录执行：

```bash
E2E_QDRANT_URL=http://localhost:6333 \
E2E_KNOWLEDGE_RUNTIME_URL=http://localhost:8200 \
pnpm exec playwright test e2e/tests/knowledge/dingtalk-import.spec.ts \
  --project=provider-native-chromium --workers=1
```

非默认端口另设 `E2E_BASE_URL`、`E2E_API_URL` 和 `MOCK_MODEL_SERVER_URL`。
模拟 embedding 返回确定性的 32 维向量，只验证检索基础设施契约，不评估语义检索质量。

## Agent Conversation Regression

`tests/tasks/agent-conversation-regression.spec.ts` covers these backend-integrated task flows:

- Normal mode Chat Shell dialogue and follow-up.
- Normal mode ClaudeCode dialogue, follow-up, and executor session resume.
- Coding mode ClaudeCode dialogue and follow-up.
- Wework app-device discovery, card-to-chat navigation, ClaudeCode dialogue, and follow-up.

The regression runs in the dedicated `executor-e2e-tests` GitHub Actions job. Ordinary sharded E2E jobs skip this spec so they do not install executor dependencies, build executor images, or start executor-manager. It uses global setup authentication like the rest of `frontend/e2e`; no external Playwright auth-state secret is required.

CI starts these support services:

- `utils/mock-model-server.ts` receives real Chat Shell OpenAI-compatible requests and real ClaudeCode Anthropic Messages API requests, then records the second-turn prompt package.
- A real `executor` local-mode process registers a Wework `app` device through the Backend `/local-executor` Socket.IO namespace.

Normal and coding ClaudeCode tests run through the actual executor-manager Docker path and the real `ClaudeCodeAgent` inside an executor container. Device mode runs through the actual Backend-to-local-executor WebSocket path and a real local-mode `ClaudeCodeAgent`. The model endpoint is the only mocked boundary, and the tests assert that the second-turn `/v1/messages` request received by the mock model server contains both the first-turn prompt and context token.

The executor job builds `fixtures/claudecode-executor/Dockerfile`, starts a real `executor_manager` service on port `8001`, and starts a real local ClaudeCode executor process for device-mode coverage. The fixture image compiles the Rust executor once, exposes it at `/app/executor`, and the workflow extracts that same binary for the local executor process. Source files live under `/workspace/src` because executor-manager mounts the extracted `/app/executor` entrypoint volume at `/app` for custom base images.

For GitHub Actions, `executor_manager` runs directly on the runner and task containers use Docker bridge networking with normal port mappings. Keep `DOCKER_HOST_ADDR=localhost` so the runner can dispatch to mapped container ports. Use the runner's Docker bridge IP for container-to-runner URLs such as `TASK_API_DOMAIN`, `CALLBACK_HOST`, and the ClaudeCode mock model base URL.

## Page Object Model

Tests use the Page Object Model pattern for better maintainability:

```typescript
import { LoginPage } from '../pages/auth/login.page'

test('login test', async ({ page }) => {
  const loginPage = new LoginPage(page)
  await loginPage.navigate()
  await loginPage.login('username', 'password')
  expect(await loginPage.isLoggedIn()).toBe(true)
})
```

## Best Practices

1. **Use Page Objects**: Encapsulate page interactions in page objects
2. **Descriptive Test Names**: Use clear, descriptive test names
3. **Independent Tests**: Each test should be independent and isolated
4. **Clean Up**: Always clean up test data in `afterEach` hooks
5. **Wait Strategies**: Use proper wait strategies instead of fixed timeouts
6. **Coverage**: Enable coverage for integration and critical path tests

When a test only requires the document to be interactive, pass the readiness
contract directly to navigation:

```typescript
await page.goto('/chat', { waitUntil: 'domcontentloaded' })
```

Do not call `page.goto()` with its default `load` wait and then call
`waitForLoadState('domcontentloaded')`. The second wait cannot run if a
non-critical resource keeps the `load` event pending.

## Debugging

### Visual Debugging

```bash
# Run with UI mode to see tests execute
pnpm run e2e:ui

# Run in headed mode to see browser
pnpm run e2e:headed

# Run in debug mode with breakpoints
pnpm run e2e:debug
```

### Trace Viewer

When tests fail, traces are automatically captured:

```bash
# View trace for failed test
pnpm exec playwright show-trace test-results/path-to-trace.zip
```

## CI/CD Integration

E2E tests run automatically in GitHub Actions:

- On pull requests
- On pushes to main branch
- Nightly scheduled runs

See [`.github/workflows/e2e-tests.yml`](../../.github/workflows/e2e-tests.yml) for configuration.

CI builds the production Next.js frontend once in the `build-frontend-e2e`
workflow job, uploads it as `frontend-next-build`, and restores that artifact in
each browser/API shard and in the executor E2E job before starting the generated
Next.js standalone server.

The executor regression job consumes a content-addressed Executor image keyed by
the Dockerfile, Rust sources, lockfile, and shared assets. Internal pull requests
publish that immutable image once, so merge-queue validation can pull the exact
same build input without recompiling it. The merge-queue job still extracts the
local executor binary from that image and runs the full device-mode and Docker
executor coverage against its own merged source tree. Fork pull requests use a
workflow artifact instead because their tokens cannot publish packages.

The workflow caches Python virtualenvs, frontend `node_modules`, and the executor
job's Claude Code CLI. Playwright browsers and their operating-system
dependencies are baked into an immutable GHCR image keyed by the dependency
Dockerfile content. Browser/API shards run inside that image, while the executor
job runs only its Playwright command in the same image with host networking so
it can reach the services and Docker-based executors running on the CI host.
No E2E job invokes Playwright browser or system dependency installation at
runtime.

### Sharded CI Users

The CI workflow runs Playwright tests across multiple shards. Each shard uses an
isolated E2E admin and regular user to reduce cross-shard data interference:

- `E2E_SHARD_INDEX=1` uses `e2e-admin-shard-1` and `e2e-user-shard-1`
- `E2E_SHARD_INDEX=2` uses `e2e-admin-shard-2` and `e2e-user-shard-2`
- `E2E_SHARD_INDEX=3` uses `e2e-admin-shard-3` and `e2e-user-shard-3`
- `E2E_SHARD_INDEX=4` uses `e2e-admin-shard-4` and `e2e-user-shard-4`
- Local runs without `E2E_SHARD_INDEX` use `e2e-admin-local` and `e2e-user-local`

`global-setup.ts` provisions these users with the bootstrap admin account, logs in
through the backend API, and writes Playwright `storageState` for browser tests.
Set `E2E_USE_ISOLATED_USERS=false` to fall back to the bootstrap admin user when
debugging against an environment where creating users is not desirable.
Set `E2E_BOOTSTRAP_ADMIN_PASSWORD` explicitly before running E2E tests locally.
When isolated users are enabled, also set `E2E_ADMIN_PASSWORD`. CI generates
random values for each job.

## Troubleshooting

### Tests Timing Out

- Increase timeout in `playwright.config.ts`
- Check if services are running
- Verify network connectivity

### Coverage Not Collected

- Ensure `startCoverage()` is called before navigation
- Check that source maps are enabled in Next.js
- Verify `.nycrc.json` configuration

### Flaky Tests

- Use proper wait strategies (`waitForSelector`, `waitForLoadState`)
- Avoid fixed timeouts (`page.waitForTimeout`)
- Ensure test data is properly cleaned up

## Resources

- [Playwright Documentation](https://playwright.dev)
- [NYC Coverage Documentation](https://github.com/istanbuljs/nyc)
- [Page Object Model Pattern](https://playwright.dev/docs/pom)
