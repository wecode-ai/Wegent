# Integration Tests

This directory contains Playwright integration tests for Wegent that run against real environments.

## Quick Start

Use the `run-tests.sh` script to automatically handle everything:

```bash
cd tests

# Run tests (auto-installs dependencies, auto-prompts for login if needed)
./run-tests.sh              # Headless mode (default)
./run-tests.sh -h           # Headed mode (see browser)
./run-tests.sh -d           # Debug mode
./run-tests.sh -a           # Force re-login
./run-tests.sh --help       # Show all options
```

## Manual Setup

1. Install dependencies:
   ```bash
   cd tests
   npm install
   npx playwright install chromium
   ```

2. Setup authentication (QR code login):
   ```bash
   npm run setup-auth
   ```
   This opens a browser - scan the QR code to login. The session will be saved for reuse.

## Running Tests

```bash
# Run all tests (headless)
npm test

# Run tests with browser visible
npm run test:headed

# Run tests in debug mode
npm run test:debug
```

## Configuration

- Default test URL: `http://localhost:3000`
- Override with: `./run-tests.sh http://localhost:3002`
- Or use environment variable: `TEST_BASE_URL=http://localhost:3002 ./run-tests.sh`

## Test Files

- `specs/chat-flow.spec.ts` - Chat message flow test

## Script Options

| Option | Description |
|--------|-------------|
| `-h, --headed` | Run tests with browser UI visible |
| `-l, --headless` | Run tests without browser UI (default) |
| `-d, --debug` | Run tests in debug mode |
| `-a, --auth` | Force re-authentication (re-scan QR code) |
| `-i, --install` | Force reinstall dependencies |
| `URL` | Target URL to test (e.g., `http://localhost:3002`) |
| `--help` | Show help message |

### Examples

```bash
# Test localhost (default)
./run-tests.sh

# Test specific URL
./run-tests.sh http://localhost:3002

# Test with browser visible
./run-tests.sh -h http://localhost:3002

# Using environment variable
TEST_BASE_URL=http://localhost:3001 ./run-tests.sh
```
