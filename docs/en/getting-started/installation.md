# 📦 Installation Guide

This guide provides detailed installation and configuration instructions for the Wegent platform, including system requirements, installation steps, and configuration options.

---

## 📋 System Requirements

### Hardware Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| **CPU** | 2 cores | 4 cores or more |
| **Memory** | 4 GB | 8 GB or more |
| **Storage** | 20 GB | 50 GB or more |
| **Network** | Stable internet connection | - |

### Software Requirements

#### Required Software

- **Docker**: 20.10+
- **Docker Compose**: 2.0+
- **Git**: 2.0+

#### Optional Software (for development)

- **Python**: 3.10+
- **Node.js**: 18+
- **MySQL**: 8.0+
- **Redis**: 7+

---

## 🚀 Installation Methods

Wegent supports two main installation methods:

### Method 1: Docker Compose (Recommended)

Suitable for quick deployment and production environments.

### Method 2: Source Installation

Suitable for development and custom deployments.

---

## 📦 Method 1: Docker Compose Installation

### Step 1: Clone the Repository

```bash
# Clone Wegent repository
git clone https://github.com/wecode-ai/wegent.git

# Enter project directory
cd wegent
```

### Step 2: Configure Environment Variables

```bash
# Copy environment template
cp .env.example .env

# Edit .env file
vim .env  # or use another editor
```

#### Key Environment Variables

```bash
# MySQL Configuration
MYSQL_ROOT_PASSWORD=your_root_password
MYSQL_DATABASE=task_manager
MYSQL_USER=task_user
MYSQL_PASSWORD=your_password

# Redis Configuration
REDIS_PASSWORD=your_redis_password  # Optional

# Backend Configuration
PASSWORD_KEY=your-password-key-here
DATABASE_URL=mysql+pymysql://task_user:your_password@mysql:3306/task_manager

# Attachment Storage Configuration (Optional)
# Default: mysql (stores files in database)
# Options: mysql, s3, minio
ATTACHMENT_STORAGE_BACKEND=mysql

# S3/MinIO Configuration (only required when using s3 or minio backend)
# ATTACHMENT_S3_ENDPOINT=https://s3.amazonaws.com  # or http://minio:9000
# ATTACHMENT_S3_ACCESS_KEY=your_access_key
# ATTACHMENT_S3_SECRET_KEY=your_secret_key
# ATTACHMENT_S3_BUCKET=attachments
# ATTACHMENT_S3_REGION=us-east-1
# ATTACHMENT_S3_USE_SSL=true

# Frontend Configuration
# Runtime variables (recommended, can be changed without rebuilding)
# Set via docker-compose.yml environment section
# RUNTIME_INTERNAL_API_URL=http://backend:8000
# RUNTIME_SOCKET_DIRECT_URL=http://backend:8000
# Legacy (deprecated): NEXT_PUBLIC_API_URL=http://localhost:8000

# Executor Manager Configuration
EXECUTOR_IMAGE=ghcr.io/wecode-ai/wegent-executor:latest
EXECUTOR_WORKSPCE=/path/to/workspace
```

### Step 3: Start Services

```bash
# Start all services
docker-compose up -d

# Check service status
docker-compose ps

# View logs
docker-compose logs -f
```

### Step 4: Verify Installation

Wait for services to start completely (about 30 seconds). Database tables and initial data will be created automatically.

Visit the following URLs to verify installation:

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:8000
- **API Documentation**: http://localhost:8000/api/docs
- **Executor Manager**: http://localhost:8001

### Step 5: Configure GitHub Integration (Optional)

1. Visit http://localhost:3000
2. Follow on-screen instructions to configure GitHub Personal Access Token
3. Required token permissions:
   - `repo` - Full repository access
   - `workflow` - Workflow permissions

---

## 💻 Method 2: Source Installation

### Step 1: Install Required Software

#### On Ubuntu/Debian

```bash
# Update package list
sudo apt-get update

# Install Python
sudo apt-get install python3.10 python3-pip python3-venv

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install MySQL
sudo apt-get install mysql-server

# Install Redis
sudo apt-get install redis-server

# Install Git
sudo apt-get install git
```

#### On macOS

```bash
# Install using Homebrew
brew install python@3.10 node@18 mysql redis git
```

### Step 2: Setup Database

```bash
# Start MySQL
sudo systemctl start mysql  # Linux
# or
brew services start mysql  # macOS

# Login to MySQL
mysql -u root -p

# Create database and user
CREATE DATABASE task_manager;
CREATE USER 'task_user'@'localhost' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON task_manager.* TO 'task_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### Step 3: Setup Redis

```bash
# Start Redis
sudo systemctl start redis  # Linux
# or
brew services start redis  # macOS

