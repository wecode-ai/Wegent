# E2E Testing with Code Coverage

This directory contains end-to-end tests for the Wegent frontend using Playwright.

## Running Tests

### Basic Commands

```bash
# Run all E2E tests
npm run e2e

# Run tests with UI mode
npm run e2e:ui

# Run tests in debug mode
npm run e2e:debug

# Run tests in headed mode (see browser)
npm run e2e:headed

# View test report
npm run e2e:report
```

### Local Development

```bash
# Run E2E tests locally (starts services automatically)
npm run e2e:local

# With UI mode
npm run e2e:local:ui

# With debug mode
npm run e2e:local:debug
```

## Code Coverage

### Collecting Coverage

The E2E tests can collect code coverage data from the frontend application during test execution.

```bash
# Run tests and generate coverage report
npm run e2e:coverage

# Generate coverage report from existing data
npm run e2e:coverage:report
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

## Agent Conversation Regression

`tests/tasks/agent-conversation-regression.spec.ts` covers these backend-integrated task flows:

- Normal mode Chat Shell dialogue and follow-up.
- Normal mode ClaudeCode dialogue, follow-up, and executor session resume.
- Coding mode ClaudeCode dialogue and follow-up.
- Device mode ClaudeCode dialogue and follow-up through a local executor device.

The regression runs in the dedicated `executor-e2e-tests` GitHub Actions job. Ordinary sharded E2E jobs skip this spec so they do not install executor dependencies, build executor images, or start executor-manager. It uses global setup authentication like the rest of `frontend/e2e`; no external Playwright auth-state secret is required.

CI starts these support services:

- `utils/mock-model-server.ts` receives real Chat Shell OpenAI-compatible requests and real ClaudeCode Anthropic Messages API requests, then records the second-turn prompt package.
- A real `executor` local-mode process registers a ClaudeCode device through the Backend `/local-executor` Socket.IO namespace.

Normal and coding ClaudeCode tests run through the actual executor-manager Docker path and the real `ClaudeCodeAgent` inside an executor container. Device mode runs through the actual Backend-to-local-executor WebSocket path and a real local-mode `ClaudeCodeAgent`. The model endpoint is the only mocked boundary, and the tests assert that the second-turn `/v1/messages` request received by the mock model server contains both the first-turn prompt and context token.

The executor job builds `fixtures/claudecode-executor/Dockerfile`, starts a real `executor_manager` service on port `8001`, and starts a real local ClaudeCode executor process for device-mode coverage. The fixture image runs executor from source via `python -m executor.main`; it does not build a PyInstaller executor binary.

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

## Debugging

### Visual Debugging

```bash
# Run with UI mode to see tests execute
npm run e2e:ui

# Run in headed mode to see browser
npm run e2e:headed

# Run in debug mode with breakpoints
npm run e2e:debug
```

### Trace Viewer

When tests fail, traces are automatically captured:

```bash
# View trace for failed test
npx playwright show-trace test-results/path-to-trace.zip
```

## CI/CD Integration

E2E tests run automatically in GitHub Actions:

- On pull requests
- On pushes to main branch
- Nightly scheduled runs

See [`.github/workflows/e2e-tests.yml`](../../.github/workflows/e2e-tests.yml) for configuration.

CI starts the frontend with `npm run dev` instead of `npm run build && npm start`
so E2E jobs do not spend time on a production Next.js build. This keeps E2E
focused on browser/API behavior; production build failures need separate build
coverage outside this workflow.

The workflow caches Python virtualenvs, frontend `node_modules`, Playwright
browsers, and the executor job's Claude Code CLI. Dependency install steps are
skipped only on exact cache hits; partial restore-key matches still run install
commands to reconcile dependencies before saving a fresh cache.

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
