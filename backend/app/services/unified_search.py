# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified Search Service - Aggregates search results from multiple sources
"""

import logging
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.wiki import WikiContent, WikiGeneration, WikiProject
from app.schemas.kind import Task, Team
from app.schemas.unified_search import (
    SearchFacets,
    SearchHighlight,
    SearchResponse,
    SearchResultItem,
    SearchType,
    SortType,
)

logger = logging.getLogger(__name__)


class UnifiedSearchService:
    """Unified search service that aggregates results from multiple sources"""

    MAX_SNIPPET_LENGTH = 200

    def _generate_snippet(self, text_content: str, keyword: str) -> str:
        """Generate a snippet with keyword context"""
        if not text_content:
            return ""

        # Find keyword position (case insensitive)
        keyword_lower = keyword.lower()
        text_lower = text_content.lower()
        pos = text_lower.find(keyword_lower)

        if pos == -1:
            # Keyword not found, return beginning of text
            return text_content[: self.MAX_SNIPPET_LENGTH] + (
                "..." if len(text_content) > self.MAX_SNIPPET_LENGTH else ""
            )

        # Calculate context window around keyword
        context_size = (self.MAX_SNIPPET_LENGTH - len(keyword)) // 2
        start = max(0, pos - context_size)
        end = min(len(text_content), pos + len(keyword) + context_size)

        snippet = text_content[start:end]

        # Add ellipsis if needed
        if start > 0:
            snippet = "..." + snippet
        if end < len(text_content):
            snippet = snippet + "..."

        return snippet

    def _highlight_keyword(self, text: str, keyword: str) -> List[str]:
        """Find matches for highlighting"""
        if not text or not keyword:
            return []

        matches = []
        pattern = re.compile(re.escape(keyword), re.IGNORECASE)
        for match in pattern.finditer(text):
            matches.append(match.group())

        return matches

    def search_tasks(
        self,
        db: Session,
        user_id: int,
        keyword: str,
        task_type: Optional[str] = None,
        date_from: Optional[datetime] = None,
        date_to: Optional[datetime] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> Tuple[List[SearchResultItem], int]:
        """Search tasks (chat/code)"""
        results = []

        # Build base query
        query = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Task",
            Kind.is_active == True,
            text("JSON_EXTRACT(json, '$.status.status') != 'DELETE'"),
        )

        # Filter by task_type if specified (task_type is stored in metadata.labels.taskType)
        if task_type:
            query = query.filter(
                text(
                    f"JSON_EXTRACT(json, '$.metadata.labels.taskType') = '{task_type}'"
                )
            )

        # Date filters
        if date_from:
            query = query.filter(Kind.created_at >= date_from)
        if date_to:
            query = query.filter(Kind.created_at <= date_to)

        # Get all matching tasks (we'll filter by keyword in application layer)
        tasks = query.order_by(Kind.created_at.desc()).all()

        # Filter by keyword in application layer
        keyword_lower = keyword.lower()
        matched_tasks = []

        for task in tasks:
            try:
                task_crd = Task.model_validate(task.json)
                title = task_crd.spec.title or ""
                prompt = task_crd.spec.prompt or ""
                # workspaceRef is a reference to workspace, get its name for search
                workspace_ref_name = (
                    task_crd.spec.workspaceRef.name
                    if task_crd.spec.workspaceRef
                    else ""
                )

                # Match against title, prompt, or workspace name
                if (
                    keyword_lower in title.lower()
                    or keyword_lower in prompt.lower()
                    or (
                        workspace_ref_name
                        and keyword_lower in workspace_ref_name.lower()
                    )
                ):
                    matched_tasks.append((task, task_crd))
            except Exception as e:
                logger.warning(f"Failed to parse task {task.id}: {e}")
                continue

        total = len(matched_tasks)

        # Apply pagination
        paginated_tasks = matched_tasks[offset : offset + limit]

        for task, task_crd in paginated_tasks:
            title = task_crd.spec.title or ""
            prompt = task_crd.spec.prompt or ""
            # task_type is stored in metadata.labels.taskType, not in spec
            current_task_type = (
                task_crd.metadata.labels.get("taskType", "chat")
                if task_crd.metadata.labels
                else "chat"
            )
            # workspaceRef is a reference, not the actual workspace data
            workspace_ref_name = (
                task_crd.spec.workspaceRef.name if task_crd.spec.workspaceRef else ""
            )

            # Generate snippet from prompt
            snippet = self._generate_snippet(prompt, keyword)

            # Determine search type
            search_type = (
                SearchType.CODE if current_task_type == "code" else SearchType.CHAT
            )

            results.append(
                SearchResultItem(
                    id=str(task.id),
                    type=search_type,
                    title=title or f"Task #{task.id}",
                    snippet=snippet,
                    highlight=SearchHighlight(
                        title=self._highlight_keyword(title, keyword),
                        content=self._highlight_keyword(prompt, keyword),
                    ),
                    created_at=task.created_at,
                    updated_at=task.updated_at,
                    metadata={
                        "task_type": current_task_type,
                        "workspace": workspace_ref_name,
                        "status": (
                            task_crd.status.status if task_crd.status else "PENDING"
                        ),
                    },
                )
            )

        return results, total

    def search_teams(
        self,
        db: Session,
        user_id: int,
        keyword: str,
        date_from: Optional[datetime] = None,
        date_to: Optional[datetime] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> Tuple[List[SearchResultItem], int]:
        """Search teams"""
        results = []

        # Query user's teams
        query = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True,
        )

        if date_from:
            query = query.filter(Kind.created_at >= date_from)
        if date_to:
            query = query.filter(Kind.created_at <= date_to)

        teams = query.order_by(Kind.created_at.desc()).all()

        keyword_lower = keyword.lower()
        matched_teams = []

        for team in teams:
            try:
                team_crd = Team.model_validate(team.json)
                name = team_crd.metadata.name or ""
                description = team_crd.spec.description or ""

                if (
                    keyword_lower in name.lower()
                    or keyword_lower in description.lower()
                ):
                    matched_teams.append((team, team_crd))
            except Exception as e:
                logger.warning(f"Failed to parse team {team.id}: {e}")
                continue

        total = len(matched_teams)
        paginated_teams = matched_teams[offset : offset + limit]

        for team, team_crd in paginated_teams:
            name = team_crd.metadata.name or ""
            description = team_crd.spec.description or ""

            snippet = self._generate_snippet(description, keyword)

            results.append(
                SearchResultItem(
                    id=str(team.id),
                    type=SearchType.TEAMS,
                    title=name,
                    snippet=snippet,
                    highlight=SearchHighlight(
                        title=self._highlight_keyword(name, keyword),
                        content=self._highlight_keyword(description, keyword),
                    ),
                    created_at=team.created_at,
                    updated_at=team.updated_at,
                    metadata={
                        "collaboration_model": (
                            team_crd.spec.collaborationModel if team_crd.spec else None
                        ),
                    },
                )
            )

        return results, total

    def search_knowledge(
        self,
        db: Session,
        user_id: int,
        keyword: str,
        date_from: Optional[datetime] = None,
        date_to: Optional[datetime] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> Tuple[List[SearchResultItem], int]:
        """Search knowledge base (wiki projects and contents)"""
        results = []

        # Search in wiki projects
        project_query = db.query(WikiProject).filter(
            WikiProject.is_active == True,
        )

        if date_from:
            project_query = project_query.filter(WikiProject.created_at >= date_from)
        if date_to:
            project_query = project_query.filter(WikiProject.created_at <= date_to)

        projects = project_query.all()

        keyword_lower = keyword.lower()
        matched_items = []

        # Match projects
        for project in projects:
            name = project.project_name or ""
            description = project.description or ""

            if keyword_lower in name.lower() or keyword_lower in description.lower():
                matched_items.append(
                    (
                        "project",
                        project.id,
                        name,
                        description,
                        project.created_at,
                        project.updated_at,
                        {
                            "source_type": project.source_type,
                            "source_url": project.source_url,
                        },
                    )
                )

        # Search in wiki contents via generations
        generations = (
            db.query(WikiGeneration).filter(WikiGeneration.user_id == user_id).all()
        )

        generation_ids = [g.id for g in generations]

        if generation_ids:
            content_query = db.query(WikiContent).filter(
                WikiContent.generation_id.in_(generation_ids),
            )

            if date_from:
                content_query = content_query.filter(
                    WikiContent.created_at >= date_from
                )
            if date_to:
                content_query = content_query.filter(WikiContent.created_at <= date_to)

            contents = content_query.all()

            for content in contents:
                title = content.title or ""
                text_content = content.content or ""

                if (
                    keyword_lower in title.lower()
                    or keyword_lower in text_content.lower()
                ):
                    matched_items.append(
                        (
                            "content",
                            content.id,
                            title,
                            text_content,
                            content.created_at,
                            content.created_at,
                            {
                                "generation_id": content.generation_id,
                                "type": content.type,
                            },
                        )
                    )

        total = len(matched_items)
        paginated_items = matched_items[offset : offset + limit]

        for (
            item_type,
            item_id,
            title,
            content,
            created_at,
            updated_at,
            metadata,
        ) in paginated_items:
            snippet = self._generate_snippet(content, keyword)

            results.append(
                SearchResultItem(
                    id=f"{item_type}_{item_id}",
                    type=SearchType.KNOWLEDGE,
                    title=title,
                    snippet=snippet,
                    highlight=SearchHighlight(
                        title=self._highlight_keyword(title, keyword),
                        content=self._highlight_keyword(content, keyword),
                    ),
                    created_at=created_at,
                    updated_at=updated_at,
                    metadata=metadata,
                )
            )

        return results, total

    def search(
        self,
        db: Session,
        user_id: int,
        keyword: str,
        types: Optional[List[str]] = None,
        sort: SortType = SortType.RELEVANCE,
        date_from: Optional[datetime] = None,
        date_to: Optional[datetime] = None,
        page: int = 1,
        limit: int = 20,
    ) -> SearchResponse:
        """Unified search across all content types"""

        if not keyword or not keyword.strip():
            return SearchResponse(
                total=0,
                items=[],
                facets=SearchFacets(),
            )

        keyword = keyword.strip()

        # Determine which types to search
        search_types = set()
        if types:
            for t in types:
                try:
                    search_types.add(SearchType(t))
                except ValueError:
                    pass
        else:
            search_types = {
                SearchType.CHAT,
                SearchType.CODE,
                SearchType.KNOWLEDGE,
                SearchType.TEAMS,
            }

        all_results: List[SearchResultItem] = []
        facets = SearchFacets()

        # Search chat tasks
        if SearchType.CHAT in search_types:
            chat_results, chat_total = self.search_tasks(
                db, user_id, keyword, "chat", date_from, date_to, limit=1000, offset=0
            )
            all_results.extend(chat_results)
            facets.chat = chat_total

        # Search code tasks
        if SearchType.CODE in search_types:
            code_results, code_total = self.search_tasks(
                db, user_id, keyword, "code", date_from, date_to, limit=1000, offset=0
            )
            all_results.extend(code_results)
            facets.code = code_total

        # Search teams
        if SearchType.TEAMS in search_types:
            team_results, team_total = self.search_teams(
                db, user_id, keyword, date_from, date_to, limit=1000, offset=0
            )
            all_results.extend(team_results)
            facets.teams = team_total

        # Search knowledge
        if SearchType.KNOWLEDGE in search_types:
            knowledge_results, knowledge_total = self.search_knowledge(
                db, user_id, keyword, date_from, date_to, limit=1000, offset=0
            )
            all_results.extend(knowledge_results)
            facets.knowledge = knowledge_total

        # Sort results
        if sort == SortType.DATE:
            all_results.sort(key=lambda x: x.created_at or datetime.min, reverse=True)
        elif sort == SortType.DATE_ASC:
            all_results.sort(key=lambda x: x.created_at or datetime.min)
        # For relevance, we keep the original order (which is already sorted by relevance within each type)

        # Calculate total and apply pagination
        total = len(all_results)
        offset = (page - 1) * limit
        paginated_results = all_results[offset : offset + limit]

        return SearchResponse(
            total=total,
            items=paginated_results,
            facets=facets,
        )


# Create singleton instance
unified_search_service = UnifiedSearchService()
