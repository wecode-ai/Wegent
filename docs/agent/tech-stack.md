# Technology Stack

Core technologies used in Wegent.

---

## Frontend

| Technology | Version | Purpose |
|------------|---------|---------|
| Next.js | 15.1.3 | React framework with App Router |
| React | 19.0.0 | UI library |
| TypeScript | 5.7.3 | Type-safe JavaScript |
| Tailwind CSS | 3.4.16 | Utility-first CSS |
| shadcn/ui | Latest | Component library (Radix UI based) |
| lucide-react | 0.554.0 | Icon library |
| react-hook-form | 7.66.1 | Form management |
| zod | 4.1.12 | Schema validation |
| i18next | 25.5.2 | Internationalization |

### Key Radix UI Components
- Dialog, Dropdown Menu, Select, Switch, Checkbox, Radio Group
- Popover, Tooltip, Toast, Scroll Area
- All v1.2+ or v2.1+

---

## Backend

| Technology | Version | Purpose |
|------------|---------|---------|
| Python | >=3.9 | Programming language |
| FastAPI | >=0.68.0 | Web framework |
| Uvicorn | >=0.15.0 | ASGI server |
| Pydantic | >=2.0.0 | Data validation |
| SQLAlchemy | >=2.0.28 | ORM |
| PyMySQL | 1.1.0 | MySQL driver (sync) |
| asyncmy | >=0.2.9 | MySQL driver (async) |
| Alembic | >=1.12.0 | Database migrations |

### Authentication
| Technology | Version | Purpose |
|------------|---------|---------|
| python-jose | 3.3.0 | JWT (JOSE) |
| PyJWT | >=2.8.0 | JWT implementation |
| passlib | 1.7.4 | Password hashing |
| bcrypt | 4.0.1 | Bcrypt algorithm |
| authlib | >=1.2.0 | OAuth/OpenID |

### HTTP & Networking
| Technology | Version | Purpose |
|------------|---------|---------|
| httpx | >=0.19.0 | Async HTTP client |
| aiohttp | >=3.8.0 | Async HTTP framework |
| requests | >=2.31.0 | Sync HTTP client |

### Utilities
| Technology | Version | Purpose |
|------------|---------|---------|
| redis | >=4.5.0 | Caching/sessions |
| python-dotenv | 1.0.0 | Environment vars |
| tenacity | 8.2.3 | Retry logic |
| pyyaml | >=6.0 | YAML parsing |
| structlog | >=23.1.0 | Structured logging |
| orjson | >=3.9.0 | Fast JSON |

---

## Database

| Technology | Version | Purpose |
|------------|---------|---------|
| MySQL | 9.4 | Relational database |
| Redis | 7 | Cache/session store |

---

## Testing

### Frontend
| Technology | Version | Purpose |
|------------|---------|---------|
| Jest | 29.7.0 | Testing framework |
| @testing-library/react | 16.0.0 | Component testing |
| @testing-library/jest-dom | 6.1.0 | DOM matchers |
| msw | 2.10.5 | API mocking |

### Backend
| Technology | Version | Purpose |
|------------|---------|---------|
| pytest | >=7.4.0 | Testing framework |
| pytest-asyncio | >=0.21.0 | Async support |
| pytest-cov | >=4.1.0 | Coverage |
| pytest-mock | >=3.11.0 | Mocking |

---

## Development Tools

### Frontend
| Tool | Version | Purpose |
|------|---------|---------|
| ESLint | 9.17.0 | Linting |
| Prettier | 3.4.2 | Code formatting |
| Husky | 9.1.7 | Git hooks |
| lint-staged | 15.2.11 | Staged file linting |

### Backend
| Tool | Version | Purpose |
|------|---------|---------|
| black | >=23.7.0 | Code formatting |
| isort | >=5.12.0 | Import sorting |
| flake8 | >=6.0.0 | Linting |
| mypy | >=1.5.0 | Type checking |

---

## Infrastructure

| Technology | Purpose |
|------------|---------|
| Docker | Containerization |
| docker-compose | Multi-container orchestration |

### Docker Images
- Frontend: Node.js + Next.js
- Backend: Python + FastAPI
- Database: MySQL 9.4
- Cache: Redis 7
- Executor: Sandbox environment

---

## Version Requirements

```json
{
  "node": ">=18.0.0",
  "npm": ">=9.0.0",
  "python": ">=3.9",
  "mysql": ">=9.4",
  "redis": ">=7.0"
}
```

---

## Related
- [Frontend Examples](./frontend-examples.md)
- [Backend Examples](./backend-examples.md)
- [Design System](./design-system.md)
