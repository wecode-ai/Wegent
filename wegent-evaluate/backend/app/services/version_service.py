"""
Service for managing data versions.
"""
from datetime import datetime
from typing import List, Optional

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ConversationRecord, DataVersion, EvaluationResult, EvaluationStatus

logger = structlog.get_logger(__name__)


class VersionService:
    """Service for managing data versions."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_versions(self) -> tuple[List[DataVersion], int]:
        """
        Get all versions ordered by id desc (newest first).

        Returns:
            (versions, total_count)
        """
        # Count total
        count_result = await self.db.execute(select(func.count(DataVersion.id)))
        total = count_result.scalar() or 0

        # Get versions ordered by id desc
        result = await self.db.execute(
            select(DataVersion).order_by(DataVersion.id.desc())
        )
        versions = result.scalars().all()

        return versions, total

    async def get_version(self, version_id: int) -> Optional[DataVersion]:
        """
        Get a single version by ID.

        Args:
            version_id: The version ID

        Returns:
            DataVersion or None
        """
        result = await self.db.execute(
            select(DataVersion).where(DataVersion.id == version_id)
        )
        return result.scalar_one_or_none()

    async def get_latest_version(self) -> Optional[DataVersion]:
        """
        Get the latest (highest ID) version.

        Returns:
            Latest DataVersion or None
        """
        result = await self.db.execute(
            select(DataVersion).order_by(DataVersion.id.desc()).limit(1)
        )
        return result.scalar_one_or_none()

    async def create_version(self, description: Optional[str] = None) -> DataVersion:
        """
        Create a new version.

        Args:
            description: Optional description for the version

        Returns:
            Created DataVersion
        """
        # Create version without name first
        version = DataVersion(
            name="",  # Will be updated after getting ID
            description=description,
            created_at=datetime.utcnow(),
            sync_count=0,
        )
        self.db.add(version)
        await self.db.flush()  # Get the ID

        # Update name with ID
        version.name = f"版本{version.id}"
        await self.db.commit()

        logger.info("Created new version", version_id=version.id, name=version.name)
        return version

    async def update_version_sync_stats(
        self, version_id: int, sync_count: Optional[int] = None
    ) -> None:
        """
        Update version sync statistics.

        Args:
            version_id: The version ID
            sync_count: Optional new sync count (if None, will be calculated)
        """
        version = await self.get_version(version_id)
        if not version:
            logger.warning("Version not found", version_id=version_id)
            return

        if sync_count is not None:
            version.sync_count = sync_count
        else:
            # Calculate sync count from conversation records
            count_result = await self.db.execute(
                select(func.count(ConversationRecord.id)).where(
                    ConversationRecord.version_id == version_id
                )
            )
            version.sync_count = count_result.scalar() or 0

        version.last_sync_time = datetime.utcnow()
        await self.db.commit()

        logger.info(
            "Updated version sync stats",
            version_id=version_id,
            sync_count=version.sync_count,
        )

    async def check_version_has_running_evaluation(self, version_id: int) -> bool:
        """
        Check if a version has any running (PROCESSING) evaluation tasks.

        Args:
            version_id: The version ID

        Returns:
            True if there are running evaluations, False otherwise
        """
        result = await self.db.execute(
            select(func.count(ConversationRecord.id)).where(
                ConversationRecord.version_id == version_id,
                ConversationRecord.evaluation_status == EvaluationStatus.PROCESSING,
            )
        )
        count = result.scalar() or 0
        return count > 0

    async def delete_version_data(self, version_id: int) -> tuple[int, int]:
        """
        Delete all data for a version (for replace mode).

        Args:
            version_id: The version ID

        Returns:
            (deleted_evaluations, deleted_records)
        """
        # First delete evaluation results (they reference conversation records)
        eval_result = await self.db.execute(
            select(func.count(EvaluationResult.id)).where(
                EvaluationResult.version_id == version_id
            )
        )
        eval_count = eval_result.scalar() or 0

        from sqlalchemy import delete

        await self.db.execute(
            delete(EvaluationResult).where(EvaluationResult.version_id == version_id)
        )

        # Then delete conversation records
        record_result = await self.db.execute(
            select(func.count(ConversationRecord.id)).where(
                ConversationRecord.version_id == version_id
            )
        )
        record_count = record_result.scalar() or 0

        await self.db.execute(
            delete(ConversationRecord).where(ConversationRecord.version_id == version_id)
        )

        await self.db.commit()

        logger.info(
            "Deleted version data",
            version_id=version_id,
            deleted_evaluations=eval_count,
            deleted_records=record_count,
        )

        return eval_count, record_count

    async def ensure_default_version(self) -> DataVersion:
        """
        Ensure at least one version exists (for migration compatibility).

        Returns:
            The default version
        """
        latest = await self.get_latest_version()
        if latest:
            return latest

        # Create default version
        return await self.create_version(description="默认版本")
