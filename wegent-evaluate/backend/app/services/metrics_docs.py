"""
Metrics documentation definitions for RAGAS and TruLens evaluation metrics.
"""
from typing import Any, Dict, List

# All metrics documentation
METRICS_DOCUMENTATION: List[Dict[str, Any]] = [
    # RAGAS Embedding-based metrics
    {
        "id": "ragas_query_context_relevance",
        "name": "Query Context Relevance",
        "name_zh": "查询上下文相关性",
        "framework": "ragas",
        "signal_source": "embedding",
        "description": "Evaluates the semantic relevance between the retrieved context and user query.",
        "description_zh": "评估检索上下文与用户查询的语义相关性。",
        "implementation": "Uses embedding model to encode query and each context chunk as vectors, then calculates cosine similarity between query vector and each context vector, returning the average similarity.",
        "implementation_zh": "使用Embedding模型将query和每个context chunk编码为向量，计算query向量与每个context向量的余弦相似度，对所有context的相似度取平均值。",
        "formula": "score = mean([cosine_similarity(embed(query), embed(context_i)) for context_i in contexts])",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.8, "label": "Excellent"},
            "good": {"min": 0.6, "label": "Good"},
            "fair": {"min": 0.4, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Improvement"}
        }
    },
    {
        "id": "ragas_context_precision_emb",
        "name": "Context Precision (Embedding)",
        "name_zh": "上下文精确度",
        "framework": "ragas",
        "signal_source": "embedding",
        "description": "Evaluates the ratio of truly relevant content in retrieved results, measuring retrieval precision.",
        "description_zh": "评估检索结果中真正相关内容的占比，衡量检索的精准性。",
        "implementation": "For each retrieved context chunk, calculate relevance score with query. Set a relevance threshold and count chunks exceeding the threshold. Precision = relevant chunks / total chunks.",
        "implementation_zh": "对每个检索到的context chunk计算与query的相关性得分，设定相关性阈值，统计超过阈值的chunk数量。精确度 = 相关chunk数 / 总chunk数。",
        "formula": "precision = count(similarity(query, context_i) >= threshold) / len(contexts)",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.8, "label": "Excellent"},
            "good": {"min": 0.6, "label": "Good"},
            "fair": {"min": 0.4, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Improvement"}
        }
    },
    {
        "id": "ragas_context_diversity",
        "name": "Context Diversity",
        "name_zh": "上下文多样性",
        "framework": "ragas",
        "signal_source": "embedding",
        "description": "Evaluates the information diversity of retrieved results, avoiding repetitive or highly similar content.",
        "description_zh": "评估检索结果的信息多样性，避免返回重复或高度相似的内容。",
        "implementation": "Calculate pairwise similarity between all retrieved context chunks. Diversity score = 1 - average pairwise similarity.",
        "implementation_zh": "计算检索到的各context chunk之间的两两相似度。多样性得分 = 1 - 平均相似度。",
        "formula": "diversity = 1 - mean([cosine_sim(context_i, context_j) for i < j])",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.7, "label": "Excellent"},
            "good": {"min": 0.5, "label": "Good"},
            "fair": {"min": 0.3, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Improvement"}
        }
    },
    # RAGAS LLM-based metrics
    {
        "id": "faithfulness_score",
        "name": "Faithfulness",
        "name_zh": "忠实度",
        "framework": "ragas",
        "signal_source": "llm",
        "description": "Evaluates whether the answer is faithful to the provided context, without hallucination.",
        "description_zh": "评估答案是否忠实于提供的上下文，无幻觉内容。",
        "implementation": "Uses LLM to decompose the answer into independent claims, then judge whether each claim can be inferred from the context. Faithfulness = verifiable claims / total claims.",
        "implementation_zh": "使用LLM将答案分解为多个独立声明(claims)，对每个声明判断是否能从上下文中推断出来。忠实度 = 可验证声明数 / 总声明数。",
        "formula": "faithfulness = supported_claims / total_claims",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.9, "label": "Excellent"},
            "good": {"min": 0.7, "label": "Good"},
            "fair": {"min": 0.5, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Improvement"}
        }
    },
    {
        "id": "answer_relevancy_score",
        "name": "Answer Relevancy",
        "name_zh": "答案相关性",
        "framework": "ragas",
        "signal_source": "llm",
        "description": "Evaluates how relevant the generated answer is to the user's question.",
        "description_zh": "评估生成的答案与用户问题的相关程度。",
        "implementation": "Uses LLM to generate possible questions based on the answer, then calculate semantic similarity between generated questions and the original question. Higher similarity indicates more on-topic answer.",
        "implementation_zh": "使用LLM根据答案反向生成可能的问题，计算生成问题与原始问题的语义相似度。相似度越高说明答案越切题。",
        "formula": "relevancy = mean([similarity(original_q, generated_q_i)])",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.8, "label": "Excellent"},
            "good": {"min": 0.6, "label": "Good"},
            "fair": {"min": 0.4, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Improvement"}
        }
    },
    {
        "id": "context_precision_score",
        "name": "Context Precision (LLM)",
        "name_zh": "上下文精确度(LLM)",
        "framework": "ragas",
        "signal_source": "llm",
        "description": "Uses LLM to evaluate the quality and relevance of retrieved context.",
        "description_zh": "使用LLM评估检索上下文的质量和相关性。",
        "implementation": "LLM directly evaluates whether retrieved context is relevant and useful for answering the question.",
        "implementation_zh": "LLM直接评估检索到的上下文是否与问题相关且有助于回答问题。",
        "formula": "LLM judgment score",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.8, "label": "Excellent"},
            "good": {"min": 0.6, "label": "Good"},
            "fair": {"min": 0.4, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Improvement"}
        }
    },
    {
        "id": "ragas_context_utilization",
        "name": "Context Utilization",
        "name_zh": "上下文利用率",
        "framework": "ragas",
        "signal_source": "llm",
        "description": "Evaluates how well the answer utilizes information from the retrieved context.",
        "description_zh": "评估答案对检索上下文信息的利用程度。",
        "implementation": "Uses LLM to analyze how much information in the answer comes from the context, calculating the ratio of context information referenced.",
        "implementation_zh": "使用LLM分析答案中有多少信息来自上下文，计算上下文信息被引用的比例。",
        "formula": "utilization = referenced_context_info / relevant_context_info",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.7, "label": "Excellent"},
            "good": {"min": 0.5, "label": "Good"},
            "fair": {"min": 0.3, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Improvement"}
        }
    },
    {
        "id": "ragas_coherence",
        "name": "Coherence (RAGAS)",
        "name_zh": "连贯性(RAGAS)",
        "framework": "ragas",
        "signal_source": "llm",
        "description": "Evaluates the logical coherence and fluency of the answer.",
        "description_zh": "评估答案的逻辑连贯性和语言流畅度。",
        "implementation": "Uses LLM to evaluate the answer's structural completeness, logical flow, and readability, giving a comprehensive score across multiple dimensions.",
        "implementation_zh": "使用LLM评估答案的结构完整性、逻辑性、可读性，综合多个维度给出评分。",
        "formula": "LLM coherence judgment",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.8, "label": "Excellent"},
            "good": {"min": 0.6, "label": "Good"},
            "fair": {"min": 0.4, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Improvement"}
        }
    },
    # TruLens Embedding-based metrics
    {
        "id": "trulens_context_relevance",
        "name": "Context Relevance (TruLens)",
        "name_zh": "上下文相关性(TruLens)",
        "framework": "trulens",
        "signal_source": "embedding",
        "description": "Evaluates the semantic match between retrieved content and question.",
        "description_zh": "评估检索内容与问题的语义匹配度。",
        "implementation": "Uses embedding to calculate vector similarity between question and context.",
        "implementation_zh": "使用Embedding计算问题与上下文的向量相似度。",
        "formula": "relevance = cosine_similarity(embed(query), embed(context))",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.8, "label": "Excellent"},
            "good": {"min": 0.6, "label": "Good"},
            "fair": {"min": 0.4, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Improvement"}
        },
        "cross_validation_pair": {
            "paired_metric": "ragas_query_context_relevance",
            "paired_framework": "ragas"
        }
    },
    {
        "id": "trulens_relevance_embedding",
        "name": "Relevance (Embedding)",
        "name_zh": "相关性(Embedding版)",
        "framework": "trulens",
        "signal_source": "embedding",
        "description": "Evaluates the semantic relevance between answer and question using embeddings.",
        "description_zh": "评估答案与问题的语义相关程度(Embedding版)。",
        "implementation": "Uses embedding to calculate vector similarity between question and answer.",
        "implementation_zh": "使用Embedding计算问题与答案的向量相似度。",
        "formula": "relevance = cosine_similarity(embed(query), embed(answer))",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.8, "label": "Excellent"},
            "good": {"min": 0.6, "label": "Good"},
            "fair": {"min": 0.4, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Improvement"}
        }
    },
    # TruLens LLM-based metrics
    {
        "id": "trulens_groundedness",
        "name": "Groundedness",
        "name_zh": "基础性",
        "framework": "trulens",
        "signal_source": "llm",
        "description": "Evaluates whether the answer is generated based on the provided context, not fabricated.",
        "description_zh": "评估答案是否基于提供的上下文生成，而非凭空编造。",
        "implementation": "Uses LLM to check each sentence of the answer for context support, calculating the ratio of supported sentences.",
        "implementation_zh": "使用LLM逐句检查答案内容是否有上下文支撑，计算有支撑的句子比例。",
        "formula": "groundedness = supported_sentences / total_sentences",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.9, "label": "Excellent"},
            "good": {"min": 0.7, "label": "Good"},
            "fair": {"min": 0.5, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Improvement"}
        },
        "cross_validation_pair": {
            "paired_metric": "faithfulness_score",
            "paired_framework": "ragas"
        }
    },
    {
        "id": "trulens_relevance_llm",
        "name": "Relevance (LLM)",
        "name_zh": "相关性(LLM版)",
        "framework": "trulens",
        "signal_source": "llm",
        "description": "Uses LLM to judge the relevance between answer and question.",
        "description_zh": "使用LLM判断答案与问题的相关程度。",
        "implementation": "LLM directly evaluates whether the answer correctly addresses the question, giving a 0-1 relevance score.",
        "implementation_zh": "LLM直接评估答案是否正确回答了问题，给出0-1的相关性评分。",
        "formula": "LLM relevance judgment",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.8, "label": "Excellent"},
            "good": {"min": 0.6, "label": "Good"},
            "fair": {"min": 0.4, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Improvement"}
        },
        "cross_validation_pair": {
            "paired_metric": "answer_relevancy_score",
            "paired_framework": "ragas"
        }
    },
    {
        "id": "trulens_coherence",
        "name": "Coherence (TruLens)",
        "name_zh": "连贯性(TruLens)",
        "framework": "trulens",
        "signal_source": "llm",
        "description": "Evaluates the logical coherence of the answer.",
        "description_zh": "评估答案的逻辑连贯性。",
        "implementation": "LLM evaluates the answer's language fluency and logical flow.",
        "implementation_zh": "LLM评估答案的语言流畅度和逻辑性。",
        "formula": "LLM coherence judgment",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.8, "label": "Excellent"},
            "good": {"min": 0.6, "label": "Good"},
            "fair": {"min": 0.4, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Improvement"}
        }
    },
    {
        "id": "trulens_harmlessness",
        "name": "Harmlessness",
        "name_zh": "无害性",
        "framework": "trulens",
        "signal_source": "llm",
        "description": "Detects whether the answer contains harmful, inappropriate, or dangerous content.",
        "description_zh": "检测答案是否包含有害、不当或危险内容。",
        "implementation": "LLM checks the answer for harmful information including: violence, discrimination, incorrect medical advice, etc.",
        "implementation_zh": "LLM检查答案中是否包含有害信息，包括：暴力、歧视、错误医疗建议等。",
        "formula": "LLM safety judgment",
        "score_range": {
            "min": 0,
            "max": 1,
            "direction": "higher_better"
        },
        "interpretation": {
            "excellent": {"min": 0.95, "label": "Excellent"},
            "good": {"min": 0.8, "label": "Good"},
            "fair": {"min": 0.6, "label": "Fair"},
            "poor": {"min": 0, "label": "Needs Attention"}
        }
    },
]


def get_all_metrics() -> List[Dict[str, Any]]:
    """Get all metrics documentation."""
    return METRICS_DOCUMENTATION


def get_metric_by_id(metric_id: str) -> Dict[str, Any] | None:
    """Get a single metric documentation by ID."""
    for metric in METRICS_DOCUMENTATION:
        if metric["id"] == metric_id:
            return metric
    return None


def get_metrics_by_framework(framework: str) -> List[Dict[str, Any]]:
    """Get metrics filtered by framework (ragas or trulens)."""
    return [m for m in METRICS_DOCUMENTATION if m["framework"] == framework]


def get_metrics_by_signal_source(signal_source: str) -> List[Dict[str, Any]]:
    """Get metrics filtered by signal source (embedding or llm)."""
    return [m for m in METRICS_DOCUMENTATION if m["signal_source"] == signal_source]


def get_cross_validation_pairs() -> List[Dict[str, Any]]:
    """Get metrics that have cross-validation pairs."""
    return [m for m in METRICS_DOCUMENTATION if "cross_validation_pair" in m]
