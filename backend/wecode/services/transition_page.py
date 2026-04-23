"""
Transition Page Service
"""

import csv
import io
import uuid
import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

from sqlalchemy import asc
from sqlalchemy.orm import Session

from shared.utils.snowflake import get_snowflake_id
from wecode.models.transition_page import TransitionPageItem


PAGE = "page"
GROUP = "group"
GROUP_MEMBER = "group_member"
BLOCK = "block"
USER_CONTENT = "user_content"
USER_VIEW = "user_view"  # Records which blocks user has viewed


def generate_page_id() -> str:
    return f"page_{uuid.uuid4().hex[:12]}"


def get_user_key(email: str) -> str:
    return f"user:{email}"


class TransitionPageService:
    """Transition page service"""

    def __init__(self, db: Session):
        self.db = db

    def create_page(self, title: str, slug: str) -> TransitionPageItem:
        existing = (
            self.db.query(TransitionPageItem)
            .filter(TransitionPageItem.type == PAGE, TransitionPageItem.key == slug)
            .first()
        )
        if existing:
            raise ValueError(f"Page with slug '{slug}' already exists")

        page_id = generate_page_id()
        page = TransitionPageItem(
            id=get_snowflake_id(),
            page_id=page_id,
            type=PAGE,
            key=slug,
            data_json={"title": title, "slug": slug, "status": "draft"},
            sort_order=0,
        )
        self.db.add(page)
        self.db.commit()
        self.db.refresh(page)
        return page

    def get_page_by_slug(self, slug: str) -> Optional[TransitionPageItem]:
        return (
            self.db.query(TransitionPageItem)
            .filter(TransitionPageItem.type == PAGE, TransitionPageItem.key == slug)
            .first()
        )

    def get_page_by_id(self, page_id: str) -> Optional[TransitionPageItem]:
        return (
            self.db.query(TransitionPageItem)
            .filter(TransitionPageItem.type == PAGE, TransitionPageItem.page_id == page_id)
            .first()
        )

    def list_pages(self) -> list[TransitionPageItem]:
        return (
            self.db.query(TransitionPageItem)
            .filter(TransitionPageItem.type == PAGE)
            .order_by(TransitionPageItem.created_at.desc())
            .all()
        )

    def update_page(
        self, page_id: str, title: Optional[str] = None, status: Optional[str] = None, title_font_size: Optional[str] = None
    ) -> TransitionPageItem:
        page = self.get_page_by_id(page_id)
        if not page:
            raise ValueError(f"Page with id '{page_id}' not found")

        # Create a new dict to ensure SQLAlchemy detects the change
        new_data = dict(page.data_json)
        if title is not None:
            new_data["title"] = title
        if status is not None:
            new_data["status"] = status
        if title_font_size is not None:
            new_data["title_font_size"] = title_font_size
        page.data_json = new_data

        page.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(page)
        return page

    def delete_page(self, page_id: str) -> None:
        # Check if page exists
        page = self.get_page_by_id(page_id)
        if not page:
            raise ValueError(f"Page with id '{page_id}' not found")
        # Cascade delete all related items
        self.db.query(TransitionPageItem).filter(
            TransitionPageItem.page_id == page_id
        ).delete()
        self.db.commit()

    def create_group(self, page_id: str, key: str, data: Any) -> TransitionPageItem:
        from wecode.schemas.transition_page import GroupData

        group_data = data if isinstance(data, GroupData) else GroupData(**data)
        group = TransitionPageItem(
            id=get_snowflake_id(),
            page_id=page_id,
            type=GROUP,
            key=key,
            data_json=group_data.model_dump(mode="json"),
            sort_order=0,
        )
        self.db.add(group)
        self.db.commit()
        self.db.refresh(group)
        return group

    def get_group(self, page_id: str, key: str) -> Optional[TransitionPageItem]:
        return (
            self.db.query(TransitionPageItem)
            .filter(
                TransitionPageItem.page_id == page_id,
                TransitionPageItem.type == GROUP,
                TransitionPageItem.key == key,
            )
            .first()
        )

    def list_groups(self, page_id: str) -> list[TransitionPageItem]:
        return (
            self.db.query(TransitionPageItem)
            .filter(TransitionPageItem.page_id == page_id, TransitionPageItem.type == GROUP)
            .all()
        )

    def update_group(self, page_id: str, key: str, data: Any) -> TransitionPageItem:
        from wecode.schemas.transition_page import GroupData

        group = self.get_group(page_id, key)
        if not group:
            raise ValueError(f"Group '{key}' not found")

        group_data = data if isinstance(data, GroupData) else GroupData(**data)
        group.data_json = group_data.model_dump(mode="json")
        group.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(group)
        return group

    def delete_group(self, page_id: str, key: str) -> None:
        # Check if group exists
        group = self.get_group(page_id, key)
        if not group:
            raise ValueError(f"Group '{key}' not found")
        self.db.query(TransitionPageItem).filter(
            TransitionPageItem.page_id == page_id,
            TransitionPageItem.type == GROUP,
            TransitionPageItem.key == key,
        ).delete()
        self.db.commit()

    def add_group_member(self, page_id: str, email: str, group_key: str) -> TransitionPageItem:
        # Check if group exists
        group = self.get_group(page_id, group_key)
        if not group:
            raise ValueError(f"Group '{group_key}' not found")

        existing = self.get_group_member(page_id, email)
        if existing:
            existing.data_json["group_key"] = group_key
            existing.updated_at = datetime.utcnow()
            self.db.commit()
            self.db.refresh(existing)
            return existing

        member = TransitionPageItem(
            id=get_snowflake_id(),
            page_id=page_id,
            type=GROUP_MEMBER,
            key=get_user_key(email),
            data_json={"email": email, "group_key": group_key},
            sort_order=0,
        )
        self.db.add(member)
        self.db.commit()
        self.db.refresh(member)
        return member

    def get_group_member(self, page_id: str, email: str) -> Optional[TransitionPageItem]:
        return (
            self.db.query(TransitionPageItem)
            .filter(
                TransitionPageItem.page_id == page_id,
                TransitionPageItem.type == GROUP_MEMBER,
                TransitionPageItem.key == get_user_key(email),
            )
            .first()
        )

    def list_group_members(self, page_id: str) -> list[TransitionPageItem]:
        return (
            self.db.query(TransitionPageItem)
            .filter(
                TransitionPageItem.page_id == page_id,
                TransitionPageItem.type == GROUP_MEMBER,
            )
            .all()
        )

    def delete_group_member(self, page_id: str, email: str) -> None:
        self.db.query(TransitionPageItem).filter(
            TransitionPageItem.page_id == page_id,
            TransitionPageItem.type == GROUP_MEMBER,
            TransitionPageItem.key == get_user_key(email),
        ).delete()
        self.db.commit()

    def create_block(self, page_id: str, key: str, data: Any, sort_order: int = 0) -> TransitionPageItem:
        from wecode.schemas.transition_page import BlockData

        block_data = data if isinstance(data, BlockData) else BlockData(**data)
        block = TransitionPageItem(
            id=get_snowflake_id(),
            page_id=page_id,
            type=BLOCK,
            key=key,
            data_json=block_data.model_dump(mode="json"),
            sort_order=sort_order,
        )
        self.db.add(block)
        self.db.commit()
        self.db.refresh(block)
        return block

    def get_block(self, page_id: str, key: str) -> Optional[TransitionPageItem]:
        return (
            self.db.query(TransitionPageItem)
            .filter(
                TransitionPageItem.page_id == page_id,
                TransitionPageItem.type == BLOCK,
                TransitionPageItem.key == key,
            )
            .first()
        )

    def list_blocks(self, page_id: str) -> list[TransitionPageItem]:
        return (
            self.db.query(TransitionPageItem)
            .filter(TransitionPageItem.page_id == page_id, TransitionPageItem.type == BLOCK)
            .order_by(asc(TransitionPageItem.sort_order))
            .all()
        )

    def update_block(
        self, page_id: str, key: str, data: Optional[Any] = None, sort_order: Optional[int] = None
    ) -> TransitionPageItem:
        from wecode.schemas.transition_page import BlockData

        block = self.get_block(page_id, key)
        if not block:
            raise ValueError(f"Block '{key}' not found")

        if data is not None:
            block_data = data if isinstance(data, BlockData) else BlockData(**data)
            block.data_json = block_data.model_dump(mode="json")
        if sort_order is not None:
            block.sort_order = sort_order

        block.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(block)
        return block

    def delete_block(self, page_id: str, key: str) -> None:
        # Check if block exists
        block = self.get_block(page_id, key)
        if not block:
            raise ValueError(f"Block '{key}' not found")
        self.db.query(TransitionPageItem).filter(
            TransitionPageItem.page_id == page_id,
            TransitionPageItem.type == BLOCK,
            TransitionPageItem.key == key,
        ).delete()
        self.db.commit()

    def set_user_content(self, page_id: str, email: str, content: dict[str, Any]) -> TransitionPageItem:
        existing = self.get_user_content(page_id, email)
        if existing:
            existing.data_json = {"content": content}
            existing.updated_at = datetime.utcnow()
            self.db.commit()
            self.db.refresh(existing)
            return existing

        user_content = TransitionPageItem(
            id=get_snowflake_id(),
            page_id=page_id,
            type=USER_CONTENT,
            key=get_user_key(email),
            data_json={"content": content},
            sort_order=0,
        )
        self.db.add(user_content)
        self.db.commit()
        self.db.refresh(user_content)
        return user_content

    def get_user_content(self, page_id: str, email: str) -> Optional[TransitionPageItem]:
        return (
            self.db.query(TransitionPageItem)
            .filter(
                TransitionPageItem.page_id == page_id,
                TransitionPageItem.type == USER_CONTENT,
                TransitionPageItem.key == get_user_key(email),
            )
            .first()
        )

    def get_user_view(self, page_id: str, email: str) -> Optional[TransitionPageItem]:
        """Get user's view record with viewed blocks timestamps."""
        return (
            self.db.query(TransitionPageItem)
            .filter(
                TransitionPageItem.page_id == page_id,
                TransitionPageItem.type == USER_VIEW,
                TransitionPageItem.key == get_user_key(email),
            )
            .first()
        )

    def record_block_view(self, page_id: str, email: str, block_key: str, existing: Optional[TransitionPageItem] = None) -> TransitionPageItem:
        """Record that user has viewed a block with timestamp."""
        if existing is None:
            existing = self.get_user_view(page_id, email)
        now = datetime.now(timezone.utc).isoformat()
        logger.info(f"[RECORD_VIEW] page_id={page_id} email={email} block_key={block_key} existing={existing is not None}")
        if existing:
            data = dict(existing.data_json)
            logger.info(f"[RECORD_VIEW] existing data={data}")
            if page_id not in data:
                data[page_id] = {"viewed_blocks": {}}
            if block_key not in data[page_id]["viewed_blocks"]:
                data[page_id]["viewed_blocks"][block_key] = now
                existing.data_json = data
                existing.updated_at = datetime.utcnow()
                self.db.commit()
                self.db.refresh(existing)
                logger.info(f"[RECORD_VIEW] updated existing record with block_key={block_key}")
            else:
                logger.info(f"[RECORD_VIEW] block_key={block_key} already exists, skipping")
            return existing

        user_view = TransitionPageItem(
            id=get_snowflake_id(),
            page_id=page_id,
            type=USER_VIEW,
            key=get_user_key(email),
            global_key=f"{page_id}:{get_user_key(email)}",
            data_json={
                page_id: {
                    "viewed_blocks": {
                        block_key: now
                    }
                }
            },
            sort_order=0,
        )
        self.db.add(user_view)
        self.db.commit()
        self.db.refresh(user_view)
        logger.info(f"[RECORD_VIEW] created new record with id={user_view.id}")
        return user_view

    def batch_record_block_views(self, page_id: str, email: str, block_keys: list[str], existing: Optional[TransitionPageItem] = None) -> TransitionPageItem:
        """Batch record that user has viewed multiple blocks."""
        if existing is None:
            existing = self.get_user_view(page_id, email)
        now = datetime.now(timezone.utc).isoformat()

        if existing:
            data = dict(existing.data_json)
            if page_id not in data:
                data[page_id] = {"viewed_blocks": {}}
            for block_key in block_keys:
                if block_key not in data[page_id]["viewed_blocks"]:
                    data[page_id]["viewed_blocks"][block_key] = now
            existing.data_json = data
            existing.updated_at = datetime.utcnow()
            self.db.commit()
            self.db.refresh(existing)
            logger.info(f"[BATCH_RECORD] updated existing record with {len(block_keys)} blocks")
            return existing

        # Create new record with all blocks
        data_json = {page_id: {"viewed_blocks": {bk: now for bk in block_keys}}}
        user_view = TransitionPageItem(
            id=get_snowflake_id(),
            page_id=page_id,
            type=USER_VIEW,
            key=get_user_key(email),
            global_key=f"{page_id}:{get_user_key(email)}",
            data_json=data_json,
            sort_order=0,
        )
        self.db.add(user_view)
        self.db.commit()
        self.db.refresh(user_view)
        logger.info(f"[BATCH_RECORD] created new record with {len(block_keys)} blocks")
        return user_view

    def list_user_views(self, page_id: str) -> list[TransitionPageItem]:
        """List all user view records for a page."""
        results = (
            self.db.query(TransitionPageItem)
            .filter(
                TransitionPageItem.page_id == page_id,
                TransitionPageItem.type == USER_VIEW,
            )
            .all()
        )
        logger.info(f"[LIST_VIEWS] page_id={page_id} found {len(results)} records")
        for r in results:
            logger.info(f"[LIST_VIEWS] record key={r.key} data={r.data_json}")
        return results

    def delete_user_view(self, page_id: str, email: str) -> None:
        """Delete user's view record for a page."""
        self.db.query(TransitionPageItem).filter(
            TransitionPageItem.page_id == page_id,
            TransitionPageItem.type == USER_VIEW,
            TransitionPageItem.key == get_user_key(email),
        ).delete()
        self.db.commit()

    def import_users_from_csv(self, page_id: str, csv_content: str) -> dict[str, Any]:
        results = {"total": 0, "success": 0, "failed": 0, "errors": []}

        reader = csv.DictReader(io.StringIO(csv_content))
        for row in reader:
            results["total"] += 1
            try:
                email = row.get("email", "").strip()
                group_key = row.get("group_key", "").strip()
                content_str = row.get("content", "{}").strip()

                if not email:
                    raise ValueError("Email is required")
                if not group_key:
                    raise ValueError("Group key is required")

                try:
                    content = json.loads(content_str) if content_str else {}
                except json.JSONDecodeError:
                    raise ValueError(f"Invalid JSON in content: {content_str}")

                self.add_group_member(page_id, email, group_key)
                if content:
                    self.set_user_content(page_id, email, content)

                results["success"] += 1
            except Exception as e:
                results["failed"] += 1
                results["errors"].append(f"Row {results['total']}: {str(e)}")

        self.db.commit()
        return results

    def export_users_to_csv(self, page_id: str) -> str:
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=["email", "group_key", "content"])
        writer.writeheader()

        members = self.list_group_members(page_id)
        for member in members:
            email = member.data_json.get("email", "")
            group_key = member.data_json.get("group_key", "")
            user_content_item = self.get_user_content(page_id, email)
            content = (
                user_content_item.data_json.get("content", {})
                if user_content_item
                else {}
            )
            writer.writerow({
                "email": email,
                "group_key": group_key,
                "content": json.dumps(content, ensure_ascii=False),
            })

        return output.getvalue()

    def _check_time_visible(
        self, start_at: Optional[str], end_at: Optional[str], now: datetime, tz: ZoneInfo, item_key: str
    ) -> tuple[bool, Optional[str]]:
        """Check if item is visible based on time constraints. Returns (visible, reason)."""

        if start_at:
            start_dt = datetime.fromisoformat(start_at.replace("Z", "+00:00"))
            if start_dt.tzinfo is None:
                start_dt = start_dt.replace(tzinfo=tz)
            if now < start_dt:
                return False, f"{item_key}: now={now} < start_at={start_dt}"

        if end_at:
            end_dt = datetime.fromisoformat(end_at.replace("Z", "+00:00"))
            if end_dt.tzinfo is None:
                end_dt = end_dt.replace(tzinfo=tz)
            if now > end_dt:
                return False, f"{item_key}: now={now} > end_at={end_dt}"

        return True, None

    def is_block_visible(
        self, block_data: dict[str, Any], user_email: str, user_group_key: Optional[str], now: datetime,
        group_data: Optional[dict[str, Any]] = None
    ) -> bool:
        start_at = block_data.get("start_at")
        end_at = block_data.get("end_at")
        block_key = block_data.get("key", "unknown")

        # Use Asia/Shanghai (UTC+8) as default timezone for naive datetimes
        tz = ZoneInfo("Asia/Shanghai")

        # Check block time constraints
        block_visible, block_reason = self._check_time_visible(start_at, end_at, now, tz, "block")
        if not block_visible:
            logger.info(f"[BLOCK_HIDDEN] {block_key}: {block_reason}")
            return False

        # Check group time constraints (if group has time settings and block is not "always" stage)
        stage = block_data.get("stage", "always")
        if group_data and stage != "always":
            group_start = group_data.get("start_at")
            group_end = group_data.get("end_at")
            group_visible, group_reason = self._check_time_visible(group_start, group_end, now, tz, "group")
            if not group_visible:
                logger.info(f"[BLOCK_HIDDEN] {block_key}: {group_reason}")
                return False

        condition = block_data.get("condition", {})
        groups = condition.get("groups")
        if groups:
            if user_group_key is None or user_group_key not in groups:
                logger.info(f"[BLOCK_HIDDEN] {block_key}: user_group={user_group_key} not in {groups}")
                return False

        users = condition.get("users")
        if users:
            if get_user_key(user_email) not in users:
                logger.info(f"[BLOCK_HIDDEN] {block_key}: user={user_email} not in {users}")
                return False

        return True

    def render_template(self, template: str, variables: dict[str, Any]) -> str:
        result = template
        for key, value in variables.items():
            result = result.replace(f"{{{{content.{key}}}}}", str(value))
        return result

    def render_template_with_group(self, template: str, content_vars: dict[str, Any], group_vars: dict[str, Any]) -> str:
        """Render template with both content and group variables"""
        result = template
        # Replace content variables: {{content.xxx}}
        for key, value in content_vars.items():
            result = result.replace(f"{{{{content.{key}}}}}", str(value))
        # Replace group variables: {{group.xxx}}
        for key, value in group_vars.items():
            result = result.replace(f"{{{{group.{key}}}}}", str(value))
        return result

    def render_page(self, slug: str, user_email: str) -> Any:
        from wecode.schemas.transition_page import RenderedPageResponse, RenderedBlock, RenderedButton

        now = datetime.now(timezone.utc)

        page = self.get_page_by_slug(slug)
        if not page:
            raise ValueError(f"Page with slug '{slug}' not found")

        page_data = page.data_json
        page_id = page.page_id

        group_member = self.get_group_member(page_id, user_email)
        user_group_key = group_member.data_json.get("group_key") if group_member else None

        group_info = None
        if user_group_key:
            group = self.get_group(page_id, user_group_key)
            if group:
                group_info = {"key": user_group_key, **group.data_json}

        user_content_item = self.get_user_content(page_id, user_email)
        user_content = (
            user_content_item.data_json.get("content", {})
            if user_content_item
            else {}
        )

        blocks = self.list_blocks(page_id)
        rendered_blocks = []

        # Get group time constraints if user is in a group
        group = self.get_group(page_id, user_group_key) if user_group_key else None
        group_data = group.data_json if group else None

        # Get user's viewed blocks
        user_view = self.get_user_view(page_id, user_email)
        viewed_blocks = {}
        if user_view and page_id in user_view.data_json:
            viewed_blocks = dict(user_view.data_json[page_id].get("viewed_blocks", {}))

        # First pass: determine which blocks to show and which need recording
        blocks_to_render = []
        blocks_to_record = []

        for block in blocks:
            block_data = block.data_json
            block_key = block.key
            freeze_enabled = block_data.get("freeze_enabled", False)

            logger.info(f"[RENDER] block={block_key} freeze_enabled={freeze_enabled} viewed_blocks={viewed_blocks}")

            # Check if block was already viewed (frozen) - only if freeze_enabled
            is_viewed = freeze_enabled and block_key in viewed_blocks

            logger.info(f"[RENDER] block={block_key} is_viewed={is_viewed}")

            # Frozen blocks have highest priority - always visible regardless of time
            if is_viewed:
                logger.info(f"[RENDER] block={block_key} frozen - skipping time check")
                blocks_to_render.append(block)
            else:
                # Not viewed before, check time/conditions
                visible = self.is_block_visible(block_data, user_email, user_group_key, now, group_data)
                logger.info(f"[RENDER] block={block_key} visible={visible}")
                if visible:
                    blocks_to_render.append(block)
                    # First time visible and freeze enabled, mark for recording
                    if freeze_enabled:
                        blocks_to_record.append(block_key)

        # Batch record all new views
        if blocks_to_record:
            logger.info(f"[RENDER] batch recording {len(blocks_to_record)} blocks: {blocks_to_record}")
            self.batch_record_block_views(page_id, user_email, blocks_to_record, user_view)
            # Update viewed_blocks for logging
            for bk in blocks_to_record:
                viewed_blocks[bk] = datetime.now(timezone.utc).isoformat()

        # Second pass: render all visible blocks
        for block in blocks_to_render:
            block_data = block.data_json
            block_key = block.key
            title = block_data.get("title", "")
            markdown_template = block_data.get("markdown_template", "")
            # Prepare group variables from group_data
            group_vars = {}
            if group_data:
                group_content = group_data.get("content") or {}
                group_vars = {
                    "name": group_data.get("name", ""),
                    "key": user_group_key or "",
                    **group_content,  # Spread content fields for direct access
                }
            markdown = self.render_template_with_group(markdown_template, user_content, group_vars)

            buttons_data = block_data.get("buttons", [])
            buttons = []
            for btn in buttons_data:
                url_template = btn.get("url_template", "")
                url = self.render_template_with_group(url_template, user_content, group_vars)
                buttons.append(
                    RenderedButton(
                        label=btn.get("label", ""),
                        url=url,
                        variant=btn.get("variant", "primary"),
                        target=btn.get("target", "_blank"),
                    )
                )

            rendered_blocks.append(
                RenderedBlock(title=title, icon=block_data.get("icon"), markdown=markdown, buttons=buttons)
            )

        from wecode.schemas.transition_page import RenderedPage

        return RenderedPageResponse(
            page=RenderedPage(
                title=page_data.get("title", ""),
                slug=page_data.get("slug", ""),
                title_font_size=page_data.get("title_font_size"),
            ),
            group=group_info,
            blocks=rendered_blocks,
        )
