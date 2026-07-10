---
sidebar_position: 2
---

# 💻 Development Setup

This document provides detailed instructions on setting up a local development environment for Wegent.

---

## 📋 Prerequisites

Before starting, ensure your development environment has the following software installed:

### Required Software

- **Python 3.10+**: For backend service, Executor, and Executor Manager
- **Node.js 20+**: For frontend development and tests
- **MySQL 8.0+**: Database service
- **Redis 7+**: Cache service
- **Docker & Docker Compose**: For containerized deployment and development
- **Git**: Version control

### Recommended Tools

- **Visual Studio Code**: Code editor
- **Postman** or **curl**: API testing
- **MySQL Workbench**: Database management

---

## 🚀 Quick Experience

If you just want to quickly experience Wegent, use Docker Compose:

```bash
# Clone the repository
git clone https://github.com/wecode-ai/wegent.git
cd wegent

# Start all services
docker-compose up -d

# Access the web interface
# http://localhost:3000
```

This will start all required services:

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:8000
- **API Documentation**: http://localhost:8000/api/docs
- **MySQL**: localhost:3306
- **Redis**: localhost:6379
- **Executor Manager**: http://localhost:8001

---

## 🔧 Local Development Setup

If you need to modify code and develop, follow these steps to set up your local development environment.

### 1️⃣ Database Configuration

#### Run MySQL with Docker

```bash
docker run -d \
  --name wegent-mysql \
  -e MYSQL_ROOT_PASSWORD=123456 \
  -e MYSQL_DATABASE=task_manager \
  -e MYSQL_USER=task_user \
  -e MYSQL_PASSWORD=task_password \
  -p 3306:3306 \
  mysql:9.4
```

#### Or Use Local MySQL

```bash
# Login to MySQL
mysql -u root -p

# Create database
CREATE DATABASE task_manager;

# Create user
CREATE USER 'task_user'@'localhost' IDENTIFIED BY 'task_password';

# Grant privileges
GRANT ALL PRIVILEGES ON task_manager.* TO 'task_user'@'localhost';
FLUSH PRIVILEGES;
```

> **Note**: Database tables and initial data will be created automatically on first backend startup, no need to execute SQL scripts manually. Initialization creates the `admin` administrator account without a default password; the first visit to the login page must complete the administrator password setup flow.

---

### 2️⃣ Redis Configuration

#### Run Redis with Docker

```bash
docker run -d \
  --name wegent-redis \
  -p 6379:6379 \
  redis:7
```

#### Or Use Local Redis

```bash
# macOS
brew install redis
brew services start redis

# Ubuntu/Debian
sudo apt-get install redis-server
sudo systemctl start redis

# Verify Redis is running
redis-cli ping
# Should return PONG
```

---

### 3️⃣ Backend Service Development

The backend service is a RESTful API service based on FastAPI.

#### Install Dependencies

```bash
cd backend

# Create virtual environment
python3 -m venv venv

# Activate virtual environment
# macOS/Linux:
source venv/bin/activate
# Windows:
# venv\Scripts\activate

# Install dependencies
uv sync
```

#### Configure Environment Variables

```bash
# Copy environment template
cp .env.example .env

# Edit .env file
# Main configuration items:
# DATABASE_URL=mysql+pymysql://task_user:task_password@localhost:3306/task_manager
# REDIS_URL=redis://127.0.0.1:6379/0
# CHECK_SYSTEM_INITIALIZATION_STATUS=True
# PASSWORD_KEY=your-password-key-here
# EXECUTOR_DELETE_TASK_URL=http://localhost:8001/executor-manager/executor/delete
```

`CHECK_SYSTEM_INITIALIZATION_STATUS` is enabled by default. When enabled, the backend loads the first-run administrator password setup state into memory at startup, and the login page receives the `ADMIN_PASSWORD_SETUP_REQUIRED` error code through the `/users/me` handshake. Set it to `False` for deployments that must skip this check.

#### Run Development Server

```bash
# Run with uvicorn, hot reload enabled
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Access API documentation:

- Swagger UI: http://localhost:8000/api/docs
- ReDoc: http://localhost:8000/api/redoc

#### Backend Directory Structure

```
backend/
├── app/
│   ├── api/              # API routes
│   ├── core/            # Core configuration
│   ├── db/              # Database connection
│   ├── models/          # SQLAlchemy models
│   ├── repository/      # Data access layer
│   ├── schemas/         # Pydantic schemas
│   └── services/        # Business logic layer
├── init_data/           # YAML initialization data
└── pyproject.toml       # Python dependencies
```

---

### 4️⃣ Frontend Service Development

The frontend is a React application based on Next.js 15.

#### Install Dependencies

```bash
cd wegent

# Install pnpm workspace dependencies
pnpm install
```

#### Configure Environment Variables

```bash
# Copy environment template
cp .env.local.example .env.local

