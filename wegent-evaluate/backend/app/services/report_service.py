"""
Service for generating weekly reports.
"""
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
import structlog
from sqlalchemy import and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import ConversationRecord, EvaluationResult
from app.services.filter_utils import apply_user_filter
from app.services.version_service import VersionService

logger = structlog.get_logger(__name__)


@dataclass
class VersionStatistics:
    """Statistics for a version."""

    version_id: int
    version_name: str
    sync_count: int
    evaluated_count: int
    failed_count: int
    issue_count: int

    # Core metrics (Tier 1) averages
    avg_faithfulness: Optional[float]
    avg_groundedness: Optional[float]
    avg_query_context_relevance: Optional[float]
    avg_context_relevance: Optional[float]

    # Key metrics (Tier 2) averages
    avg_answer_relevancy: Optional[float]
    avg_relevance_llm: Optional[float]
    avg_context_precision_emb: Optional[float]

    # Diagnostic metrics (Tier 3) averages
    avg_context_diversity: Optional[float]
    avg_context_utilization: Optional[float]
    avg_coherence: Optional[float]
    avg_harmlessness: Optional[float]

    # Total score
    avg_total_score: Optional[float]

    # Issue type distribution
    issue_distribution: Dict[str, int]

    # Failure reasons
    failure_reasons: Dict[str, int]


WEEKLY_REPORT_SUGGESTION_PROMPT = """你是一位 RAG 系统质量评估专家。请根据以下评估统计数据，给出简要的优化建议。

## 版本统计
- 版本：{version_name}
- 同步数据：{sync_count} 条
- 已评估：{evaluated_count} 条
- 失败样本：{failed_count} 条 ({failed_rate:.1%})
- 问题数据：{issue_count} 条 ({issue_rate:.1%})

## 核心指标平均分 (Tier 1)
| 指标 | 分数 | 状态 |
|------|------|------|
| Faithfulness (忠实度) | {avg_faithfulness:.2f} | {status_faithfulness} |
| Groundedness (有据性) | {avg_groundedness:.2f} | {status_groundedness} |
| Query-Context Relevance (查询-上下文相关性) | {avg_qcr:.2f} | {status_qcr} |
| Context Relevance (上下文相关性) | {avg_cr:.2f} | {status_cr} |

## 关键指标平均分 (Tier 2)
| 指标 | 分数 |
|------|------|
| Answer Relevancy (答案相关性) | {avg_ar:.2f} |
| Relevance LLM (LLM相关性) | {avg_rl:.2f} |
| Context Precision (上下文精度) | {avg_cp:.2f} |

## 诊断指标平均分 (Tier 3)
| 指标 | 分数 |
|------|------|
| Context Diversity (上下文多样性) | {avg_cd:.2f} |
| Context Utilization (上下文利用率) | {avg_cu:.2f} |
| Coherence (连贯性) | {avg_coh:.2f} |
| Harmlessness (安全性) | {avg_harm:.2f} |

## 问题类型分布
{issue_distribution_table}

## 失败原因统计
{failure_reasons_table}

请根据以上数据，分析主要问题并给出 3-5 条简要、可操作的优化建议，每条建议不超过 50 字。
只需要返回优化建议列表，使用以下格式：

1. [优化方向] 具体建议内容
2. [优化方向] 具体建议内容
...

优化方向可选：检索优化、知识库、Prompt优化、模型调优、数据质量"""