# Verify Redis
redis-cli ping  # Should return PONG
```

### Step 4: Install Backend

```bash
# Enter backend directory
cd backend

# Create virtual environment
python3 -m venv venv

# Activate virtual environment
source venv/bin/activate  # Linux/macOS
# venv\Scripts\activate  # Windows

# Install dependencies
uv sync

# Configure environment variables
cp .env.example .env
vim .env  # Edit configuration

# Create database (tables and initial data will be created automatically on first startup)
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS task_manager CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# Run backend service
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### Step 5: Install Frontend

In a new terminal:

```bash
# Enter frontend directory
cd frontend

# Install dependencies
npm install

# Configure environment variables
cp .env.local.example .env.local
vim .env.local  # Edit configuration

# Run development server
npm run dev
```

### Step 6: Install Executor Manager

[Local Development](/executor_manager/README.md)

---

## ⚙️ Advanced Configuration

### Custom Ports

Modify `docker-compose.yml` or environment variables to customize ports:

```yaml
# docker-compose.yml
services:
  frontend:
    ports:
      - "3001:3000"  # Change to 3001
  backend:
    ports:
      - "8001:8000"  # Change to 8001
```

### Configure HTTPS

For production environments, use Nginx reverse proxy to configure HTTPS:

```bash
# Install Nginx
sudo apt-get install nginx

# Configure reverse proxy
sudo vim /etc/nginx/sites-available/wegent
```

Example Nginx configuration:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api {
        proxy_pass http://localhost:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Data Persistence

Ensure Docker volumes are configured correctly for data persistence:

```yaml
# docker-compose.yml
volumes:
  mysql_data:
  redis_data:
  workspace_data:

services:
  mysql:
    volumes:
      - mysql_data:/var/lib/mysql

  redis:
    volumes:
      - redis_data:/data
```

---

## 🔍 Verify Installation

### Check Service Status

```bash
# Docker Compose method
docker-compose ps

# Should see all services in Up status
```

### Test API

```bash
# Test backend API
curl http://localhost:8000/api/health

# Should return: {"status": "ok"}
```

### Test Frontend

Visit http://localhost:3000 in your browser, you should see the Wegent login page.

---

## 🐛 Common Issues

### Issue 1: Port Already in Use

**Error**: `Error: Port 3000 is already in use`

**Solution**:
```bash
# Find process using the port
lsof -i :3000

# Kill the process
kill -9 <PID>

# Or modify port configuration
```

### Issue 2: MySQL Connection Failed

**Error**: `Can't connect to MySQL server`

**Solution**:
```bash
# Ensure MySQL is running
docker-compose ps mysql
# or
sudo systemctl status mysql

# Check connection configuration
mysql -u task_user -p -h localhost task_manager
```

### Issue 3: Redis Connection Failed

**Error**: `Error connecting to Redis`

**Solution**:
```bash
# Ensure Redis is running
redis-cli ping

# Check Redis configuration
docker-compose logs redis
```

### Issue 4: Docker Image Pull Failed

**Error**: `Error pulling image`

**Solution**:
```bash
# Use mirror registry
# Edit /etc/docker/daemon.json
{
  "registry-mirrors": [
    "https://docker.mirrors.ustc.edu.cn",
    "https://hub-mirror.c.163.com"
  ]
}

# Restart Docker
sudo systemctl restart docker
```

---

## 🔄 Upgrade and Update

### Upgrade to Latest Version

```bash
# Pull latest code
git pull origin main

# Rebuild images
docker-compose build

# Restart services
docker-compose down
docker-compose up -d

# Update database
docker-compose exec backend python -m alembic upgrade head
```

---

## 🗑️ Uninstall

### Docker Compose Method

```bash
# Stop and remove containers
docker-compose down

# Remove volumes (will delete all data)
docker-compose down -v

# Remove images
docker-compose down --rmi all
```

### Source Installation Method

```bash
# Stop all services
# Then delete project directory
rm -rf wegent

# Delete database
mysql -u root -p
DROP DATABASE task_manager;
DROP USER 'task_user'@'localhost';
```

---

## 📞 Get Help

If you encounter installation issues:

1. Check [Troubleshooting Guide](../troubleshooting.md)
2. Search [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
3. View [FAQ](../faq.md)
4. Create a new Issue to report problems

---

## 🔗 Next Steps

After installation, you can:

- [Quick Start](./quick-start.md) - Run your first task
- [Core Concepts](../concepts/core-concepts.md) - Learn Wegent's core concepts
- [Creating Ghosts](../guides/user/creating-ghosts.md) - Create your first agent
- [Development Guide](../guides/developer/setup.md) - Setup development environment

---

<p align="center">Installation complete! Start exploring Wegent! 🎉</p>
