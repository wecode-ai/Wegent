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
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS task_manager CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# The default hybrid launcher initializes MySQL through Rust on development startup.
# To apply pending migrations manually from this directory:
cargo run --manifest-path ../backend-rs/Cargo.toml -- --env-file .env db upgrade
```

**Database Migration System:**
- The Rust executable manages MySQL in hybrid mode, preserving the existing Alembic revision IDs and version table.
- Development startup applies pending migrations when `DB_AUTO_MIGRATE=True`.
- Fresh databases use the complete current schema; existing databases follow the revision graph.
- Production migrations are explicit. MySQL DDL may commit implicitly; rollback is not guaranteed after a failure.
- Python-only debugging retains its Alembic startup path. The hybrid launcher sets `DB_INITIALIZATION_OWNER=rust` to prevent duplicate initialization.
- See the [Rust MySQL migration guide](../docs/en/wegent/developer-guide/rust-database-migrations.md).

**Initial Data Loading:**
- Canonical YAML resources and Skills live in [backend-rs/init_data](../backend-rs/init_data/README.md).
- Existing resources are preserved; versioned built-in Skills retain their update rules.

## Database Migrations

Run the native database commands from `backend-rs`:

```bash
cargo run -- --env-file ../backend/.env db status
cargo run -- --env-file ../backend/.env db upgrade
cargo run -- --env-file ../backend/.env db downgrade -1
```

New native migrations must update the revision asset, embedded registration and latest complete schema together. Keep applied migrations immutable. The legacy Alembic files remain the compatibility reference for Python-only operation.

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