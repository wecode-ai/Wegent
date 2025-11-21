# Technology Stack Reference

This document provides a complete reference of all technologies, frameworks, libraries, and tools used in the Wegent project.

---

## 📋 Table of Contents

1. [Frontend Stack](#frontend-stack)
2. [Backend Stack](#backend-stack)
3. [Database & Cache](#database--cache)
4. [Development Tools](#development-tools)
5. [Testing Frameworks](#testing-frameworks)
6. [Infrastructure & DevOps](#infrastructure--devops)
7. [Version Requirements](#version-requirements)

---

## 🎨 Frontend Stack

### Core Framework

| Technology | Version | Purpose |
|------------|---------|---------|
| **Next.js** | 15.1.3 | React framework with App Router, SSR, and routing |
| **React** | 19.0.0 | UI library for building components |
| **TypeScript** | 5.7.3 | Type-safe JavaScript with static type checking |

**Key Features**:
- App Router architecture (`app/` directory)
- Server Components and Client Components
- File-based routing
- API routes for backend integration
- Image optimization
- Built-in CSS support

**Documentation**:
- Next.js: https://nextjs.org/docs
- React: https://react.dev
- TypeScript: https://www.typescriptlang.org/docs/

---

### UI Component Libraries

| Technology | Version | Purpose |
|------------|---------|---------|
| **shadcn/ui** | Latest | Beautifully designed components built with Radix UI |
| **Radix UI** | Various | Unstyled, accessible UI component primitives |
| **Tailwind CSS** | 3.4.16 | Utility-first CSS framework |
| **tailwindcss-animate** | 1.0.7 | Animation utilities for Tailwind |
| **tailwind-merge** | 3.4.0 | Utility for merging Tailwind CSS classes |

**Radix UI Components Used**:
- `@radix-ui/react-checkbox` (1.3.3)
- `@radix-ui/react-dialog` (1.1.15)
- `@radix-ui/react-dropdown-menu` (2.1.16)
- `@radix-ui/react-label` (2.1.8)
- `@radix-ui/react-popover` (1.1.15)
- `@radix-ui/react-radio-group` (1.3.8)
- `@radix-ui/react-scroll-area` (1.2.10)
- `@radix-ui/react-select` (2.2.6)
- `@radix-ui/react-slot` (1.2.4)
- `@radix-ui/react-switch` (1.2.6)
- `@radix-ui/react-toast` (1.2.15)
- `@radix-ui/react-tooltip` (1.2.8)

**Documentation**:
- shadcn/ui: https://ui.shadcn.com
- Radix UI: https://www.radix-ui.com
- Tailwind CSS: https://tailwindcss.com

---

### Icon Libraries

| Technology | Version | Purpose |
|------------|---------|---------|
| **lucide-react** | 0.554.0 | Beautiful & consistent icon library (primary) |
| **@heroicons/react** | 2.2.0 | Hand-crafted SVG icons by Tailwind Labs |
| **@tabler/icons-react** | 3.34.1 | Customizable open-source icons |
| **react-icons** | 5.5.0 | Popular icon pack aggregator |

**Usage Guidelines**:
- **Primary**: Use `lucide-react` for most icons
- **Secondary**: Use `@heroicons/react` for Tailwind-style icons
- **Specialty**: Use `@tabler/icons-react` for specific design needs

**Documentation**:
- lucide-react: https://lucide.dev
- Heroicons: https://heroicons.com
- Tabler Icons: https://tabler-icons.io

---

### Form Management & Validation

| Technology | Version | Purpose |
|------------|---------|---------|
| **react-hook-form** | 7.66.1 | Performant form library with easy validation |
| **zod** | 4.1.12 | TypeScript-first schema validation |
| **@hookform/resolvers** | 5.2.2 | Validation resolvers for react-hook-form |

**Features**:
- Type-safe form handling
- Built-in validation
- Minimal re-renders
- Easy error handling
- Integration with Zod schemas

**Example**:
```typescript
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const form = useForm({
  resolver: zodResolver(schema),
});
```

**Documentation**:
- react-hook-form: https://react-hook-form.com
- Zod: https://zod.dev

---

### State Management & Utilities

| Technology | Version | Purpose |
|------------|---------|---------|
| **React Hooks** | Built-in | State management with useState, useEffect, etc. |
| **class-variance-authority** | 0.7.1 | Component variant management |
| **clsx** | 2.1.1 | Utility for constructing className strings |
| **vaul** | 1.1.2 | Drawer component foundation library |

**State Management Approach**:
- Use React Hooks for local component state
- Use Context API for global state when needed
- No external state management library (Redux, Zustand) currently used

**Documentation**:
- React Hooks: https://react.dev/reference/react
- CVA: https://cva.style/docs

---

### Internationalization (i18n)

| Technology | Version | Purpose |
|------------|---------|---------|
| **i18next** | 25.5.2 | Internationalization framework |
| **react-i18next** | 15.7.3 | React integration for i18next |

**Supported Languages**:
- English (en)
- Chinese (zh)

**Usage**:
```typescript
import { useTranslation } from 'react-i18next';

function Component() {
  const { t } = useTranslation();
  return <h1>{t('welcome.title')}</h1>;
}
```

**Configuration Location**: `frontend/src/i18n/`

**Documentation**:
- i18next: https://www.i18next.com
- react-i18next: https://react.i18next.com

---

### Markdown & Rich Text

| Technology | Version | Purpose |
|------------|---------|---------|
| **react-markdown** | Latest | Render Markdown as React components |
| **@uiw/react-markdown-editor** | 6.1.4 | Markdown editor component |
| **@uiw/react-md-editor** | 4.0.8 | Simple Markdown editor |

**Use Cases**:
- Rendering task descriptions
- Chat message formatting
- Documentation display
- Code snippet rendering

**Documentation**:
- react-markdown: https://github.com/remarkjs/react-markdown

---

### Additional UI Libraries

| Technology | Version | Purpose |
|------------|---------|---------|
| **@headlessui/react** | 2.2.0 | Unstyled, accessible UI components |
| **cmdk** | 1.1.1 | Command menu component (⌘K) |
| **driver.js** | 1.3.6 | Product tour and feature highlighting |
| **react-textarea-autosize** | 8.5.9 | Auto-resizing textarea component |

**Documentation**:
- Headless UI: https://headlessui.com
- cmdk: https://cmdk.paco.me

---

## ⚙️ Backend Stack

### Core Framework

| Technology | Version | Purpose |
|------------|---------|---------|
| **FastAPI** | ≥0.68.0 | Modern, high-performance web framework |
| **Python** | 3.9+ | Programming language |
| **Uvicorn** | ≥0.15.0 | ASGI server for FastAPI |
| **Pydantic** | ≥2.0.0 | Data validation using Python type hints |
| **pydantic-settings** | ≥2.0.0 | Settings management with Pydantic |

**Key Features**:
- Automatic API documentation (Swagger/OpenAPI)
- Async/await support
- Type hints and validation
- Dependency injection
- WebSocket support

**Documentation**:
- FastAPI: https://fastapi.tiangolo.com
- Pydantic: https://docs.pydantic.dev

---

### Database & ORM

| Technology | Version | Purpose |
|------------|---------|---------|
| **SQLAlchemy** | ≥2.0.28 | SQL toolkit and ORM |
| **PyMySQL** | 1.1.0 | Pure Python MySQL driver |
| **asyncmy** | ≥0.2.9 | Async MySQL driver |
| **Alembic** | ≥1.12.0 | Database migration tool |
| **cryptography** | 41.0.5 | Cryptographic recipes and primitives |

**Database**: MySQL 9.4

**Features**:
- Async database operations
- Type-safe ORM models
- Database migrations
- Connection pooling
- Query optimization

**Example**:
```python
from sqlalchemy import Column, Integer, String
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    email = Column(String(255), unique=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
```

**Documentation**:
- SQLAlchemy: https://docs.sqlalchemy.org
- Alembic: https://alembic.sqlalchemy.org

---

### Authentication & Security

| Technology | Version | Purpose |
|------------|---------|---------|
| **python-jose** | 3.3.0 | JavaScript Object Signing and Encryption (JWT) |
| **PyJWT** | ≥2.8.0 | JSON Web Token implementation |
| **passlib** | 1.7.4 | Password hashing library |
| **bcrypt** | 4.0.1 | Modern password hashing |
| **authlib** | ≥1.2.0 | OAuth and OpenID Connect |
| **cryptography** | ≥41.0.5 | Cryptographic operations |
| **pycryptodome** | ≥3.20.0 | Cryptographic library |

**Authentication Methods**:
- JWT tokens for API authentication
- OAuth 2.0 for third-party login
- CAS (Central Authentication Service) support
- Password hashing with bcrypt

**Example**:
```python
from passlib.context import CryptContext
from jose import jwt

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Hash password
hashed = pwd_context.hash("password123")

# Create JWT token
token = jwt.encode({"sub": user_id}, SECRET_KEY, algorithm="HS256")
```

**Documentation**:
- PyJWT: https://pyjwt.readthedocs.io
- Authlib: https://docs.authlib.org

---

### HTTP Clients & Network

| Technology | Version | Purpose |
|------------|---------|---------|
| **httpx** | ≥0.19.0 | Modern async HTTP client |
| **aiohttp** | ≥3.8.0 | Async HTTP client/server framework |
| **requests** | ≥2.31.0 | Synchronous HTTP library |

**Usage**:
- **httpx**: Primary async HTTP client
- **aiohttp**: WebSocket and async HTTP operations
- **requests**: Legacy synchronous HTTP calls

**Documentation**:
- httpx: https://www.python-httpx.org
- aiohttp: https://docs.aiohttp.org

---

### Caching & Message Queue

| Technology | Version | Purpose |
|------------|---------|---------|
| **redis** | ≥4.5.0 | In-memory data structure store |

**Database**: Redis 7

**Use Cases**:
- Session management
- Task status caching
- Rate limiting
- Temporary data storage
- Executor deletion delay control

**Example**:
```python
import redis

client = redis.Redis(host='localhost', port=6379, db=0)
client.setex("task:123", 7200, "running")  # 2-hour expiration
```

**Documentation**:
- redis-py: https://redis-py.readthedocs.io

---

### Utilities & Libraries

| Technology | Version | Purpose |
|------------|---------|---------|
| **python-dotenv** | 1.0.0 | Environment variable management |
| **tenacity** | 8.2.3 | Retry library with exponential backoff |
| **pyyaml** | ≥6.0 | YAML parser and emitter |
| **structlog** | ≥23.1.0 | Structured logging |
| **python-dateutil** | ≥2.8.2 | Date/time utilities |
| **lxml** | ≥4.9.0 | XML processing (for CAS) |
| **orjson** | ≥3.9.0 | Fast JSON serialization |
| **regex** | ≥2023.8.8 | Advanced regex operations |

**Documentation**:
- structlog: https://www.structlog.org
- tenacity: https://tenacity.readthedocs.io

---

### Async Support

| Technology | Version | Purpose |
|------------|---------|---------|
| **asyncio** | ≥3.4.3 | Asynchronous I/O framework |

**Features**:
- Async/await syntax
- Concurrent task execution
- Non-blocking I/O operations
- Event loop management

**Example**:
```python
import asyncio

async def fetch_data():
    await asyncio.sleep(1)
    return "data"

async def main():
    result = await fetch_data()
    print(result)

asyncio.run(main())
```

**Documentation**:
- asyncio: https://docs.python.org/3/library/asyncio.html

---

### File Upload & Processing

| Technology | Version | Purpose |
|------------|---------|---------|
| **python-multipart** | ≥0.0.5 | Multipart form data parsing |
| **email-validator** | ≥1.1.3 | Email validation |

---

## 💾 Database & Cache

### Primary Database

| Technology | Version | Purpose |
|------------|---------|---------|
| **MySQL** | 9.4 | Relational database |

**Features**:
- ACID transactions
- Full-text search
- JSON column support
- Foreign key constraints
- Indexing and optimization

**Connection**:
- Synchronous: PyMySQL
- Asynchronous: asyncmy

---

### Cache & Session Store

| Technology | Version | Purpose |
|------------|---------|---------|
| **Redis** | 7 | In-memory cache and data store |

**Features**:
- Key-value storage
- Expiration management
- Pub/Sub messaging
- Data structures (strings, lists, sets, hashes)

---

## 🛠️ Development Tools

### Frontend Development

| Technology | Version | Purpose |
|------------|---------|---------|
| **ESLint** | 9.17.0 | JavaScript/TypeScript linter |
| **eslint-config-next** | 15.1.3 | Next.js ESLint configuration |
| **Prettier** | 3.4.2 | Code formatter |
| **Husky** | 9.1.7 | Git hooks |
| **lint-staged** | 15.2.11 | Run linters on staged files |
| **autoprefixer** | Latest | PostCSS plugin for vendor prefixes |
| **postcss** | 8.5.0 | CSS transformations |

**Commands**:
```bash
npm run lint        # Run ESLint
npm run format      # Run Prettier
```

**Configuration Files**:
- `.eslintrc.json` - ESLint rules
- `.prettierrc.json` - Prettier configuration
- `.husky/` - Git hooks

---

### Backend Development

| Technology | Version | Purpose |
|------------|---------|---------|
| **black** | ≥23.7.0 | Python code formatter |
| **isort** | ≥5.12.0 | Import statement sorter |
| **flake8** | ≥6.0.0 | Style guide enforcement |
| **mypy** | ≥1.5.0 | Static type checker |
| **python-decouple** | ≥3.8 | Environment variable separation |

**Commands**:
```bash
black .                # Format code
isort .                # Sort imports
flake8                 # Lint code
mypy .                 # Type check
```

**Configuration Files**:
- `pyproject.toml` - black, isort configuration
- `.flake8` - flake8 rules
- `mypy.ini` - mypy settings

---

### Documentation

| Technology | Version | Purpose |
|------------|---------|---------|
| **mkdocs** | ≥1.5.0 | Documentation generator |
| **mkdocs-material** | ≥9.2.0 | Material theme for MkDocs |

**Commands**:
```bash
mkdocs serve       # Run documentation server
mkdocs build       # Build static documentation
```

---

## 🧪 Testing Frameworks

### Frontend Testing

| Technology | Version | Purpose |
|------------|---------|---------|
| **Jest** | 29.7.0 | JavaScript testing framework |
| **jest-environment-jsdom** | 29.7.0 | JSDOM environment for Jest |
| **@testing-library/react** | 16.0.0 | React component testing |
| **@testing-library/jest-dom** | 6.1.0 | Custom Jest matchers for DOM |
| **@testing-library/user-event** | 14.5.0 | User interaction simulation |
| **@types/jest** | 29.5.0 | TypeScript types for Jest |
| **msw** | 2.10.5 | API mocking library |

**Test File Patterns**:
- `*.test.ts` - Unit tests
- `*.test.tsx` - Component tests
- `__tests__/` - Test directory

**Commands**:
```bash
npm test              # Run all tests
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Generate coverage report
```

**Documentation**:
- Jest: https://jestjs.io
- React Testing Library: https://testing-library.com/react

---

### Backend Testing

| Technology | Version | Purpose |
|------------|---------|---------|
| **pytest** | ≥7.4.0 | Python testing framework |
| **pytest-asyncio** | ≥0.21.0 | Async test support for pytest |
| **pytest-cov** | ≥4.1.0 | Coverage plugin for pytest |
| **pytest-mock** | ≥3.11.0 | Mocking plugin for pytest |
| **pytest-httpx** | ≥0.21.0 | HTTPX mock support |

**Test File Patterns**:
- `test_*.py` - Test files
- `*_test.py` - Alternative test files
- `tests/` - Test directory

**Commands**:
```bash
pytest                     # Run all tests
pytest --cov              # Run with coverage
pytest -v                 # Verbose output
pytest -k "test_name"     # Run specific tests
```

**Documentation**:
- pytest: https://docs.pytest.org

---

## 🐳 Infrastructure & DevOps

### Containerization

| Technology | Version | Purpose |
|------------|---------|---------|
| **Docker** | Latest | Container platform |
| **docker-compose** | Latest | Multi-container orchestration |

**Docker Images**:
- **Frontend**: Node.js-based Next.js application
- **Backend**: Python FastAPI application
- **MySQL**: Official MySQL 9.4 image
- **Redis**: Official Redis 7 image
- **Executor**: Custom sandbox environment

**Key Files**:
- `Dockerfile` (frontend/backend)
- `docker-compose.yml`
- `.dockerignore`

**Commands**:
```bash
docker-compose up -d       # Start all services
docker-compose down        # Stop all services
docker-compose logs -f     # View logs
docker-compose ps          # List containers
```

---

### Executor Environment

| Technology | Purpose |
|------------|---------|
| **Claude Code** | Primary AI coding agent |
| **Agno** | Experimental chat agent |
| **Git** | Version control inside executors |
| **Docker SDK** | Executor container management |

**Network**: `wegent-network` (Docker bridge network)

**Port Range**: 10001-10100 (dynamically allocated)

---

## 📦 Version Requirements

### Node.js & npm

```json
{
  "node": ">=18.0.0",
  "npm": ">=9.0.0"
}
```

### Python

```
Python >= 3.9
```

### Database

```
MySQL >= 9.4
Redis >= 7.0
```

---

## 📚 Complete Dependency Lists

### Frontend Dependencies (package.json)

**Production**:
```json
{
  "@headlessui/react": "^2.2.0",
  "@heroicons/react": "^2.2.0",
  "@hookform/resolvers": "^5.2.2",
  "@radix-ui/react-checkbox": "^1.3.3",
  "@radix-ui/react-dialog": "^1.1.15",
  "@radix-ui/react-dropdown-menu": "^2.1.16",
  "@radix-ui/react-label": "^2.1.8",
  "@radix-ui/react-popover": "^1.1.15",
  "@radix-ui/react-radio-group": "^1.3.8",
  "@radix-ui/react-scroll-area": "^1.2.10",
  "@radix-ui/react-select": "^2.2.6",
  "@radix-ui/react-slot": "^1.2.4",
  "@radix-ui/react-switch": "^1.2.6",
  "@radix-ui/react-toast": "^1.2.15",
  "@radix-ui/react-tooltip": "^1.2.8",
  "@tabler/icons-react": "^3.34.1",
  "@uiw/react-markdown-editor": "^6.1.4",
  "@uiw/react-md-editor": "^4.0.8",
  "class-variance-authority": "^0.7.1",
  "clsx": "^2.1.1",
  "cmdk": "^1.1.1",
  "driver.js": "^1.3.6",
  "i18next": "^25.5.2",
  "lucide-react": "^0.554.0",
  "next": "^15.1.3",
  "react": "19.0.0",
  "react-dom": "19.0.0",
  "react-hook-form": "^7.66.1",
  "react-i18next": "^15.7.3",
  "react-icons": "^5.5.0",
  "react-markdown": "latest",
  "react-textarea-autosize": "^8.5.9",
  "tailwind-merge": "^3.4.0",
  "tailwindcss-animate": "^1.0.7",
  "vaul": "^1.1.2",
  "zod": "^4.1.12"
}
```

**Development**:
```json
{
  "@testing-library/jest-dom": "^6.1.0",
  "@testing-library/react": "^16.0.0",
  "@testing-library/user-event": "^14.5.0",
  "@types/jest": "^29.5.0",
  "@types/node": "^22.10.1",
  "@types/react": "^19.0.1",
  "@types/react-dom": "^19.0.2",
  "autoprefixer": "latest",
  "eslint": "^9.17.0",
  "eslint-config-next": "15.1.3",
  "husky": "^9.1.7",
  "jest": "^29.7.0",
  "jest-environment-jsdom": "^29.7.0",
  "lint-staged": "^15.2.11",
  "msw": "^2.10.5",
  "postcss": "^8.5.0",
  "prettier": "^3.4.2",
  "tailwindcss": "^3.4.16",
  "typescript": "^5.7.3"
}
```

### Backend Dependencies (requirements.txt)

```txt
# FastAPI framework
fastapi>=0.68.0
uvicorn>=0.15.0
pydantic>=2.0.0
pydantic-settings>=2.0.0
python-multipart>=0.0.5
email-validator>=1.1.3

# Database
sqlalchemy>=2.0.28
pymysql==1.1.0
asyncmy>=0.2.9
cryptography==41.0.5
alembic>=1.12.0

# Authentication
python-jose==3.3.0
passlib==1.7.4
bcrypt==4.0.1
authlib>=1.2.0
PyJWT>=2.8.0

# HTTP clients
httpx>=0.19.0
requests>=2.31.0
aiohttp>=3.8.0

# Utilities
python-dotenv==1.0.0
tenacity==8.2.3
pyyaml>=6.0
structlog>=23.1.0
python-dateutil>=2.8.2
asyncio>=3.4.3
lxml>=4.9.0
pathlib2>=2.3.7
regex>=2023.8.8
orjson>=3.9.0

# Caching
redis>=4.5.0

# Testing
pytest>=7.4.0
pytest-asyncio>=0.21.0
pytest-cov>=4.1.0
pytest-mock>=3.11.0
pytest-httpx>=0.21.0

# Development
black>=23.7.0
isort>=5.12.0
flake8>=6.0.0
mypy>=1.5.0

# Documentation
mkdocs>=1.5.0
mkdocs-material>=9.2.0

# Environment
python-decouple>=3.8

# Security
cryptography>=41.0.5
pycryptodome>=3.20.0
```

---

## 🔗 Official Documentation Links

### Frontend
- **Next.js**: https://nextjs.org/docs
- **React**: https://react.dev
- **TypeScript**: https://www.typescriptlang.org/docs
- **Tailwind CSS**: https://tailwindcss.com/docs
- **shadcn/ui**: https://ui.shadcn.com
- **Radix UI**: https://www.radix-ui.com

### Backend
- **FastAPI**: https://fastapi.tiangolo.com
- **SQLAlchemy**: https://docs.sqlalchemy.org
- **Pydantic**: https://docs.pydantic.dev
- **pytest**: https://docs.pytest.org

### Infrastructure
- **Docker**: https://docs.docker.com
- **MySQL**: https://dev.mysql.com/doc
- **Redis**: https://redis.io/docs

---

**Last Updated**: 2025-01-22
**Version**: 1.0.0
