"""
LLM analyzer for generating detailed analysis and suggestions.
"""
import json
from typing import Any, Dict, Optional

import structlog
from langchain_openai import ChatOpenAI

from app.core.config import settings

logger = structlog.get_logger(__name__)

# English prompt template
ANALYSIS_PROMPT_EN = """You are an expert in evaluating RAG (Retrieval-Augmented Generation) system quality.
Analyze the following Q&A interaction and provide a detailed assessment.

## User Question
{user_prompt}

## Retrieved Context
{extracted_text}

## AI Answer
{assistant_answer}

## RAGAS Evaluation Scores
- Faithfulness: {faithfulness_score} (How much the answer is grounded in the retrieved context, 0-1)
- Answer Relevancy: {answer_relevancy_score} (How relevant the answer is to the question, 0-1)
- Context Precision: {context_precision_score} (Quality of the retrieved context, 0-1)
- Overall Score: {overall_score}

## Your Task
Analyze this interaction and provide a structured JSON response with the following format:

```json
{{
  "quality_assessment": {{
    "overall_quality": "good|acceptable|poor",
    "answer_accuracy": "Brief evaluation of answer accuracy",
    "answer_completeness": "Brief evaluation of answer completeness",
    "strengths": ["strength1", "strength2"],
    "weaknesses": ["weakness1", "weakness2"]
  }},
  "retrieval_diagnosis": {{
    "retrieval_quality": "good|acceptable|poor",
    "relevance_analysis": "Analysis of how relevant the retrieved content is",
    "coverage_analysis": "Analysis of how well the retrieved content covers the question",
    "issues": ["issue1", "issue2"],
    "root_cause": "Possible root cause if issues exist"
  }},
  "improvement_suggestions": [
    {{
      "category": "retrieval|prompt|knowledge_base|model",
      "suggestion": "Specific improvement suggestion",
      "priority": "high|medium|low",
      "expected_impact": "Expected improvement effect"
    }}
  ],
  "has_critical_issue": true|false,
  "issue_types": ["retrieval_miss", "answer_hallucination", "incomplete_answer", "answer_irrelevant", "retrieval_irrelevant", "knowledge_gap"],
  "summary": "One sentence summary of the Q&A quality"
}}
```

Important:
- Only include issue_types that actually apply to this case
- Be specific and actionable in your suggestions
- Base your analysis on the actual content and scores provided
- Respond ONLY with the JSON, no additional text
"""

# Chinese prompt template
ANALYSIS_PROMPT_ZH = """你是一位 RAG（检索增强生成）系统质量评估专家。
请分析以下问答交互，并提供详细的评估报告。

## 用户问题
{user_prompt}

## 检索到的上下文
{extracted_text}

## AI 回答
{assistant_answer}

## RAGAS 评估分数
- 忠实度 (Faithfulness): {faithfulness_score}（回答与检索内容的一致程度，0-1）
- 答案相关性 (Answer Relevancy): {answer_relevancy_score}（回答与问题的相关程度，0-1）
- 上下文精确度 (Context Precision): {context_precision_score}（检索内容的质量，0-1）
- 综合得分: {overall_score}

## 你的任务
分析此交互并提供以下格式的结构化 JSON 响应：

```json
{{
  "quality_assessment": {{
    "overall_quality": "good|acceptable|poor",
    "answer_accuracy": "对回答准确性的简要评估",
    "answer_completeness": "对回答完整性的简要评估",
    "strengths": ["优点1", "优点2"],
    "weaknesses": ["缺点1", "缺点2"]
  }},
  "retrieval_diagnosis": {{
    "retrieval_quality": "good|acceptable|poor",
    "relevance_analysis": "检索内容相关性分析",
    "coverage_analysis": "检索内容覆盖度分析",
    "issues": ["问题1", "问题2"],
    "root_cause": "如存在问题，分析可能的根本原因"
  }},
  "improvement_suggestions": [
    {{
      "category": "retrieval|prompt|knowledge_base|model",
      "suggestion": "具体的改进建议",
      "priority": "high|medium|low",
      "expected_impact": "预期改进效果"
    }}
  ],
  "has_critical_issue": true|false,
  "issue_types": ["retrieval_miss", "answer_hallucination", "incomplete_answer", "answer_irrelevant", "retrieval_irrelevant", "knowledge_gap"],
  "summary": "一句话总结问答质量"
}}
```

重要提示：
- 只包含实际适用于此案例的 issue_types
- 建议要具体且可操作
- 基于提供的实际内容和分数进行分析
- 只返回 JSON，不要添加其他文本
- 所有分析内容请使用中文
"""

