"""
Diagnostic analyzer service for generating LLM-based diagnostic reports.
Supports Chinese and English output (default: Chinese).
"""
import json
from typing import Any, Dict, List, Optional

import structlog
from langchain_openai import ChatOpenAI

from app.core.config import settings

logger = structlog.get_logger(__name__)


# Chinese prompt templates
RAGAS_ANALYSIS_PROMPT_ZH = """你是一位RAG系统质量评估专家。请根据以下RAGAS评估指标，分析系统性能并给出优化建议。

## 评估框架: RAGAS

## 评估结果:
{metrics_json}

## 指标说明:
- faithfulness_score: 答案对检索上下文的忠实度 (0-1, 越高越好)
- answer_relevancy_score: 答案与问题的相关性 (0-1, 越高越好)
- context_precision_score: 检索上下文的质量 (0-1, 越高越好)
- query_context_relevance: 查询与上下文的语义相关性 (0-1, 越高越好)
- context_precision_emb: 相关上下文块占比 (0-1, 越高越好)
- context_diversity: 检索内容的信息多样性 (0-1, 越高越好)
- context_utilization: 答案对上下文的利用程度 (0-1, 越高越好)
- coherence: 答案的逻辑连贯性和流畅度 (0-1, 越高越好)

请以如下JSON格式输出分析结果:

```json
{{
  "overall_rating": "excellent|good|fair|poor",
  "has_issues": true|false,
  "issues": [
    {{
      "metric": "<指标名称>",
      "score": <分数值>,
      "description": "<问题描述>",
      "severity": "high|medium|low"
    }}
  ],
  "suggestions": [
    {{
      "title": "<建议标题>",
      "description": "<具体描述>",
      "related_metrics": ["<相关指标1>", "<相关指标2>"]
    }}
  ],
  "priority_order": ["<最紧急>", "<次优先>", "..."],
  "summary": "<一句话总结>"
}}
```

重要提示:
- 仅为分数低于0.7的指标列出问题
- 建议应具体且可操作
- 仅返回JSON，不要添加其他文字
- 所有文本内容必须使用中文
"""

TRULENS_ANALYSIS_PROMPT_ZH = """你是一位RAG系统质量评估专家。请根据以下TruLens评估指标，分析系统性能并给出优化建议。

## 评估框架: TruLens

## 评估结果:
{metrics_json}

## 指标说明:
- context_relevance: 检索内容与问题的语义匹配度 (0-1, 越高越好)
- relevance_embedding: 答案与问题的语义相关性 (0-1, 越高越好)
- groundedness: 答案是否基于提供的上下文 (0-1, 越高越好)
- relevance_llm: LLM判断的答案与问题相关性 (0-1, 越高越好)
- coherence: 答案的逻辑连贯性 (0-1, 越高越好)
- harmlessness: 内容安全评分 (0-1, 越高越安全)

请以如下JSON格式输出分析结果:

```json
{{
  "overall_rating": "excellent|good|fair|poor",
  "has_issues": true|false,
  "issues": [
    {{
      "metric": "<指标名称>",
      "score": <分数值>,
      "description": "<问题描述>",
      "severity": "high|medium|low"
    }}
  ],
  "suggestions": [
    {{
      "title": "<建议标题>",
      "description": "<具体描述>",
      "related_metrics": ["<相关指标1>", "<相关指标2>"]
    }}
  ],
  "priority_order": ["<最紧急>", "<次优先>", "..."],
  "summary": "<一句话总结>"
}}
```

重要提示:
- 仅为分数低于0.7的指标列出问题 (harmlessness 应高于0.95)
- 建议应具体且可操作
- 仅返回JSON，不要添加其他文字
- 所有文本内容必须使用中文
"""

CROSS_VALIDATION_ANALYSIS_PROMPT_ZH = """你是一位RAG系统质量评估专家。请根据RAGAS和TruLens框架的交叉验证结果，提供全面的诊断报告。

## 交叉验证结果:
{cross_validation_json}

## RAGAS指标汇总:
{ragas_summary}

## TruLens指标汇总:
{trulens_summary}

## 交叉验证配对:
1. 检索相关性: RAGAS query_context_relevance vs TruLens context_relevance
2. 答案相关性: RAGAS answer_relevancy vs TruLens relevance_llm
3. 事实性: RAGAS faithfulness vs TruLens groundedness

告警阈值: 配对指标差异超过20% (0.2)

请以如下JSON格式输出分析结果:

```json
{{
  "overall_rating": "excellent|good|fair|poor",
  "has_issues": true|false,
  "framework_agreement": "high|medium|low",
  "discrepancies": [
    {{
      "pair_name": "<配对名称>",
      "ragas_score": <分数>,
      "trulens_score": <分数>,
      "difference": <差异>,
      "analysis": "<差异原因分析>"
    }}
  ],
  "issues": [
    {{
      "metric": "<指标或配对名称>",
      "score": <分数值>,
      "description": "<问题描述>",
      "severity": "high|medium|low"
    }}
  ],
  "suggestions": [
    {{
      "title": "<建议标题>",
      "description": "<具体描述>",
      "related_metrics": ["<相关指标1>", "<相关指标2>"]
    }}
  ],
  "priority_order": ["<最紧急>", "<次优先>", "..."],
  "summary": "<一句话总结>"
}}
```

重要提示:
- 重点关注超过20%阈值的框架间差异
- 分析可能导致差异的原因
- 提供可操作的改进建议
- 仅返回JSON，不要添加其他文字
- 所有文本内容必须使用中文
"""