# Edit .env.local file
# Main configuration items (runtime variables, can be changed without rebuilding):
# RUNTIME_INTERNAL_API_URL=http://localhost:8000  # Server-side proxy URL
# RUNTIME_SOCKET_DIRECT_URL=http://localhost:8000 # WebSocket connection URL
# RUNTIME_WEWORK_CODE_URL=https://wework.example.com/coding  # Optional: route coding entry points to Wework
# RUNTIME_ENABLE_PROJECT_WORKSPACE=false          # Enable project workspace UI
# RUNTIME_PROJECT_WORKSPACE_WHITELIST=admin       # Allowed user_names, empty means all users
# Legacy (deprecated): NEXT_PUBLIC_API_URL=http://localhost:8000
# NEXT_PUBLIC_USE_MOCK_API=false
# NEXT_PUBLIC_LOGIN_MODE=all
# I18N_LNG=en
```

> **Note**: The frontend now uses `RUNTIME_INTERNAL_API_URL` and `RUNTIME_SOCKET_DIRECT_URL` instead of `NEXT_PUBLIC_API_URL`. Runtime variables can be changed without rebuilding the application. When `RUNTIME_WEWORK_CODE_URL` is empty, coding entry points open `/chat?agent=code`; when configured, the menu shows **WeWork** and opens that URL. This variable has no `NEXT_PUBLIC_*` fallback.

#### Run Development Server

```bash
# Start development server
pnpm --filter wecode-ai-assistant run dev
```

Access application: http://localhost:3000

#### Other Commands

```bash
# Lint code
pnpm --filter wecode-ai-assistant run lint

# Format code
pnpm --filter wecode-ai-assistant run format

# Production build
pnpm --filter wecode-ai-assistant run build

# Run production version
pnpm --filter wecode-ai-assistant run start
```

#### Wework and Local Rust Build Cache

The Wework macOS development scripts isolate Cargo targets by Git worktree. This prevents Cargo's path-sensitive fingerprints and unhashed binaries from overwriting each other during parallel debugging. On the first `pnpm --dir wework run dev:mac`, the script installs `sccache` with Homebrew when it is missing, then reuses matching dependency and source compilation outputs across worktrees.

- `pnpm --dir wework run dev:mac`, `pnpm --dir wework run build:mac`, the development executor sidecar, and `executor/local.sh build` use `$XDG_CACHE_HOME/wegent/cargo-target/<component>/worktrees/<worktree>`, or `~/.cache/wegent/cargo-target/...` when `XDG_CACHE_HOME` is not set.
- When `sccache` is available, the scripts set `RUSTC_WRAPPER` automatically and disable Cargo incremental compilation, which is incompatible with shared compiler caching.
- Set `WEGENT_CARGO_TARGET_ROOT=/path/to/cache` to choose another target cache root.
- Set `WEGENT_DISABLE_SHARED_CARGO_TARGET=1` to use Cargo's repository-local default `target/`.
- Set `WEGENT_DISABLE_SCCACHE=1` to skip automatic installation and disable `sccache`.
- Explicit `CARGO_TARGET_DIR` and `RUSTC_WRAPPER` values are always preserved.

---

### 5️⃣ Executor Manager Development

Executor Manager is responsible for managing and scheduling Executor containers.

#### Install Dependencies

```bash
cd executor_manager

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
uv sync
```

#### Run Development Server

```bash
# Set environment variables
export TASK_API_DOMAIN=http://localhost:8000
export CALLBACK_HOST=http://localhost:8001
export MAX_CONCURRENT_TASKS=5
export EXECUTOR_IMAGE=ghcr.io/wecode-ai/wegent-executor:latest
export EXECUTOR_WORKSPACE=${HOME}/wecode-bot

# Run service
python main.py
```

---

## 📂 Project Structure

Complete project structure:

```
wegent/
├── backend/                 # FastAPI backend service
├── frontend/                # Next.js frontend application
├── executor/                # Task executor
├── executor_manager/        # Executor manager
├── shared/                  # Shared code and models
├── docker/                  # Docker configurations
├── docs/                    # Documentation
└── docker-compose.yml       # Docker Compose configuration
```

---

## 🔬 Testing

Wegent provides comprehensive testing framework coverage across all core modules.

### Backend Testing

```bash
cd backend

# Run all tests
pytest

# Run specific test module
pytest tests/core/

# Run with coverage report
pytest --cov=app --cov-report=html

# Run only unit tests
pytest -m unit

# Run only integration tests
pytest -m integration
```

### Frontend Testing

```bash
cd wegent

# Run tests
pnpm --filter wecode-ai-assistant test

# Run and watch for changes
pnpm --filter wecode-ai-assistant run test:watch

# Generate coverage report
pnpm --filter wecode-ai-assistant run test:coverage
```

### Executor and Shared Module Testing

```bash
# Executor tests
cd executor
pytest tests/ --cov=agents

# Executor Manager tests
cd executor_manager
pytest tests/ --cov=executors

# Shared utilities tests
cd shared
pytest tests/ --cov=utils
```

### Complete Testing Guide

For detailed testing framework documentation, best practices, and CI/CD configuration, see:

- 📖 [Complete Testing Guide](./testing.md) - Test framework documentation, Fixtures, Mocking strategies, and more

---

## 🐛 Debugging Tips

### Backend Debugging

```bash
# Enable verbose logging
export LOG_LEVEL=DEBUG
uvicorn app.main:app --reload --log-level debug
```

### Frontend Debugging

In browser developer tools, check:

- Console: JavaScript errors and logs
- Network: API requests and responses
- React DevTools: Component state and performance

### Executor Debugging

```bash
# View container logs
docker logs -f <executor-container-id>

# Enter container for debugging
docker exec -it <executor-container-id> /bin/bash
```

---

## 📞 Get Help

If you encounter issues:

1. Check the [Troubleshooting](../troubleshooting.md) section
2. Search [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
3. Read related documentation:
   - [YAML Specification](../reference/yaml-specification.md)
   - [Core Concepts](../concepts/core-concepts.md)
4. Create a new Issue with detailed information

---

## 🔗 Related Resources

- [Testing](./testing.md) - Testing guide

---

<p align="center">Happy coding! 🚀</p>