class ReportService:
    """Service for generating reports."""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.version_service = VersionService(db)

    async def generate_weekly_report(self, version_id: int) -> Dict[str, Any]:
        """
        Generate a weekly report for the specified version.

        Args:
            version_id: The version ID to generate report for

        Returns:
            Dict with markdown content and metadata
        """
        # Get version info
        version = await self.version_service.get_version(version_id)
        if not version:
            raise ValueError(f"Version {version_id} not found")

        # Get statistics
        stats = await self._get_version_statistics(version_id, version.name, version.sync_count)

        # Generate LLM suggestions
        suggestions = await self._generate_llm_suggestions(stats)

        # Build markdown report
        markdown = self._build_markdown_report(stats, suggestions)

        return {
            "markdown": markdown,
            "generated_at": datetime.utcnow(),
            "version_id": version_id,
            "version_name": version.name,
        }

    async def _get_version_statistics(
        self, version_id: int, version_name: str, sync_count: int
    ) -> VersionStatistics:
        """Get comprehensive statistics for a version."""
        # Base conditions
        conditions = [
            ConversationRecord.version_id == version_id,
        ]

        # Query for evaluated records with metrics
        avg_query = (
            select(
                func.count().label("count"),
                func.avg(EvaluationResult.faithfulness_score).label("avg_faithfulness"),
                func.avg(EvaluationResult.trulens_groundedness).label("avg_groundedness"),
                func.avg(EvaluationResult.ragas_query_context_relevance).label("avg_qcr"),
                func.avg(EvaluationResult.trulens_context_relevance).label("avg_cr"),
                func.avg(EvaluationResult.answer_relevancy_score).label("avg_ar"),
                func.avg(EvaluationResult.trulens_relevance_llm).label("avg_rl"),
                func.avg(EvaluationResult.ragas_context_precision_emb).label("avg_cp"),
                func.avg(EvaluationResult.ragas_context_diversity).label("avg_cd"),
                func.avg(EvaluationResult.ragas_context_utilization).label("avg_cu"),
                func.avg(EvaluationResult.trulens_coherence).label("avg_coh"),
                func.avg(EvaluationResult.trulens_harmlessness).label("avg_harm"),
                func.avg(EvaluationResult.total_score).label("avg_total"),
                func.sum(case((EvaluationResult.is_failed == True, 1), else_=0)).label("failed_count"),  # noqa: E712
                func.sum(case((EvaluationResult.has_issue == True, 1), else_=0)).label("issue_count"),  # noqa: E712
            )
            .join(
                ConversationRecord,
                ConversationRecord.id == EvaluationResult.conversation_record_id,
            )
            .where(and_(*conditions))
        )

        # Apply user ID exclusion filter
        avg_query = apply_user_filter(avg_query)

        result = await self.db.execute(avg_query)
        row = result.first()

        evaluated_count = row.count if row else 0
        failed_count = int(row.failed_count) if row and row.failed_count else 0
        issue_count = int(row.issue_count) if row and row.issue_count else 0

        # Get issue type distribution
        issue_query = (
            select(EvaluationResult.issue_types)
            .join(
                ConversationRecord,
                ConversationRecord.id == EvaluationResult.conversation_record_id,
            )
            .where(
                and_(
                    *conditions,
                    EvaluationResult.has_issue == True,  # noqa: E712
                )
            )
        )
        issue_query = apply_user_filter(issue_query)

        issue_result = await self.db.execute(issue_query)
        issue_rows = issue_result.scalars().all()

        issue_distribution: Dict[str, int] = {}
        for issue_types in issue_rows:
            if issue_types:
                for issue_type in issue_types:
                    issue_distribution[issue_type] = issue_distribution.get(issue_type, 0) + 1

        # Get failure reasons
        failure_query = (
            select(EvaluationResult.failure_reason)
            .join(
                ConversationRecord,
                ConversationRecord.id == EvaluationResult.conversation_record_id,
            )
            .where(
                and_(
                    *conditions,
                    EvaluationResult.is_failed == True,  # noqa: E712
                )
            )
        )
        failure_query = apply_user_filter(failure_query)

        failure_result = await self.db.execute(failure_query)
        failure_rows = failure_result.scalars().all()

        failure_reasons: Dict[str, int] = {}
        for reason in failure_rows:
            if reason:
                # Split multiple reasons
                for r in reason.split("; "):
                    failure_reasons[r] = failure_reasons.get(r, 0) + 1

        return VersionStatistics(
            version_id=version_id,
            version_name=version_name,
            sync_count=sync_count,
            evaluated_count=evaluated_count,
            failed_count=failed_count,
            issue_count=issue_count,
            avg_faithfulness=float(row.avg_faithfulness) if row and row.avg_faithfulness else None,
            avg_groundedness=float(row.avg_groundedness) if row and row.avg_groundedness else None,
            avg_query_context_relevance=float(row.avg_qcr) if row and row.avg_qcr else None,
            avg_context_relevance=float(row.avg_cr) if row and row.avg_cr else None,
            avg_answer_relevancy=float(row.avg_ar) if row and row.avg_ar else None,
            avg_relevance_llm=float(row.avg_rl) if row and row.avg_rl else None,
            avg_context_precision_emb=float(row.avg_cp) if row and row.avg_cp else None,
            avg_context_diversity=float(row.avg_cd) if row and row.avg_cd else None,
            avg_context_utilization=float(row.avg_cu) if row and row.avg_cu else None,
            avg_coherence=float(row.avg_coh) if row and row.avg_coh else None,
            avg_harmlessness=float(row.avg_harm) if row and row.avg_harm else None,
            avg_total_score=float(row.avg_total) if row and row.avg_total else None,
            issue_distribution=issue_distribution,
            failure_reasons=failure_reasons,
        )

    def _get_status(self, score: Optional[float]) -> str:
        """Get status emoji based on score."""
        if score is None:
            return "⚪"
        if score >= 0.7:
            return "🟢"
        if score >= 0.6:
            return "🟡"
        return "🔴"

    async def _generate_llm_suggestions(self, stats: VersionStatistics) -> str:
        """Generate optimization suggestions using LLM."""
        if not settings.ANALYSIS_LLM_API_KEY:
            return "暂无优化建议（LLM API 未配置）"

        # Build issue distribution table
        issue_table = ""
        if stats.issue_distribution:
            for issue_type, count in sorted(
                stats.issue_distribution.items(), key=lambda x: x[1], reverse=True
            ):
                issue_table += f"| {issue_type} | {count} |\n"
        else:
            issue_table = "无问题数据"

        # Build failure reasons table
        failure_table = ""
        if stats.failure_reasons:
            for reason, count in sorted(
                stats.failure_reasons.items(), key=lambda x: x[1], reverse=True
            ):
                failure_table += f"| {reason} | {count} |\n"
        else:
            failure_table = "无失败数据"

        # Build prompt
        failed_rate = stats.failed_count / stats.evaluated_count if stats.evaluated_count > 0 else 0
        issue_rate = stats.issue_count / stats.evaluated_count if stats.evaluated_count > 0 else 0

        prompt = WEEKLY_REPORT_SUGGESTION_PROMPT.format(
            version_name=stats.version_name,
            sync_count=stats.sync_count,
            evaluated_count=stats.evaluated_count,
            failed_count=stats.failed_count,
            failed_rate=failed_rate,
            issue_count=stats.issue_count,
            issue_rate=issue_rate,
            avg_faithfulness=stats.avg_faithfulness or 0,
            status_faithfulness=self._get_status(stats.avg_faithfulness),
            avg_groundedness=stats.avg_groundedness or 0,
            status_groundedness=self._get_status(stats.avg_groundedness),
            avg_qcr=stats.avg_query_context_relevance or 0,
            status_qcr=self._get_status(stats.avg_query_context_relevance),
            avg_cr=stats.avg_context_relevance or 0,
            status_cr=self._get_status(stats.avg_context_relevance),
            avg_ar=stats.avg_answer_relevancy or 0,
            avg_rl=stats.avg_relevance_llm or 0,
            avg_cp=stats.avg_context_precision_emb or 0,
            avg_cd=stats.avg_context_diversity or 0,
            avg_cu=stats.avg_context_utilization or 0,
            avg_coh=stats.avg_coherence or 0,
            avg_harm=stats.avg_harmlessness or 0,
            issue_distribution_table=issue_table,
            failure_reasons_table=failure_table,
        )

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    f"{settings.ANALYSIS_LLM_BASE_URL}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {settings.ANALYSIS_LLM_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": settings.ANALYSIS_LLM_MODEL,
                        "messages": [
                            {"role": "system", "content": "你是一位专业的 RAG 系统质量评估专家。"},
                            {"role": "user", "content": prompt},
                        ],
                        "temperature": 0.3,
                        "max_tokens": 500,
                    },
                )
                response.raise_for_status()
                data = response.json()
                return data["choices"][0]["message"]["content"]
        except Exception as e:
            logger.exception("Failed to generate LLM suggestions", error=str(e))
            return f"优化建议生成失败: {str(e)}"

    def _build_markdown_report(self, stats: VersionStatistics, suggestions: str) -> str:
        """Build the markdown report."""
        generated_at = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        failed_rate = stats.failed_count / stats.evaluated_count if stats.evaluated_count > 0 else 0
        issue_rate = stats.issue_count / stats.evaluated_count if stats.evaluated_count > 0 else 0

        # Build issue distribution table
        issue_table = ""
        total_issue_types = sum(stats.issue_distribution.values()) if stats.issue_distribution else 0
        for issue_type, count in sorted(
            stats.issue_distribution.items(), key=lambda x: x[1], reverse=True
        ):
            pct = count / total_issue_types if total_issue_types > 0 else 0
            issue_table += f"| {issue_type} | {count} | {pct:.1%} |\n"

        if not issue_table:
            issue_table = "| 无 | - | - |\n"

        # Build failure reasons table
        failure_table = ""
        for reason, count in sorted(
            stats.failure_reasons.items(), key=lambda x: x[1], reverse=True
        ):
            pct = count / stats.failed_count if stats.failed_count > 0 else 0
            failure_table += f"| {reason} | {count} | {pct:.1%} |\n"

        if not failure_table:
            failure_table = "| 无 | - | - |\n"

        # Format optional values
        def fmt(v: Optional[float], decimals: int = 2) -> str:
            return f"{v:.{decimals}f}" if v is not None else "-"

        return f"""# RAG 评估周报 - {stats.version_name}

> 生成时间：{generated_at}

---

## 一、数据概览

| 指标 | 数值 |
|------|------|
| 同步数据量 | {stats.sync_count} |
| 已评估数量 | {stats.evaluated_count} |
| 失败样本数 | {stats.failed_count} ({failed_rate:.1%}) |
| 问题数据数 | {stats.issue_count} ({issue_rate:.1%}) |
| **综合评分** | **{fmt(stats.avg_total_score, 1)}** |

---

## 二、核心指标 (Tier 1)

| 指标 | 分数 | 状态 |
|------|------|------|
| Faithfulness (忠实度) | {fmt(stats.avg_faithfulness)} | {self._get_status(stats.avg_faithfulness)} |
| Groundedness (有据性) | {fmt(stats.avg_groundedness)} | {self._get_status(stats.avg_groundedness)} |
| Query-Context Relevance (查询-上下文相关性) | {fmt(stats.avg_query_context_relevance)} | {self._get_status(stats.avg_query_context_relevance)} |
| Context Relevance (上下文相关性) | {fmt(stats.avg_context_relevance)} | {self._get_status(stats.avg_context_relevance)} |

> 状态说明：🟢 ≥0.7 良好 | 🟡 0.6-0.7 待优化 | 🔴 <0.6 需关注

---

## 三、关键指标 (Tier 2)

| 指标 | 分数 |
|------|------|
| Answer Relevancy (答案相关性) | {fmt(stats.avg_answer_relevancy)} |
| Relevance LLM (LLM相关性) | {fmt(stats.avg_relevance_llm)} |
| Context Precision (上下文精度) | {fmt(stats.avg_context_precision_emb)} |

---

## 四、诊断指标 (Tier 3)

| 指标 | 分数 |
|------|------|
| Context Diversity (上下文多样性) | {fmt(stats.avg_context_diversity)} |
| Context Utilization (上下文利用率) | {fmt(stats.avg_context_utilization)} |
| Coherence (连贯性) | {fmt(stats.avg_coherence)} |
| Harmlessness (安全性) | {fmt(stats.avg_harmlessness)} |

---

## 五、问题分析

### 5.1 问题类型分布

| 问题类型 | 数量 | 占比 |
|---------|------|------|
{issue_table}

### 5.2 硬阈值失败原因

| 失败原因 | 数量 | 占比 |
|---------|------|------|
{failure_table}

---

## 六、优化建议

{suggestions}

---

*报告由 Wegent Evaluate 系统自动生成*
"""