# English prompt templates
RAGAS_ANALYSIS_PROMPT_EN = """You are a RAG system quality assessment expert. Based on the following RAGAS evaluation metrics, analyze system performance and provide optimization suggestions.

## Evaluation Framework: RAGAS

## Evaluation Results:
{metrics_json}

## Metric Descriptions:
- faithfulness_score: How faithful the answer is to the retrieved context (0-1, higher is better)
- answer_relevancy_score: How relevant the answer is to the question (0-1, higher is better)
- context_precision_score: Quality of the retrieved context (0-1, higher is better)
- query_context_relevance: Semantic relevance between query and context (0-1, higher is better)
- context_precision_emb: Ratio of relevant context chunks (0-1, higher is better)
- context_diversity: Information diversity of retrieved content (0-1, higher is better)
- context_utilization: How well the answer utilizes context (0-1, higher is better)
- coherence: Logical coherence and fluency of the answer (0-1, higher is better)

Please output analysis results in the following JSON format:

```json
{{
  "overall_rating": "excellent|good|fair|poor",
  "has_issues": true|false,
  "issues": [
    {{
      "metric": "<metric name>",
      "score": <score value>,
      "description": "<problem description>",
      "severity": "high|medium|low"
    }}
  ],
  "suggestions": [
    {{
      "title": "<suggestion title>",
      "description": "<specific description>",
      "related_metrics": ["<related metric 1>", "<related metric 2>"]
    }}
  ],
  "priority_order": ["<most urgent>", "<second priority>", "..."],
  "summary": "<one sentence summary>"
}}
```

Important:
- Only include issues for metrics scoring below 0.7
- Suggestions should be specific and actionable
- Respond ONLY with the JSON, no additional text
- All text content must be in English
"""

TRULENS_ANALYSIS_PROMPT_EN = """You are a RAG system quality assessment expert. Based on the following TruLens evaluation metrics, analyze system performance and provide optimization suggestions.

## Evaluation Framework: TruLens

## Evaluation Results:
{metrics_json}

## Metric Descriptions:
- context_relevance: Semantic match between retrieved content and question (0-1, higher is better)
- relevance_embedding: Semantic relevance between answer and question (0-1, higher is better)
- groundedness: Whether the answer is grounded in the provided context (0-1, higher is better)
- relevance_llm: LLM judgment of answer relevance to question (0-1, higher is better)
- coherence: Logical coherence of the answer (0-1, higher is better)
- harmlessness: Content safety score (0-1, higher is safer)

Please output analysis results in the following JSON format:

```json
{{
  "overall_rating": "excellent|good|fair|poor",
  "has_issues": true|false,
  "issues": [
    {{
      "metric": "<metric name>",
      "score": <score value>,
      "description": "<problem description>",
      "severity": "high|medium|low"
    }}
  ],
  "suggestions": [
    {{
      "title": "<suggestion title>",
      "description": "<specific description>",
      "related_metrics": ["<related metric 1>", "<related metric 2>"]
    }}
  ],
  "priority_order": ["<most urgent>", "<second priority>", "..."],
  "summary": "<one sentence summary>"
}}
```

Important:
- Only include issues for metrics scoring below 0.7 (except harmlessness which should be above 0.95)
- Suggestions should be specific and actionable
- Respond ONLY with the JSON, no additional text
- All text content must be in English
"""

