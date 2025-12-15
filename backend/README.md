<!--
SPDX-FileCopyrightText: 2025 Weibo, Inc.

SPDX-License-Identifier: Apache-2.0
-->
### Quick Start (Recommended)

Use the one-click startup script with uv for automatic setup:

```bash
cd backend
./start.sh
```

The script will automatically:
- Check Python version (3.10+ required)
- Install uv if not present (fast Python package manager)
- Install dependencies with uv
- Configure environment variables
- Check database and Redis connections
- Set PYTHONPATH
- Start the development server

**Custom Port Usage:**
```bash
# Use custom backend port
./start.sh --port 8080

# Use custom database and Redis ports
./start.sh --port 8080 --db-port 3307 --redis-port 6380

# View all options
./start.sh --help
```

**Port Validation:**
- The script validates all port numbers (1-65535)
- Checks if ports are already in use
- Provides clear error messages with troubleshooting hints

### Manual Installation Steps (uv-based)

If you prefer manual setup:

**Prerequisites:**
- Python 3.10+
- [uv](https://github.com/astral-sh/uv) installed

1. Clone the repository
```bash
cd backend
```

2. Install dependencies with uv
```bash
uv sync
```

3. Configure environment variables
Copy `.env.example` to `.env` and modify the configuration
```bash
cp .env.example .env
```

4. Initialize database
```bash
# Create database
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS task_manager CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# Run database migrations (development mode - automatic on startup)
# Or manually run:
alembic upgrade head
```
```

**Database Migration System:**
- Wegent uses Alembic for database schema version control
- In development mode (`ENVIRONMENT=development`), migrations run automatically on startup
- In production mode, migrations must be run manually for safety
- See `alembic/README` for detailed migration commands

**Initial Data Loading:**
- Initial data (admin user, default resources) is loaded from YAML files in `init_data/`
- See `init_data/README.md` for details on YAML-based initialization
- User modifications are preserved across restarts (create-only mode)

## Database Migrations

Wegent uses Alembic for database schema management. This provides:
- Version control for database schema changes
- Safe upgrade and rollback capabilities
- Automatic migration in development, manual control in production

### Common Migration Commands

```bash
# View current migration status
alembic current

# View migration history
alembic history

# Apply all pending migrations
alembic upgrade head

# Rollback one migration
alembic downgrade -1

# Create a new migration after model changes
alembic revision --autogenerate -m "description"
```

For detailed migration documentation, see `alembic/README`.

5. Set PYTHONPATH and run development server
```bash
# From project root (Wegent directory)
export PYTHONPATH=$(pwd):$PYTHONPATH

# Navigate to backend and start
cd backend
source .venv/bin/activate  # Activate uv's virtual environment
uvicorn app.main:app --reload
```

## API Documentation
After starting the service, visit: http://localhost:8000/api/docs