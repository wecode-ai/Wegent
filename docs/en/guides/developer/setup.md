# 💻 Development Setup

This document provides detailed instructions on setting up a local development environment for Wegent.

---

## 📋 Prerequisites

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

> **Note**: Database tables and initial data will be created automatically on first backend startup, no need to execute SQL scripts manually.

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
pip install -r requirements.txt
```

#### Configure Environment Variables

```bash
# Copy environment template
cp .env.example .env

# Edit .env file
# Main configuration items:
# DATABASE_URL=mysql+pymysql://task_user:task_password@localhost:3306/task_manager
# REDIS_URL=redis://127.0.0.1:6379/0
# PASSWORD_KEY=your-password-key-here
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
│   ├── core/            # Core configuration
│   ├── db/              # Database connection
│   ├── models/          # SQLAlchemy models
│   ├── repository/      # Data access layer
│   ├── schemas/         # Pydantic schemas
│   └── services/        # Business logic layer
├── init_data/           # YAML initialization data
└── requirements.txt     # Python dependencies
```

For more details, see [Backend Development Guide](./backend-dev.md).

---

### 4️⃣ Frontend Service Development

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

For more details, see [Frontend Development Guide](./frontend-dev.md).

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
pip install -r requirements.txt
```

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

For more details, see [Executor Development Guide](./executor-dev.md).

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
cd frontend

# Run tests
npm test

# Run and watch for changes
npm run test:watch

# Generate coverage report
npm run test:coverage
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

1. Check the [Troubleshooting](../../troubleshooting.md) section
2. Search [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
3. Read related documentation:
   - [YAML Specification](../../reference/yaml-specification.md)
   - [Core Concepts](../../concepts/core-concepts.md)
4. Create a new Issue with detailed information

---

## 🔗 Related Resources

- [Backend Development](./backend-dev.md) - Detailed backend development guide
- [Frontend Development](./frontend-dev.md) - Detailed frontend development guide
- [Executor Development](./executor-dev.md) - Detailed executor development guide
- [Testing](./testing.md) - Testing guide
- [Contributing](../../contributing/how-to-contribute.md) - How to contribute to Wegent

---

<p align="center">Happy coding! 🚀</p>