# Category translations
CATEGORY_TRANSLATIONS = {
    "zh": {
        "retrieval": "检索",
        "prompt": "提示词",
        "knowledge_base": "知识库",
        "model": "模型",
        "general": "通用",
    },
    "en": {
        "retrieval": "retrieval",
        "prompt": "prompt",
        "knowledge_base": "knowledge_base",
        "model": "model",
        "general": "general",
    },
}

# Priority translations
PRIORITY_TRANSLATIONS = {
    "zh": {
        "high": "高",
        "medium": "中",
        "low": "低",
    },
    "en": {
        "high": "HIGH",
        "medium": "MEDIUM",
        "low": "LOW",
    },
}

# Default message translations
DEFAULT_MESSAGES = {
    "zh": {
        "no_suggestions": "暂无具体改进建议。",
    },
    "en": {
        "no_suggestions": "No specific improvement suggestions.",
    },
}


class LLMAnalyzer:
    """LLM analyzer for generating detailed analysis and suggestions."""

    def __init__(self):
        self._llm = None
        self._language = settings.ANALYSIS_LANGUAGE

    @property
    def llm(self):
        """Get or create LLM instance."""
        if self._llm is None:
            self._llm = ChatOpenAI(
                model=settings.ANALYSIS_LLM_MODEL,
                api_key=settings.ANALYSIS_LLM_API_KEY,
                base_url=settings.ANALYSIS_LLM_BASE_URL,
                temperature=0,
            )
        return self._llm

    def _get_prompt_template(self) -> str:
        """Get the appropriate prompt template based on language setting."""
        if self._language == "zh":
            return ANALYSIS_PROMPT_ZH
        return ANALYSIS_PROMPT_EN

    async def analyze(
        self,
        user_prompt: str,
        assistant_answer: str,
        extracted_text: str,
        faithfulness_score: Optional[float],
        answer_relevancy_score: Optional[float],
        context_precision_score: Optional[float],
        overall_score: Optional[float],
    ) -> Dict[str, Any]:
        """
        Generate detailed analysis for a RAG response.

        Args:
            user_prompt: The user's question
            assistant_answer: The AI's response
            extracted_text: The retrieved context
            faithfulness_score: RAGAS faithfulness score
            answer_relevancy_score: RAGAS answer relevancy score
            context_precision_score: RAGAS context precision score
            overall_score: Overall evaluation score

        Returns:
            Structured analysis dictionary
        """
        try:
            prompt_template = self._get_prompt_template()
            prompt = prompt_template.format(
                user_prompt=user_prompt,
                extracted_text=extracted_text[:5000] if extracted_text else "N/A",
                assistant_answer=assistant_answer[:3000] if assistant_answer else "N/A",
                faithfulness_score=f"{faithfulness_score:.2f}" if faithfulness_score else "N/A",
                answer_relevancy_score=f"{answer_relevancy_score:.2f}" if answer_relevancy_score else "N/A",
                context_precision_score=f"{context_precision_score:.2f}" if context_precision_score else "N/A",
                overall_score=f"{overall_score:.2f}" if overall_score else "N/A",
            )

            response = await self.llm.ainvoke(prompt)
            content = response.content.strip()

            # Extract JSON from response
            if content.startswith("```json"):
                content = content[7:]
            if content.startswith("```"):
                content = content[3:]
            if content.endswith("```"):
                content = content[:-3]

            analysis = json.loads(content.strip())

            # Generate summary suggestions
            suggestions_summary = self._generate_suggestions_summary(analysis)

            return {
                "analysis": analysis,
                "suggestions_summary": suggestions_summary,
                "has_issue": analysis.get("has_critical_issue", False),
                "issue_types": analysis.get("issue_types", []),
            }

        except Exception as e:
            logger.exception("LLM analysis failed", error=str(e))
            raise

    def _generate_suggestions_summary(self, analysis: Dict[str, Any]) -> str:
        """Generate a text summary of improvement suggestions."""
        suggestions = analysis.get("improvement_suggestions", [])
        if not suggestions:
            return DEFAULT_MESSAGES.get(self._language, DEFAULT_MESSAGES["en"])["no_suggestions"]

        lines = []
        priority_trans = PRIORITY_TRANSLATIONS.get(self._language, PRIORITY_TRANSLATIONS["en"])
        category_trans = CATEGORY_TRANSLATIONS.get(self._language, CATEGORY_TRANSLATIONS["en"])

        for i, suggestion in enumerate(suggestions, 1):
            priority = suggestion.get("priority", "medium")
            category = suggestion.get("category", "general")
            text = suggestion.get("suggestion", "")

            # Translate priority and category
            priority_display = priority_trans.get(priority, priority.upper())
            category_display = category_trans.get(category, category)

            lines.append(f"{i}. [{priority_display}] ({category_display}) {text}")

        return "\n".join(lines)


# Global analyzer instance
llm_analyzer = LLMAnalyzer()
