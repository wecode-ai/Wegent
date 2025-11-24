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
# Create database (schema will be created automatically by SQLAlchemy on first startup)
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS task_manager CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

**Note on Initialization:**
- Database tables are created automatically by SQLAlchemy on first startup
- Initial data (admin user, default resources) is loaded from YAML files in `init_data/`
- See `init_data/README.md` for details on YAML-based initialization
- User modifications are preserved across restarts (create-only mode)

5. Run development server
```bash
uvicorn app.main:app --reload
```

## API Documentation
After starting the service, visit: http://localhost:8000/api/docs