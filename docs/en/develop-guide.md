<!--
SPDX-FileCopyrightText: 2025 Weibo, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Wegent Development Guide

This document provides detailed instructions on setting up a local development environment for Wegent, including configuration and running methods for all service components.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Local Development Setup](#local-development-setup)
  - [1. Database Configuration](#1-database-configuration)
  - [2. Redis Configuration](#2-redis-configuration)
  - [3. Backend Service Development](#3-backend-service-development)
  - [4. Frontend Service Development](#4-frontend-service-development)
  - [5. Executor Manager Development](#5-executor-manager-development)
  - [6. Executor Development](#6-executor-development)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

## Prerequisites

Before starting, ensure your development environment has the following software installed:

### Required Software

- **Python 3.9+**: For backend service, Executor, and Executor Manager
- **Node.js 18+**: For frontend development
- **MySQL 8.0+**: Database service
- **Redis 7+**: Cache service
- **Docker & Docker Compose**: For containerized deployment and development
- **Git**: Version control

### Recommended Tools

- **Visual Studio Code**: Code editor
- **Postman** or **curl**: API testing
- **MySQL Workbench**: Database management

## Quick Start

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

## Local Development Setup

If you need to modify code and develop, follow these steps to set up your local development environment.

### 1. Database Configuration

#### Run MySQL with Docker

```bash
docker run -d \
  --name wegent-mysql \
  -e MYSQL_ROOT_[INFORMATION_DATA_ID_03]=123456 \
  -e MYSQL_DATABASE=task_manager \
  -e MYSQL_USER=task_user \
  -e MYSQL_[INFORMATION_DATA_ID_03]=task_[INFORMATION_DATA_ID_04] \
  -p 3306:3306 \
  mysql:9.4
```

#### Or Use Local MySQL

If you already have a local MySQL instance:

```bash
# Login to MySQL
mysql -u root -p

# Create database
CREATE DATABASE task_manager;

# Create user
CREATE USER 'task_user'@'localhost' IDENTIFIED BY 'task_[INFORMATION_DATA_ID_04]';

# Grant privileges
GRANT ALL PRIVILEGES ON task_manager.* TO 'task_user'@'localhost';
FLUSH PRIVILEGES;
```

#### Initialize Database Tables

```bash
cd backend
mysql -u task_user -p task_manager < init.sql
```

### 2. Redis Configuration

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

### 3. Backend Service Development

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
pip install -r requirements.txt
```

#### Configure Environment Variables

```bash
# Copy environment template
cp .env.example .env

# Edit .env file
# Main configuration items:
# DATABASE_URL=mysql+pymysql://task_user:task_[INFORMATION_DATA_ID_04]@localhost:3306/task_manager
# REDIS_URL=redis://127.0.0.1:6379/0
# [INFORMATION_DATA_ID_05]_KEY=your-[INFORMATION_DATA_ID_06]-key-here
# EXECUTOR_DELETE_TASK_URL=http://localhost:8001/executor-manager/executor/delete
```

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
│   │   ├── auth/        # Authentication endpoints
│   │   ├── bots/        # Bot management endpoints
│   │   ├── ghosts/      # Ghost management endpoints
│   │   ├── models/      # Model management endpoints
│   │   ├── shells/      # Shell management endpoints
│   │   ├── teams/       # Team management endpoints
│   │   └── tasks/       # Task management endpoints
│   ├── core/            # Core configuration
│   ├── db/              # Database connection
│   ├── models/          # SQLAlchemy models
│   ├── repository/      # Data access layer
│   ├── schemas/         # Pydantic schemas
│   └── services/        # Business logic layer
├── init.sql             # Database initialization script
└── requirements.txt     # Python dependencies
```

### 4. Frontend Service Development

The frontend is a React application based on Next.js 15.

#### Install Dependencies

```bash
cd frontend

# Install npm dependencies
npm install
```

#### Configure Environment Variables

```bash
# Copy environment template
cp .env.local.example .env.local

# Edit .env.local file
# Main configuration items:
# NEXT_PUBLIC_API_URL=http://localhost:8000
# NEXT_PUBLIC_USE_MOCK_API=false
# NEXT_PUBLIC_LOGIN_MODE=all
# I18N_LNG=en
```

#### Run Development Server

```bash
# Start development server
npm run dev
```

Access application: http://localhost:3000

#### Other Commands

```bash
# Lint code
npm run lint

# Format code
npm run format

# Production build
npm run build

# Run production version
npm run start
```

#### Frontend Directory Structure

```
frontend/
├── src/
│   ├── app/             # Next.js app routes
│   ├── components/      # React components
│   ├── contexts/        # React Context
│   ├── hooks/           # Custom Hooks
│   ├── services/        # API services
│   ├── types/           # TypeScript type definitions
│   └── utils/           # Utility functions
├── public/              # Static assets
└── package.json         # npm dependencies
```

### 5. Executor Manager Development

Executor Manager is responsible for managing and scheduling Executor containers.

#### Install Dependencies

```bash
cd executor_manager

# Create virtual environment
python3 -m venv venv

# Activate virtual environment
source venv/bin/activate  # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

#### Configure Environment Variables

Main environment variables:
- `TASK_API_DOMAIN`: Backend API address (default: http://backend:8000)
- `MAX_CONCURRENT_TASKS`: Maximum concurrent tasks (default: 5)
- `PORT`: Service port (default: 8001)
- `CALLBACK_HOST`: Callback address (default: http://executor_manager:8001)
- `NETWORK`: Docker network name (default: wegent-network)
- `EXECUTOR_IMAGE`: Executor image name
- `EXECUTOR_PORT_RANGE_MIN`: Executor port range minimum (default: 10001)
- `EXECUTOR_PORT_RANGE_MAX`: Executor port range maximum (default: 10100)
- `EXECUTOR_WORKSPCE`: Executor workspace path

#### Run Development Server

```bash
# Set environment variables
export TASK_API_DOMAIN=http://localhost:8000
export CALLBACK_HOST=http://localhost:8001
export MAX_CONCURRENT_TASKS=5
export EXECUTOR_IMAGE=ghcr.io/wecode-ai/wegent-executor:1.0.2
export EXECUTOR_WORKSPCE=${HOME}/wecode-bot

# Run service
python main.py
```

#### Executor Manager Directory Structure

```
executor_manager/
├── clients/             # API clients
├── config/              # Configuration management
├── executors/           # Executor management logic
├── github/              # GitHub integration
├── routers/             # API routes
├── scheduler/           # Task scheduling
├── tasks/               # Task management
├── utils/               # Utility functions
└── main.py              # Entry point
```

### 6. Executor Development

Executor is a containerized service that executes AI tasks.

#### Install Dependencies

```bash
cd executor

# Create virtual environment
python3 -m venv venv

# Activate virtual environment
source venv/bin/activate  # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

#### Supported Agent Types

Executor currently supports the following agents:

1. **Claude Code**: Based on Claude Agent SDK
2. **Agno**: Based on Agno framework (experimental)

#### Configure Agent

Each agent requires different environment variable configurations:

**Claude Code Agent:**
```bash
export ANTHROPIC_MODEL=openrouter,anthropic/claude-sonnet-4
export ANTHROPIC_AUTH_TOKEN=sk-xxxxxx
export ANTHROPIC_BASE_URL=http://xxxxx
export ANTHROPIC_SMALL_FAST_MODEL=openrouter,anthropic/claude-3.5-haiku
```

**Agno Agent:**
```bash
# Configuration to be added
```

#### Run Executor (Local Testing)

```bash
# Set necessary environment variables
export WORKSPACE_PATH=/path/to/workspace
export CALLBACK_URL=http://localhost:8001/callback

# Run service
uvicorn main:app --host 0.0.0.0 --port 10001 --reload
```

#### Executor Directory Structure

```
executor/
├── agents/              # Agent implementations
│   ├── claude_code/    # Claude Code Agent
│   ├── agno/           # Agno Agent
│   ├── base.py         # Agent base class
│   └── factory.py      # Agent factory
├── callback/            # Callback handling
├── config/              # Configuration management
├── services/            # Service layer
├── tasks/               # Task processing
├── utils/               # Utility functions
└── main.py              # Entry point
```

## Project Structure

Complete project structure:

```
wegent/
├── backend/                 # FastAPI backend service
│   ├── app/                # Application code
│   ├── init.sql            # Database initialization
│   └── requirements.txt    # Python dependencies
├── frontend/                # Next.js frontend application
│   ├── src/                # Source code
│   ├── public/             # Static assets
│   └── package.json        # npm dependencies
├── executor/                # Task executor
│   ├── agents/             # Agent implementations
│   └── requirements.txt    # Python dependencies
├── executor_manager/        # Executor manager
│   ├── executors/          # Executor management
│   └── requirements.txt    # Python dependencies
├── shared/                  # Shared code and models
├── docker/                  # Docker configurations
│   ├── backend/            # Backend Dockerfile
│   ├── frontend/           # Frontend Dockerfile
│   ├── executor/           # Executor Dockerfile
│   └── executor_manager/   # Executor Manager Dockerfile
├── docs/                    # Documentation
│   ├── zh/                 # Chinese documentation
│   └── en/                 # English documentation
├── docker-compose.yml       # Docker Compose configuration
└── README.md               # Project description
```

## Development Workflow

### 1. Create Feature Branch

```bash
# Create new branch from main
git checkout -b feature/your-feature-name

# Or create from develop branch
git checkout develop
git checkout -b feature/your-feature-name
```

### 2. Development

- Follow code standards and best practices
- Write clear commit messages
- Keep code clean and maintainable

### 3. Run Tests

```bash
# Backend tests
cd backend
python -m pytest

# Frontend tests
cd frontend
npm test
```

### 4. Commit Code

```bash
# Add changes
git add .

# Commit changes
git commit -m "feat: add new feature"

# Push to remote
git push origin feature/your-feature-name
```

### 5. Create Pull Request

Create a Pull Request on GitHub or GitLab and wait for code review.

## Testing

### Backend Testing

```bash
cd backend

# Run all tests
python -m pytest

# Run specific test file
python -m pytest tests/test_auth.py

# Run with coverage report
python -m pytest --cov=app --cov-report=html
```

### Frontend Testing

```bash
cd frontend

# Run tests
npm test

# Run and watch for changes
npm test -- --watch

# Generate coverage report
npm test -- --coverage
```

### Integration Testing

```bash
# Run complete environment with docker-compose
docker-compose up -d

# Run integration test scripts
# TODO: Add integration test scripts
```

## Troubleshooting

### 1. Database Connection Failed

**Issue**: `sqlalchemy.exc.OperationalError: (pymysql.err.OperationalError) (2003, "Can't connect to MySQL server")`

**Solution**:
- Ensure MySQL service is running
- Check if `DATABASE_URL` configuration is correct
- Verify database user permissions

### 2. Redis Connection Failed

**Issue**: `redis.exceptions.ConnectionError: Error connecting to Redis`

**Solution**:
- Ensure Redis service is running
- Check `REDIS_URL` configuration
- Verify Redis port is not occupied

### 3. Frontend Cannot Connect to Backend

**Issue**: API request fails, CORS error

**Solution**:
- Ensure backend service is running
- Check `NEXT_PUBLIC_API_URL` configuration
- Verify backend CORS configuration is correct

### 4. Executor Startup Failed

**Issue**: Executor container cannot start or exits immediately

**Solution**:
- Check if Docker is running
- Verify Executor Manager configuration is correct
- View container logs: `docker logs <container-id>`
- Ensure necessary environment variables are set

### 5. Port Conflict

**Issue**: `Address already in use`

**Solution**:
```bash
# Find process using the port
lsof -i :8000  # or other port

# Kill the process
kill -9 <PID>

# Or modify service port configuration
```

### 6. Python Dependency Installation Failed

**Issue**: `pip install` fails

**Solution**:
```bash
# Upgrade pip
pip install --upgrade pip

# Use mirror source
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple

# Or use conda
conda install --file requirements.txt
```

### 7. Node.js Dependency Installation Failed

**Issue**: `npm install` fails

**Solution**:
```bash
# Clean cache
npm cache clean --force

# Remove node_modules and package-lock.json
rm -rf node_modules package-lock.json

# Reinstall
npm install

# Or use yarn
yarn install
```

### 8. Agent Not Working Properly

**Issue**: Agent encounters errors when executing tasks

**Solution**:
- Check Agent configuration (API Key, model name, etc.)
- Verify environment variables are set correctly
- View Executor logs for detailed error information
- Verify network connection and API access permissions

## Debugging Tips

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

# View environment variables
docker exec <executor-container-id> env
```

## Getting Help

If you encounter other issues:

1. Check the [Troubleshooting](#troubleshooting) section
2. Search [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
3. Read related documentation:
   - [Resource Definition Formats](resource-definition-formats.md)
   - [README](../../README.md)
4. Create a new Issue with detailed information

## Contributing Guidelines

Please refer to [CONTRIBUTING.md](../../CONTRIBUTING.md) to learn how to contribute to the Wegent project.

---

Happy coding! 🚀
