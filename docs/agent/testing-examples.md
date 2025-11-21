# Testing Examples

Quick reference for testing patterns in Wegent.

---

## Example 1: Unit Testing Security Functions

**File:** `/workspace/12738/Wegent/backend/tests/core/test_security.py`

```python
import pytest
from app.core.security import verify_password, get_password_hash, create_access_token, verify_token

@pytest.mark.unit
class TestPasswordHashing:
    def test_hash_password_creates_valid_hash(self):
        password = "testpass123"
        hashed = get_password_hash(password)
        assert hashed.startswith("$2b$")
        assert verify_password(password, hashed) is True

    def test_verify_password_with_incorrect_password(self):
        hashed = get_password_hash("correct")
        assert verify_password("wrong", hashed) is False

@pytest.mark.unit
class TestJWTTokens:
    def test_create_and_verify_token(self):
        data = {"sub": "testuser"}
        token = create_access_token(data)
        result = verify_token(token)
        assert result["username"] == "testuser"

    def test_verify_invalid_token_raises_exception(self):
        with pytest.raises(HTTPException) as exc:
            verify_token("invalid.token")
        assert exc.value.status_code == 401
```

**Key Points:**
- Mark tests with @pytest.mark.unit/integration
- Test both success and failure cases
- Use pytest.raises for exception testing

---

## Example 2: Integration Testing API

**File:** `/workspace/12738/Wegent/backend/tests/api/test_ghosts.py`

```python
@pytest.mark.integration
class TestGhostEndpoints:
    def test_create_ghost_success(self, client, test_token):
        response = client.post("/api/v1/ghosts",
            json={"metadata": {"name": "test"}, "spec": {"systemPrompt": "Test"}},
            headers={"Authorization": f"Bearer {test_token}"})
        assert response.status_code == 201
        assert response.json()["metadata"]["name"] == "test"

    def test_create_duplicate_ghost_fails(self, client, test_token, test_db, test_user):
        # Create first
        ghost = Ghost(name="existing", user_id=test_user.id, ...)
        test_db.add(ghost)
        test_db.commit()
        # Try duplicate
        response = client.post("/api/v1/ghosts",
            json={"metadata": {"name": "existing"}, ...},
            headers={"Authorization": f"Bearer {test_token}"})
        assert response.status_code == 409
```

**Fixtures:**
```python
@pytest.fixture
def test_db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(bind=engine)
    db = SessionLocal()
    yield db
    db.close()
    Base.metadata.drop_all(bind=engine)

@pytest.fixture
def test_user(test_db):
    user = User(user_name="test", hashed_password=get_password_hash("pass"))
    test_db.add(user)
    test_db.commit()
    return user

@pytest.fixture
def test_token(test_user):
    return create_access_token({"sub": test_user.user_name})
```

**Key Points:**
- Use in-memory SQLite for test DB
- Create fixtures for common setup
- Test authentication in all endpoints

---

## Example 3: Frontend Component Testing

**File:** `/workspace/12738/Wegent/frontend/src/components/__tests__/GhostList.test.tsx`

```typescript
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GhostList } from '../GhostList';
import * as api from '@/apis/ghosts';

jest.mock('@/apis/ghosts');

describe('GhostList', () => {
  const mockGhosts = { items: [
    { metadata: { name: 'ghost-1' }, spec: { systemPrompt: 'Test' } }
  ]};

  it('renders loading state initially', () => {
    (api.listGhosts as jest.Mock).mockImplementation(() => new Promise(() => {}));
    render(<GhostList />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('renders ghosts after loading', async () => {
    (api.listGhosts as jest.Mock).mockResolvedValue(mockGhosts);
    render(<GhostList />);
    await waitFor(() => expect(screen.getByText('ghost-1')).toBeInTheDocument());
  });

  it('filters ghosts by name', async () => {
    (api.listGhosts as jest.Mock).mockResolvedValue(mockGhosts);
    render(<GhostList />);
    await waitFor(() => screen.getByText('ghost-1'));
    fireEvent.change(screen.getByPlaceholderText(/filter/i), { target: { value: 'other' } });
    expect(screen.queryByText('ghost-1')).not.toBeInTheDocument();
  });
});
```

**Key Points:**
- Mock API calls with jest.mock
- Use waitFor for async updates
- Test loading, success, error states

---

## Related
- [Frontend Examples](./frontend-examples.md)
- [Backend Examples](./backend-examples.md)
