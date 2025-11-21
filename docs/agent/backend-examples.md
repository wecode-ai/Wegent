# Backend Examples

Quick reference for common backend patterns in Wegent.

---

## Example 1: CRUD API Endpoint

**Files:**
- `/workspace/12738/Wegent/backend/app/models/shell.py`
- `/workspace/12738/Wegent/backend/app/schemas/shell.py`
- `/workspace/12738/Wegent/backend/app/services/shell_service.py`
- `/workspace/12738/Wegent/backend/app/api/endpoints/shells.py`

**Core Code:**

```python
# Model
class Shell(Base):
    __tablename__ = "shells"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    namespace = Column(String(255), default="default", index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    runtime = Column(String(100), nullable=False)
    support_model = Column(JSON, default=list)
    created_at = Column(DateTime, server_default=func.now())
    __table_args__ = (UniqueConstraint('name', 'namespace', 'user_id'),)

# Service
class ShellService:
    def list_shells(self, db: Session, user_id: int, namespace: str = "default"):
        return db.query(ShellModel).filter(
            ShellModel.user_id == user_id, ShellModel.namespace == namespace
        ).all()

    def create_shell(self, db: Session, shell: Shell, user_id: int):
        db_shell = ShellModel(name=shell.metadata.name, user_id=user_id, ...)
        db.add(db_shell)
        db.commit()
        db.refresh(db_shell)
        return db_shell

# Endpoint
@router.post("/shells", status_code=201)
def create_shell(shell: Shell, db: Session = Depends(get_db), current_user = Depends(get_current_user)):
    try:
        db_shell = shell_service.create_shell(db, shell, current_user.id)
        return format_shell(db_shell)
    except ConflictException as e:
        raise HTTPException(409, str(e))
```

**Key Points:**
- Index frequently queried columns
- Use service layer for business logic
- Return proper HTTP status codes
- Handle exceptions with HTTPException

---

## Example 2: Business Logic with Validation

**Files:**
- `/workspace/12738/Wegent/backend/app/services/bot_service.py`

**Core Code:**

```python
class BotService:
    def create_bot(self, db: Session, bot: Bot, user_id: int):
        # Validate references
        ghost = db.query(Ghost).filter(Ghost.name == bot.spec.ghostRef.name, ...).first()
        if not ghost:
            raise NotFoundException(f"Ghost not found")
        if ghost.state != "Available":
            raise ValidationException(f"Ghost not available")

        model = db.query(Model).filter(...).first()
        shell = db.query(Shell).filter(...).first()

        # Validate compatibility
        model_provider = "anthropic" if "anthropic" in model.env.get("MODEL") else "openai"
        if model_provider not in shell.support_model:
            raise ValidationException(f"Model incompatible with shell")

        # Create bot
        db_bot = BotModel(user_id=user_id, ghost_id=ghost.id, ...)
        db.add(db_bot)
        db.commit()
        return db_bot
```

**Key Points:**
- Validate all references exist
- Check resource states before use
- Validate cross-resource compatibility
- Use custom exceptions for error types

---

## Example 3: Background Jobs

**Files:**
- `/workspace/12738/Wegent/backend/app/services/jobs.py`

**Core Code:**

```python
from apscheduler.schedulers.asyncio import AsyncIOScheduler

scheduler = AsyncIOScheduler()

async def cleanup_expired_executors():
    db = SessionLocal()
    try:
        expiration = datetime.utcnow() - timedelta(hours=settings.EXECUTOR_RETENTION_HOURS)
        subtasks = db.query(SubTask).filter(
            SubTask.status.in_(["COMPLETED", "FAILED"]),
            SubTask.executor_name.isnot(None),
            SubTask.updated_at < expiration
        ).all()

        for subtask in subtasks:
            await delete_executor(subtask.executor_name, subtask.executor_namespace)
            subtask.executor_name = None
        db.commit()
    finally:
        db.close()

def start_background_jobs(app):
    scheduler.add_job(
        cleanup_expired_executors,
        trigger=IntervalTrigger(seconds=settings.CLEANUP_INTERVAL),
        id="cleanup_executors",
        replace_existing=True
    )
    scheduler.start()

# In main.py
@app.on_event("startup")
def startup():
    start_background_jobs(app)
```

**Key Points:**
- Use AsyncIOScheduler for FastAPI
- Always close database sessions
- Use IntervalTrigger for periodic jobs
- Register jobs in startup event

---

## Related
- [Frontend Examples](./frontend-examples.md)
- [Testing Examples](./testing-examples.md)
- [Tech Stack](./tech-stack.md)
