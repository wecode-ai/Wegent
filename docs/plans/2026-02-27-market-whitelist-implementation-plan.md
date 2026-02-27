# Subscription Market Whitelist Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add market-level user whitelist visibility for subscriptions so only approved users can discover/detail/rent market subscriptions while keeping empty whitelist behavior fully public.

**Architecture:** Keep storage in subscription JSON `_internal.market_whitelist_user_ids` (no migration). Add a shared backend whitelist access helper, wire validation/persistence in subscription create-update conversion paths, and enforce permission checks in market discover/detail/rent flows. Frontend extends subscription form with email-based user search and whitelist chips, then submits user IDs.

**Tech Stack:** FastAPI, SQLAlchemy, Pydantic, Next.js 15, React 19, TypeScript, Jest, i18next

---

### Task 1: Extend API/Data Contracts for Whitelist Field

**Files:**
- Modify: `backend/app/schemas/subscription.py`
- Modify: `frontend/src/types/subscription.ts`
- Test: `backend/tests/services/subscription/test_market_whitelist_schema.py`

**Step 1: Write the failing test**

```python
from app.schemas.subscription import SubscriptionCreate, SubscriptionUpdate


def test_subscription_create_accepts_market_whitelist_user_ids():
    payload = SubscriptionCreate(
        name="s1",
        display_name="S1",
        task_type="collection",
        visibility="market",
        trigger_type="cron",
        trigger_config={"expression": "0 9 * * *", "timezone": "UTC"},
        team_id=1,
        prompt_template="hi",
        market_whitelist_user_ids=[2, 3],
    )
    assert payload.market_whitelist_user_ids == [2, 3]


def test_subscription_update_accepts_market_whitelist_user_ids():
    payload = SubscriptionUpdate(market_whitelist_user_ids=[9])
    assert payload.market_whitelist_user_ids == [9]
```

**Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/services/subscription/test_market_whitelist_schema.py -v`
Expected: FAIL with schema field missing error.

**Step 3: Write minimal implementation**

```python
# backend/app/schemas/subscription.py
class SubscriptionBase(BaseModel):
    market_whitelist_user_ids: Optional[List[int]] = Field(
        None, description="User IDs allowed to discover/rent market subscription"
    )

class SubscriptionUpdate(BaseModel):
    market_whitelist_user_ids: Optional[List[int]] = None

class SubscriptionInDB(SubscriptionBase):
    market_whitelist_user_ids: Optional[List[int]] = None
```

```ts
// frontend/src/types/subscription.ts
export interface Subscription {
  market_whitelist_user_ids?: number[]
}

export interface SubscriptionCreateRequest {
  market_whitelist_user_ids?: number[]
}