CROSS_VALIDATION_ANALYSIS_PROMPT_EN = """You are a RAG system quality assessment expert. Based on the cross-validation results between RAGAS and TruLens frameworks, provide a comprehensive diagnostic report.

## Cross-Validation Results:
{cross_validation_json}

## RAGAS Metrics Summary:
{ragas_summary}

## TruLens Metrics Summary:
{trulens_summary}

## Cross-Validation Pairs:
1. Retrieval Relevance: RAGAS query_context_relevance vs TruLens context_relevance
2. Answer Relevance: RAGAS answer_relevancy vs TruLens relevance_llm
3. Factual Grounding: RAGAS faithfulness vs TruLens groundedness

Alert threshold: 20% (0.2) difference between paired metrics

Please output analysis results in the following JSON format:

```json
{{
  "overall_rating": "excellent|good|fair|poor",
  "has_issues": true|false,
  "framework_agreement": "high|medium|low",
  "discrepancies": [
    {{
      "pair_name": "<pair name>",
      "ragas_score": <score>,
      "trulens_score": <score>,
      "difference": <difference>,
      "analysis": "<explanation for the discrepancy>"
    }}
  ],
  "issues": [
    {{
      "metric": "<metric or pair name>",
      "score": <score value>,
      "description": "<problem description>",
      "severity": "high|medium|low"
    }}
  ],
  "suggestions": [
    {{
      "title": "<suggestion title>",
      "description": "<specific description>",
      "related_metrics": ["<related metric 1>", "<related metric 2>"]
    }}
  ],
  "priority_order": ["<most urgent>", "<second priority>", "..."],
  "summary": "<one sentence summary>"
}}
```

Important:
- Focus on discrepancies between frameworks that exceed the 20% threshold
- Analyze what might cause the differences
- Provide actionable suggestions for improvement
- Respond ONLY with the JSON, no additional text
- All text content must be in English
"""


