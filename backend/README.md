<!--
SPDX-FileCopyrightText: 2025 Weibo, Inc.

SPDX-License-Identifier: Apache-2.0
-->

### Installation Steps

1. Clone the repository
```bash
cd backend
```

2. Create virtual environment and install dependencies
```bash
python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
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

5. Run development server
```bash
uvicorn app.main:app --reload
```

## API Documentation
After starting the service, visit: http://localhost:8000/api/docs