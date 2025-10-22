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
mysql -u xxx -p < init.sql
```

5. Run development server
```bash
uvicorn app.main:app --reload
```

## API Documentation
After starting the service, visit: http://localhost:8000/api/docs