class DiagnosticAnalyzer:
    """Service for generating LLM-based diagnostic analysis reports."""

    def __init__(self):
        self._llm = None

    @property
    def llm(self) -> ChatOpenAI:
        """Get or create LLM instance."""
        if self._llm is None:
            self._llm = ChatOpenAI(
                model=settings.ANALYSIS_LLM_MODEL,
                api_key=settings.ANALYSIS_LLM_API_KEY,
                base_url=settings.ANALYSIS_LLM_BASE_URL,
                temperature=0,
            )
        return self._llm

    def _get_prompts(self, language: str = "zh") -> Dict[str, str]:
        """Get prompt templates based on language."""
        if language == "en":
            return {
                "ragas": RAGAS_ANALYSIS_PROMPT_EN,
                "trulens": TRULENS_ANALYSIS_PROMPT_EN,
                "cross_validation": CROSS_VALIDATION_ANALYSIS_PROMPT_EN,
            }
        # Default to Chinese
        return {
            "ragas": RAGAS_ANALYSIS_PROMPT_ZH,
            "trulens": TRULENS_ANALYSIS_PROMPT_ZH,
            "cross_validation": CROSS_VALIDATION_ANALYSIS_PROMPT_ZH,
        }

    def _parse_llm_response(self, response_text: str) -> Dict[str, Any]:
        """Parse LLM response JSON."""
        try:
            text = response_text.strip()
            if text.startswith("```json"):
                text = text[7:]
            if text.startswith("```"):
                text = text[3:]
            if text.endswith("```"):
                text = text[:-3]
            return json.loads(text.strip())
        except json.JSONDecodeError as e:
            logger.warning("Failed to parse diagnostic analysis response", error=str(e))
            return {
                "overall_rating": "unknown",
                "has_issues": False,
                "issues": [],
                "suggestions": [],
                "priority_order": [],
                "summary": "Failed to generate analysis",
                "raw_response": response_text,
            }

    async def analyze_ragas(
        self,
        metrics: Dict[str, Optional[float]],
        language: str = "zh",
    ) -> Dict[str, Any]:
        """
        Generate diagnostic analysis for RAGAS metrics.

        Args:
            metrics: Dictionary of RAGAS metric scores
            language: Output language ('zh' for Chinese, 'en' for English)

        Returns:
            Diagnostic analysis report
        """
        try:
            # Filter out None values and format metrics
            filtered_metrics = {k: v for k, v in metrics.items() if v is not None}
            metrics_json = json.dumps(filtered_metrics, indent=2)

            prompts = self._get_prompts(language)
            prompt = prompts["ragas"].format(metrics_json=metrics_json)
            response = await self.llm.ainvoke(prompt)
            analysis = self._parse_llm_response(response.content)
            analysis["framework"] = "ragas"
            analysis["language"] = language
            analysis["raw_analysis"] = response.content

            return analysis

        except Exception as e:
            logger.exception("Failed to generate RAGAS analysis", error=str(e))
            return {
                "framework": "ragas",
                "language": language,
                "overall_rating": "unknown",
                "has_issues": False,
                "issues": [],
                "suggestions": [],
                "priority_order": [],
                "summary": f"分析失败: {str(e)}" if language == "zh" else f"Analysis failed: {str(e)}",
            }

    async def analyze_trulens(
        self,
        metrics: Dict[str, Optional[float]],
        language: str = "zh",
    ) -> Dict[str, Any]:
        """
        Generate diagnostic analysis for TruLens metrics.

        Args:
            metrics: Dictionary of TruLens metric scores
            language: Output language ('zh' for Chinese, 'en' for English)

        Returns:
            Diagnostic analysis report
        """
        try:
            # Filter out None values and format metrics
            filtered_metrics = {k: v for k, v in metrics.items() if v is not None}
            metrics_json = json.dumps(filtered_metrics, indent=2)

            prompts = self._get_prompts(language)
            prompt = prompts["trulens"].format(metrics_json=metrics_json)
            response = await self.llm.ainvoke(prompt)
            analysis = self._parse_llm_response(response.content)
            analysis["framework"] = "trulens"
            analysis["language"] = language
            analysis["raw_analysis"] = response.content

            return analysis

        except Exception as e:
            logger.exception("Failed to generate TruLens analysis", error=str(e))
            return {
                "framework": "trulens",
                "language": language,
                "overall_rating": "unknown",
                "has_issues": False,
                "issues": [],
                "suggestions": [],
                "priority_order": [],
                "summary": f"分析失败: {str(e)}" if language == "zh" else f"Analysis failed: {str(e)}",
            }

    async def analyze_cross_validation(
        self,
        cross_validation_results: Dict[str, Any],
        ragas_metrics: Dict[str, Optional[float]],
        trulens_metrics: Dict[str, Optional[float]],
        language: str = "zh",
    ) -> Dict[str, Any]:
        """
        Generate comprehensive diagnostic analysis based on cross-validation results.

        Args:
            cross_validation_results: Results from cross-validation service
            ragas_metrics: Dictionary of RAGAS metric scores
            trulens_metrics: Dictionary of TruLens metric scores
            language: Output language ('zh' for Chinese, 'en' for English)

        Returns:
            Comprehensive diagnostic analysis report
        """
        try:
            # Format inputs
            cv_json = json.dumps(cross_validation_results, indent=2)

            ragas_filtered = {k: v for k, v in ragas_metrics.items() if v is not None}
            ragas_summary = json.dumps(ragas_filtered, indent=2)

            trulens_filtered = {k: v for k, v in trulens_metrics.items() if v is not None}
            trulens_summary = json.dumps(trulens_filtered, indent=2)

            prompts = self._get_prompts(language)
            prompt = prompts["cross_validation"].format(
                cross_validation_json=cv_json,
                ragas_summary=ragas_summary,
                trulens_summary=trulens_summary,
            )

            response = await self.llm.ainvoke(prompt)
            analysis = self._parse_llm_response(response.content)
            analysis["framework"] = "cross_validation"
            analysis["language"] = language
            analysis["raw_analysis"] = response.content

            return analysis

        except Exception as e:
            logger.exception("Failed to generate cross-validation analysis", error=str(e))
            return {
                "framework": "cross_validation",
                "language": language,
                "overall_rating": "unknown",
                "has_issues": False,
                "framework_agreement": "unknown",
                "discrepancies": [],
                "issues": [],
                "suggestions": [],
                "priority_order": [],
                "summary": f"分析失败: {str(e)}" if language == "zh" else f"Analysis failed: {str(e)}",
            }

    async def analyze_all(
        self,
        ragas_metrics: Dict[str, Optional[float]],
        trulens_metrics: Dict[str, Optional[float]],
        cross_validation_results: Dict[str, Any],
        language: str = "zh",
    ) -> Dict[str, Any]:
        """
        Generate all diagnostic analyses.

        Args:
            ragas_metrics: Dictionary of RAGAS metric scores
            trulens_metrics: Dictionary of TruLens metric scores
            cross_validation_results: Results from cross-validation service
            language: Output language ('zh' for Chinese, 'en' for English)

        Returns:
            Dictionary containing all three analysis reports
        """
        import asyncio

        results = await asyncio.gather(
            self.analyze_ragas(ragas_metrics, language),
            self.analyze_trulens(trulens_metrics, language),
            self.analyze_cross_validation(
                cross_validation_results, ragas_metrics, trulens_metrics, language
            ),
            return_exceptions=True,
        )

        return {
            "ragas_analysis": results[0] if not isinstance(results[0], Exception) else None,
            "trulens_analysis": results[1] if not isinstance(results[1], Exception) else None,
            "overall_analysis": results[2] if not isinstance(results[2], Exception) else None,
        }


# Global analyzer instance
diagnostic_analyzer = DiagnosticAnalyzer()
