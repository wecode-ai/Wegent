from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime
from app.db.base import Base


class SharedTask(Base):
    """
    Shared Task model - Records task sharing relationships

    When a user shares a task, the task's content (including subtasks/messages)
    can be copied to another user's task list.
    """
    __tablename__ = "shared_tasks"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)

    # User who joined/copied the shared task
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    # Original user who created/shared the task
    original_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    # Original task ID that was shared
    original_task_id = Column(Integer, ForeignKey("kinds.id", ondelete="CASCADE"), nullable=False, index=True)

    # New task ID created for the user who joined (copied task)
    copied_task_id = Column(Integer, ForeignKey("kinds.id", ondelete="CASCADE"), nullable=True, index=True)

    # Whether this share relationship is active
    is_active = Column(Boolean, default=True, nullable=False)

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relationships
    user = relationship("User", foreign_keys=[user_id], back_populates="shared_tasks")
    original_user = relationship("User", foreign_keys=[original_user_id])
    original_task = relationship("Kind", foreign_keys=[original_task_id])
    copied_task = relationship("Kind", foreign_keys=[copied_task_id])

    # Unique constraint: one user can only copy the same original task once
    __table_args__ = (
        UniqueConstraint('user_id', 'original_task_id', name='uq_user_original_task'),
    )

    def __repr__(self):
        return f"<SharedTask(id={self.id}, user_id={self.user_id}, original_task_id={self.original_task_id})>"
