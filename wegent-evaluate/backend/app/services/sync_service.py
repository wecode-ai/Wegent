"""
Service for synchronizing conversation data from external API.
"""
import uuid
from datetime import datetime, timedelta
from typing import List, Literal, Optional

import httpx
import structlog
from sqlalchemy import func, select
from sqlalchemy.dialects.mysql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.auth_client import auth_client
from app.models import ConversationRecord, DataVersion, EvaluationStatus, SyncJob, SyncStatus
from app.schemas.external_api import QAHistoryItem, QAHistoryResponse
from app.services.version_service import VersionService

logger = structlog.get_logger(__name__)


class SyncService:
    """Service for synchronizing conversation data from external API."""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.version_service = VersionService(db)

    async def trigger_sync(
        self,
        start_time: datetime,
        end_time: datetime,
        user_id: Optional[int] = None,
        version_mode: Literal["new", "existing"] = "new",
        version_id: Optional[int] = None,
        write_mode: Optional[Literal["append", "replace"]] = None,
        version_description: Optional[str] = None,
    ) -> tuple[str, int]:
        """
        Trigger a new sync job.

        Args:
            start_time: Start time for sync range
            end_time: End time for sync range
            user_id: Optional user ID filter
            version_mode: "new" to create new version, "existing" to use existing
            version_id: Version ID for existing mode
            write_mode: "append" or "replace" for existing mode
            version_description: Description for new version

        Returns:
            (sync_id, version_id)

        Raises:
            ValueError: If version_mode is "existing" and version has running evaluations
        """
        sync_id = str(uuid.uuid4())
        target_version_id: int

        if version_mode == "new":
            # Create new version
            version = await self.version_service.create_version(
                description=version_description
            )
            target_version_id = version.id
            logger.info("Created new version for sync", version_id=target_version_id)
        else:
            # Use existing version
            target_version_id = version_id  # type: ignore

            # Verify version exists
            version = await self.version_service.get_version(target_version_id)
            if not version:
                raise ValueError(f"Version {target_version_id} not found")

            # Check for running evaluations
            has_running = await self.version_service.check_version_has_running_evaluation(
                target_version_id
            )
            if has_running:
                raise ValueError(
                    "该版本下有正在进行的评估任务，请等待完成后再操作"
                )

            # Handle replace mode
            if write_mode == "replace":
                logger.info("Replacing version data", version_id=target_version_id)
                await self.version_service.delete_version_data(target_version_id)

        # Create sync job record
        sync_job = SyncJob(
            sync_id=sync_id,
            start_time=start_time,
            end_time=end_time,
            user_id=user_id,
            version_id=target_version_id,
            status=SyncStatus.STARTED,
        )
        self.db.add(sync_job)
        await self.db.commit()

        return sync_id, target_version_id

    async def execute_sync(self, sync_id: str) -> None:
        """
        Execute the sync job by fetching data from external API.
        """
        # Get sync job
        result = await self.db.execute(
            select(SyncJob).where(SyncJob.sync_id == sync_id)
        )
        sync_job = result.scalar_one_or_none()

        if not sync_job:
            logger.error("Sync job not found", sync_id=sync_id)
            return

        try:
            # Update status to running
            sync_job.status = SyncStatus.RUNNING
            await self.db.commit()

            total_fetched = 0
            total_inserted = 0
            total_skipped = 0

            # Fetch all pages
            page = 1
            page_size = 100

            while True:
                items, pagination = await self._fetch_page(
                    start_time=sync_job.start_time,
                    end_time=sync_job.end_time,
                    user_id=sync_job.user_id,
                    page=page,
                    page_size=page_size,
                )

                total_fetched += len(items)

                # Process items with version_id
                inserted, skipped = await self._process_items(
                    items, version_id=sync_job.version_id
                )
                total_inserted += inserted
                total_skipped += skipped

                # Check if there are more pages
                if page >= pagination.total_pages:
                    break

                page += 1

            # Update sync job with results
            sync_job.status = SyncStatus.COMPLETED
            sync_job.total_fetched = total_fetched
            sync_job.total_inserted = total_inserted
            sync_job.total_skipped = total_skipped
            await self.db.commit()

            # Update version sync stats
            if sync_job.version_id:
                await self.version_service.update_version_sync_stats(sync_job.version_id)

            logger.info(
                "Sync completed",
                sync_id=sync_id,
                version_id=sync_job.version_id,
                fetched=total_fetched,
                inserted=total_inserted,
                skipped=total_skipped,
            )

        except Exception as e:
            logger.exception("Sync failed", sync_id=sync_id, error=str(e))
            sync_job.status = SyncStatus.FAILED
            sync_job.error_message = str(e)
            await self.db.commit()

    async def _fetch_page(
        self,
        start_time: datetime,
        end_time: datetime,
        user_id: Optional[int],
        page: int,
        page_size: int,
    ) -> tuple[List[QAHistoryItem], any]:
        """Fetch a single page of QA history data from external API."""
        url = f"{settings.EXTERNAL_API_BASE_URL}{settings.EXTERNAL_API_QA_HISTORY_PATH}"

        # Format time as required by the API (YYYY-MM-DD HH:MM:SS format)
        params = {
            "start_time": start_time.strftime("%Y-%m-%d %H:%M:%S"),
            "end_time": end_time.strftime("%Y-%m-%d %H:%M:%S"),
            "page": page,
            "page_size": page_size,
        }

        if user_id:
            params["user_id"] = user_id

        client = await auth_client.get_authorized_client()
        try:
            response = await client.get(url, params=params)
            response.raise_for_status()

            data = QAHistoryResponse.model_validate(response.json())
            return data.items, data.pagination
        finally:
            await client.aclose()

    async def _process_items(
        self, items: List[QAHistoryItem], version_id: Optional[int] = None
    ) -> tuple[int, int]:
        """
        Process QA history items and insert into database.

        Args:
            items: List of QA history items
            version_id: Version ID for the records

        Returns:
            (inserted_count, skipped_count)
        """
        inserted = 0
        skipped = 0

        for item in items:
            # Check if record already exists
            existing = await self.db.execute(
                select(ConversationRecord).where(
                    ConversationRecord.subtask_context_id == item.subtask_context_id
                )
            )
            if existing.scalar_one_or_none():
                skipped += 1
                continue

            # Determine evaluation status and skip reason
            evaluation_status = EvaluationStatus.PENDING
            skip_reason = None
            extracted_text = None

            # Extract data from knowledge_base_result
            if item.knowledge_base_result:
                extracted_text = item.knowledge_base_result.extracted_text

            # Skip records without assistant_answer (incomplete conversations)
            if not item.assistant_answer:
                evaluation_status = EvaluationStatus.SKIPPED
                skip_reason = "no_assistant_answer"
            elif not extracted_text:
                evaluation_status = EvaluationStatus.SKIPPED
                skip_reason = "no_extracted_text"
            elif not item.knowledge_base_config:
                evaluation_status = EvaluationStatus.SKIPPED
                skip_reason = "no_kb_config"

            # Extract fields from config
            knowledge_id = None
            knowledge_name = None
            retriever_name = None
            embedding_model = None
            retrieval_mode = None

            if item.knowledge_base_result and item.knowledge_base_result.type_data:
                knowledge_id = item.knowledge_base_result.type_data.knowledge_id

            if item.knowledge_base_config:
                knowledge_name = item.knowledge_base_config.name
                if item.knowledge_base_config.retrieval_config:
                    retriever_name = item.knowledge_base_config.retrieval_config.retriever_name
                    retrieval_mode = item.knowledge_base_config.retrieval_config.retrieval_mode
                    if item.knowledge_base_config.retrieval_config.embedding_config:
                        embedding_model = item.knowledge_base_config.retrieval_config.embedding_config.model_name

            # Create record with version_id
            # Use empty string for assistant_answer if None to satisfy NOT NULL constraint
            record = ConversationRecord(
                task_id=item.task_id,
                user_id=item.user_id,
                subtask_id=item.subtask_id,
                subtask_context_id=item.subtask_context_id,
                version_id=version_id,
                user_prompt=item.user_prompt,
                assistant_answer=item.assistant_answer or "",
                extracted_text=extracted_text,
                knowledge_base_result=(
                    item.knowledge_base_result.model_dump()
                    if item.knowledge_base_result
                    else None
                ),
                knowledge_base_config=(
                    item.knowledge_base_config.model_dump()
                    if item.knowledge_base_config
                    else None
                ),
                knowledge_id=knowledge_id,
                knowledge_name=knowledge_name,
                retriever_name=retriever_name,
                embedding_model=embedding_model,
                retrieval_mode=retrieval_mode,
                original_created_at=item.created_at,
                evaluation_status=evaluation_status,
                skip_reason=skip_reason,
            )

            self.db.add(record)
            inserted += 1

        await self.db.commit()
        return inserted, skipped

    async def get_sync_status(self, sync_id: str) -> Optional[SyncJob]:
        """Get status of a sync job."""
        result = await self.db.execute(
            select(SyncJob).where(SyncJob.sync_id == sync_id)
        )
        return result.scalar_one_or_none()

    async def get_sync_history(
        self, page: int = 1, page_size: int = 20
    ) -> tuple[List[SyncJob], int]:
        """Get sync job history with pagination."""
        # Count total
        count_result = await self.db.execute(select(func.count(SyncJob.id)))
        total = count_result.scalar()

        # Get paginated results
        offset = (page - 1) * page_size
        result = await self.db.execute(
            select(SyncJob)
            .order_by(SyncJob.created_at.desc())
            .offset(offset)
            .limit(page_size)
        )
        items = result.scalars().all()

        return items, total