export interface SubscriptionUpdateRequest {
  market_whitelist_user_ids?: number[]
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/services/subscription/test_market_whitelist_schema.py -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/schemas/subscription.py frontend/src/types/subscription.ts backend/tests/services/subscription/test_market_whitelist_schema.py
git commit -m "feat(subscription): add market whitelist fields to schemas"
```

### Task 2: Add Shared Whitelist Access Helper

**Files:**
- Create: `backend/app/services/subscription/market_access.py`
- Test: `backend/tests/services/subscription/test_market_access.py`

**Step 1: Write the failing test**

```python
from app.schemas.subscription import SubscriptionVisibility
from app.services.subscription.market_access import can_view_market_subscription


def test_can_view_market_subscription_empty_whitelist_allows_everyone():
    assert can_view_market_subscription(
        visibility=SubscriptionVisibility.MARKET,
        owner_user_id=1,
        current_user_id=2,
        whitelist_user_ids=[],
    ) is True


def test_can_view_market_subscription_non_member_forbidden():
    assert can_view_market_subscription(
        visibility=SubscriptionVisibility.MARKET,
        owner_user_id=1,
        current_user_id=5,
        whitelist_user_ids=[2, 3],
    ) is False
```

**Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/services/subscription/test_market_access.py -v`
Expected: FAIL with import/function-not-found.

**Step 3: Write minimal implementation**

```python
# backend/app/services/subscription/market_access.py
from typing import Iterable, List

from app.schemas.subscription import SubscriptionVisibility


def normalize_market_whitelist_user_ids(user_ids: Iterable[int] | None) -> List[int]:
    if not user_ids:
        return []
    deduped = []
    seen = set()
    for uid in user_ids:
        if isinstance(uid, int) and uid > 0 and uid not in seen:
            seen.add(uid)
            deduped.append(uid)
    return deduped


def can_view_market_subscription(
    *, visibility: SubscriptionVisibility, owner_user_id: int, current_user_id: int, whitelist_user_ids: list[int]
) -> bool:
    if visibility != SubscriptionVisibility.MARKET:
        return False
    if current_user_id == owner_user_id:
        return True
    if not whitelist_user_ids:
        return True
    return current_user_id in whitelist_user_ids
```

**Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/services/subscription/test_market_access.py -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/services/subscription/market_access.py backend/tests/services/subscription/test_market_access.py
git commit -m "feat(subscription): add market whitelist access helper"
```

### Task 3: Persist Whitelist on Create/Update and Return It

**Files:**
- Modify: `backend/app/services/subscription/service.py`
- Test: `backend/tests/services/subscription/test_subscription_service_market_whitelist.py`

**Step 1: Write the failing test**

```python
def test_convert_to_subscription_in_db_exposes_market_whitelist_ids(...):
    # prepare Kind.json with _internal.market_whitelist_user_ids=[2,3]
    # call _convert_to_subscription_in_db(...)
    assert result.market_whitelist_user_ids == [2, 3]


def test_update_subscription_writes_market_whitelist_ids_to_internal(...):
    # call update_subscription with market_whitelist_user_ids
    # assert subscription.json["_internal"]["market_whitelist_user_ids"] updated
```

**Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/services/subscription/test_subscription_service_market_whitelist.py -v`
Expected: FAIL because field is not persisted/exposed.

**Step 3: Write minimal implementation**

```python
# backend/app/services/subscription/service.py
from app.services.subscription.market_access import normalize_market_whitelist_user_ids

# create_subscription
internal_whitelist = normalize_market_whitelist_user_ids(subscription_in.market_whitelist_user_ids)
# optional: validate IDs exist in User table
crd_json["_internal"]["market_whitelist_user_ids"] = internal_whitelist

# update_subscription
if "market_whitelist_user_ids" in update_data:
    internal["market_whitelist_user_ids"] = normalize_market_whitelist_user_ids(
        update_data["market_whitelist_user_ids"]
    )

# _convert_to_subscription_in_db
market_whitelist_user_ids = internal.get("market_whitelist_user_ids", [])
...
market_whitelist_user_ids=market_whitelist_user_ids,
```

**Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/services/subscription/test_subscription_service_market_whitelist.py -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/services/subscription/service.py backend/tests/services/subscription/test_subscription_service_market_whitelist.py
git commit -m "feat(subscription): persist market whitelist in subscription internal json"
```

### Task 4: Enforce Whitelist in Market Discover/Detail/Rent

**Files:**
- Modify: `backend/app/services/subscription/market_service.py`
- Test: `backend/tests/services/subscription/test_market_service_whitelist.py`

**Step 1: Write the failing test**

```python
def test_discover_market_subscriptions_hides_non_whitelist_user(...):
    # market subscription has whitelist [2], requester is user 9
    # discover result should not contain the subscription


def test_get_market_subscription_detail_returns_403_for_non_whitelist(...):
    # expect HTTPException(status_code=403)


def test_rent_subscription_returns_403_for_non_whitelist(...):
    # expect HTTPException(status_code=403)
```

**Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/services/subscription/test_market_service_whitelist.py -v`
Expected: FAIL because current logic only checks `visibility=market`.

**Step 3: Write minimal implementation**

```python
# backend/app/services/subscription/market_service.py
from app.services.subscription.market_access import can_view_market_subscription

whitelist = internal.get("market_whitelist_user_ids", [])
if not can_view_market_subscription(
    visibility=visibility,
    owner_user_id=sub.user_id,
    current_user_id=user_id,
    whitelist_user_ids=whitelist,
):
    # list: continue
    # detail/rent: raise HTTPException(status_code=403, detail="Not in market whitelist")
```

**Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/services/subscription/test_market_service_whitelist.py -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/services/subscription/market_service.py backend/tests/services/subscription/test_market_service_whitelist.py
git commit -m "feat(subscription): enforce whitelist for market discover detail and rent"
```

### Task 5: Add API-Level Regression Tests for 403 Behavior

**Files:**
- Create: `backend/tests/api/endpoints/test_subscription_market_whitelist_api.py`
- Modify: `backend/tests/conftest.py` (only if extra fixture is required)

**Step 1: Write the failing test**

```python
def test_market_detail_returns_403_for_non_whitelist_user(test_client, test_token, ...):
    resp = test_client.get(
        f"/api/market/subscriptions/{sub_id}",
        headers={"Authorization": f"Bearer {test_token}"},
    )
    assert resp.status_code == 403
```

**Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/api/endpoints/test_subscription_market_whitelist_api.py -v`
Expected: FAIL with 200/404 mismatch.

**Step 3: Write minimal implementation/fixture wiring**

```python
# seed a market subscription with _internal.market_whitelist_user_ids=[allowed_user_id]
# call discover/detail/rent with non-whitelist token
# assert 403 or hidden in discover list
```

**Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/api/endpoints/test_subscription_market_whitelist_api.py -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add backend/tests/api/endpoints/test_subscription_market_whitelist_api.py backend/tests/conftest.py
git commit -m "test(subscription): add api coverage for market whitelist permissions"
```

### Task 6: Build Frontend Whitelist UI in Subscription Form

**Files:**
- Modify: `frontend/src/features/feed/components/SubscriptionForm.tsx`
- Modify: `frontend/src/i18n/locales/zh-CN/feed.json`
- Modify: `frontend/src/i18n/locales/en/feed.json`
- Test: `frontend/src/__tests__/features/feed/components/SubscriptionForm.market-whitelist.test.tsx`

**Step 1: Write the failing test**

```tsx
it('shows whitelist section only when visibility is market', async () => {
  render(<SubscriptionForm ... />)
  // switch visibility to market
  expect(screen.getByText('market whitelist title')).toBeInTheDocument()
})

it('adds searched user to whitelist chips and submits ids', async () => {
  // mock userApis.searchUsers to return alice
  // add alice
  // submit and assert payload.market_whitelist_user_ids includes alice.id
})
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- --runInBand src/__tests__/features/feed/components/SubscriptionForm.market-whitelist.test.tsx`
Expected: FAIL because UI/state/payload field does not exist.

**Step 3: Write minimal implementation**

```tsx
// SubscriptionForm.tsx
const [marketWhitelistUsers, setMarketWhitelistUsers] = useState<SearchUser[]>([])

{visibility === 'market' && (
  <MarketWhitelistSection
    selectedUsers={marketWhitelistUsers}
    onChange={setMarketWhitelistUsers}
  />
)}

const marketWhitelistUserIds = marketWhitelistUsers.map(u => u.id)
// include market_whitelist_user_ids in create/update payload
```

```json
// feed.json (zh-CN/en)
"market_whitelist_title": "...",
"market_whitelist_hint": "...",
"market_whitelist_empty_public_hint": "..."
```

**Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- --runInBand src/__tests__/features/feed/components/SubscriptionForm.market-whitelist.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
git add frontend/src/features/feed/components/SubscriptionForm.tsx frontend/src/i18n/locales/zh-CN/feed.json frontend/src/i18n/locales/en/feed.json frontend/src/__tests__/features/feed/components/SubscriptionForm.market-whitelist.test.tsx
git commit -m "feat(frontend): add market whitelist ui in subscription form"
```

### Task 7: Handle 403 UX on Market Detail/Rent Flows

**Files:**
- Modify: `frontend/src/features/feed/components/MarketPageInline.tsx`
- Modify: `frontend/src/features/feed/components/RentSubscriptionDialog.tsx`
- Modify: `frontend/src/apis/subscription.ts` (error mapping if needed)
- Test: `frontend/src/__tests__/features/feed/components/MarketPageInline.forbidden.test.tsx`

**Step 1: Write the failing test**

```tsx
it('shows forbidden toast/message when market detail returns 403', async () => {
  // mock getMarketSubscriptionDetail -> reject with 403
  // assert user-facing error message
})
```

**Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- --runInBand src/__tests__/features/feed/components/MarketPageInline.forbidden.test.tsx`
Expected: FAIL because 403-specific UX is missing.

**Step 3: Write minimal implementation**

```tsx
if (isApiErrorWithStatus(error, 403)) {
  toast.error(t('market.whitelist_forbidden'))
  return
}
```

**Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- --runInBand src/__tests__/features/feed/components/MarketPageInline.forbidden.test.tsx`
Expected: PASS.

**Step 5: Commit**

```bash
git add frontend/src/features/feed/components/MarketPageInline.tsx frontend/src/features/feed/components/RentSubscriptionDialog.tsx frontend/src/apis/subscription.ts frontend/src/__tests__/features/feed/components/MarketPageInline.forbidden.test.tsx
git commit -m "fix(frontend): handle market whitelist forbidden responses"
```

### Task 8: Update User Docs (ZH First, Then EN)

**Files:**
- Modify: `docs/zh/user-guide/feed/creating-subscriptions.md`
- Modify: `docs/en/user-guide/feed/creating-subscriptions.md`

**Step 1: Write the failing docs check (manual checklist)**

```text
- Missing: market whitelist section
- Missing: empty whitelist means public visibility in market
- Missing: non-whitelist users see no list item and get 403 on direct detail/rent
```

**Step 2: Run docs grep to verify missing content**

Run: `rg -n "白名单|whitelist|市场" docs/zh/user-guide/feed/creating-subscriptions.md docs/en/user-guide/feed/creating-subscriptions.md`
Expected: Missing target phrases before update.

**Step 3: Write minimal documentation updates**

```markdown
## 市场白名单
- 输入邮箱搜索并添加用户到白名单
- 白名单为空时，市场全员可见
- 非白名单用户访问详情/租用会收到权限错误
```

**Step 4: Run docs grep to verify it passes**

Run: `rg -n "白名单|whitelist|403" docs/zh/user-guide/feed/creating-subscriptions.md docs/en/user-guide/feed/creating-subscriptions.md`
Expected: Lines found in both files.

**Step 5: Commit**

```bash
git add docs/zh/user-guide/feed/creating-subscriptions.md docs/en/user-guide/feed/creating-subscriptions.md
git commit -m "docs(feed): document market whitelist behavior for subscriptions"
```

### Task 9: Final Verification and Squash-Free Delivery

**Files:**
- Verify only (no required file edits)

**Step 1: Run targeted backend tests**

Run:
```bash
cd backend && uv run pytest \
  tests/services/subscription/test_market_whitelist_schema.py \
  tests/services/subscription/test_market_access.py \
  tests/services/subscription/test_subscription_service_market_whitelist.py \
  tests/services/subscription/test_market_service_whitelist.py \
  tests/api/endpoints/test_subscription_market_whitelist_api.py -v
```
Expected: PASS.

**Step 2: Run targeted frontend tests**

Run:
```bash
cd frontend && npm test -- --runInBand \
  src/__tests__/features/feed/components/SubscriptionForm.market-whitelist.test.tsx \
  src/__tests__/features/feed/components/MarketPageInline.forbidden.test.tsx
```
Expected: PASS.

**Step 3: Run lint/format checks for touched frontend files**

Run: `cd frontend && npm run lint`
Expected: PASS.

**Step 4: Run backend formatting checks for touched Python files**

Run: `cd backend && uv run black --check app/services/subscription app/schemas tests/services/subscription tests/api/endpoints`
Expected: PASS.

**Step 5: Final commit (only if verification changes were needed)**

```bash
git add <any-fixes>
git commit -m "chore: address final verification fixes for market whitelist"
```
