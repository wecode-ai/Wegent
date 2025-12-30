# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Gemini Search Tool for web search functionality.

This tool wraps Gemini LLM with Google Search to provide web search capability
as a standalone LangChain tool. This approach solves the limitation where
Gemini server forbids using google_search and other tools simultaneously.

IMPORTANT: This tool implements a "once per conversation turn" limit.
Within a single user-AI interaction, this tool can only be called ONCE.
Subsequent calls will return a short message asking the user to review
the previous research results.

Usage:
    from .gemini_search import GeminiSearchTool

    tool = GeminiSearchTool(
        model="gemini-2.0-flash",
        google_api_key="your-api-key",
    )
    result = tool.invoke({"query": "latest news about AI"})
"""

import logging
from typing import Any, ClassVar, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import BaseTool
from langchain_google_genai import ChatGoogleGenerativeAI
from pydantic import Field, PrivateAttr

logger = logging.getLogger(__name__)

# Built-in tool definition for Google web search
GOOGLE_WEB_SEARCH_TOOL = {"google_search": {}}

# Default system prompt for the internal research agent
# This prompt guides the internal LLM to act as a comprehensive research agent
# that thoroughly investigates topics and returns well-organized research reports
DEFAULT_SEARCH_SYSTEM_PROMPT = """You are a professional research agent specializing in comprehensive web research and analysis. Your task is to conduct thorough research on the given topic and provide a complete, well-organized research report.

## Your Role:
You are NOT a simple search engine. You are an intelligent research agent that:
- Understands the research topic deeply
- Searches multiple aspects of the topic proactively
- Synthesizes information from various sources
- Provides comprehensive analysis and insights

## Research Guidelines:
1. **Deep Investigation**: Thoroughly research ALL aspects of the topic. Consider:
   - Background and context
   - Current status and recent developments
   - Key players, stakeholders, or entities involved
   - Different perspectives and viewpoints
   - Related topics that provide important context

2. **Multi-dimensional Analysis**: Cover the topic from multiple angles:
   - Facts and data
   - Expert opinions and analysis
   - Historical context if relevant
   - Future implications or trends

3. **Source Quality**: Prioritize authoritative and reliable sources:
   - Official sources and documentation
   - Reputable news outlets and publications
   - Expert analysis and research papers
   - Verified statistics and data

4. **Completeness**: Your research report should be comprehensive enough that:
   - The user doesn't need to conduct additional searches
   - All major aspects of the topic are covered
   - Key questions about the topic are answered

## Research Report Format:
Structure your report clearly:

### Executive Summary
Brief overview of key findings (2-3 sentences)

### Key Findings
- Main facts and important information
- Organized by relevance and importance

### Detailed Analysis
- In-depth coverage of different aspects
- Supporting evidence and data
- Source attribution where available

### Additional Context
- Related information that provides valuable context
- Potential implications or considerations

### Limitations
- Note any areas where information was limited or uncertain

Remember: You are conducting comprehensive research, not just answering a simple query. Take the time to investigate thoroughly and provide a complete research report."""


def _extract_llm_config(llm: BaseChatModel) -> dict[str, Any]:
    """Extract configuration from an existing LLM instance.

    This function extracts the necessary configuration parameters from a
    ChatGoogleGenerativeAI instance (or a BoundRunnable wrapping one) to
    create a new, clean LLM instance for isolated internal use.

    Args:
        llm: The LLM instance to extract configuration from.

    Returns:
        A dictionary of configuration parameters for creating a new LLM.
    """
    # If it's a BoundRunnable (has tools bound), get the underlying LLM
    base_llm = llm
    while hasattr(base_llm, "bound"):
        base_llm = base_llm.bound

    # Extract configuration from the base LLM
    config: dict[str, Any] = {}

    # Model name
    if hasattr(base_llm, "model"):
        config["model"] = base_llm.model

    # API key - try different attribute names
    if hasattr(base_llm, "google_api_key"):
        api_key = base_llm.google_api_key
        # Handle SecretStr
        if hasattr(api_key, "get_secret_value"):
            config["google_api_key"] = api_key.get_secret_value()
        elif api_key:
            config["google_api_key"] = api_key

    # Temperature
    if hasattr(base_llm, "temperature") and base_llm.temperature is not None:
        config["temperature"] = base_llm.temperature

    # Base URL
    if hasattr(base_llm, "base_url") and base_llm.base_url:
        config["base_url"] = base_llm.base_url

    # Additional headers
    if hasattr(base_llm, "additional_headers") and base_llm.additional_headers:
        config["additional_headers"] = base_llm.additional_headers

    # Vertex AI settings
    if hasattr(base_llm, "_use_vertexai") and base_llm._use_vertexai:
        config["vertexai"] = True
        if hasattr(base_llm, "project") and base_llm.project:
            config["project"] = base_llm.project
        if hasattr(base_llm, "location") and base_llm.location:
            config["location"] = base_llm.location
        if hasattr(base_llm, "credentials") and base_llm.credentials:
            config["credentials"] = base_llm.credentials

    return config


# Message returned when the tool has already been called in this conversation turn
ALREADY_CALLED_MESSAGE = (
    "⚠️ This research tool has already been used in this conversation turn. "
    "Please review the research results provided above before requesting additional research. "
    "If you still need more information after reviewing, please ask in your next message."
)


class GeminiSearchTool(BaseTool):
    """A LangChain tool that uses Gemini with Google Search for web queries.

    This tool encapsulates a Gemini LLM instance with the google_search tool
    bound, allowing it to be used as a regular tool alongside other tools
    in the agent workflow.

    IMPORTANT: This tool implements a "once per conversation turn" limit.
    - Within a single user-AI interaction, this tool can only be called ONCE
    - Subsequent calls return a short message instead of executing research
    - This prevents token waste and ensures the model reviews previous results
    - Each new tool instance (new conversation turn) starts fresh

    This design follows the same pattern as LoadSkillTool for session-level caching.

    IMPORTANT: This tool creates a completely isolated LLM instance for internal
    summarization to prevent streaming tokens from leaking to the parent agent's
    stream. The internal LLM has streaming=False and no callbacks attached.

    Attributes:
        name: Tool name "gemini_search"
        description: Tool description for the LLM
        model: Gemini model name (e.g., "gemini-2.0-flash")
        google_api_key: Google API key for Gemini
        temperature: Model temperature setting
        base_url: Optional custom API endpoint
        additional_headers: Optional custom headers
    """

    name: ClassVar[str] = "gemini_search"
    description: ClassVar[str] = (
        "🔬 A HEAVYWEIGHT web research agent that conducts thorough, comprehensive research on any topic.\n\n"
        "⛔ CRITICAL CONSTRAINTS - READ BEFORE CALLING:\n"
        "1. **ONCE PER CONVERSATION**: This tool can ONLY be called ONCE per user message. "
        "If you call it again, you will receive an error instead of results.\n"
        "2. **TIME-INTENSIVE**: Takes 30-60+ seconds. Only use when web research is TRULY necessary.\n"
        "3. **DIRECT ANSWER FIRST**: If you can answer the user's question from your knowledge, "
        "DO NOT call this tool. Only call when current/real-time information is required.\n\n"
        "📝 HOW TO USE CORRECTLY:\n"
        "- Consolidate ALL your research needs into ONE comprehensive query\n"
        "- Provide a complete research topic, not a simple search query\n"
        "- Example: Instead of 'Python version', use 'Research Python programming language: "
        "latest version, new features in recent releases, ecosystem updates, and community trends'\n"
        "- The agent handles multi-aspect research internally - do NOT split into multiple calls\n\n"
        "✅ GOOD USE CASES: Current events, real-time data, recent news, fact-checking recent claims\n"
        "❌ BAD USE CASES: General knowledge questions, historical facts, conceptual explanations"
    )

    # Gemini LLM configuration
    model: str = Field(default="gemini-2.0-flash-exp", description="Gemini model name")
    google_api_key: str = Field(default="", description="Google API key")
    temperature: float = Field(default=1.0, description="Model temperature")
    base_url: Optional[str] = Field(default=None, description="Custom API endpoint")
    additional_headers: Optional[dict[str, str]] = Field(
        default=None, description="Custom headers"
    )

    # Optional pre-configured LLM instance (used to extract config, not used directly)
    llm: Optional[BaseChatModel] = Field(
        default=None,
        description="Pre-configured LLM instance to extract config from",
        exclude=True,
    )

    # Internal LLM instance (created lazily, completely isolated)
    _internal_llm: Any = PrivateAttr(default=None)

    # Private instance attribute for session-level call tracking (not shared between instances)
    # This tracks whether the tool has been called in the current conversation turn
    # Following the same pattern as LoadSkillTool._expanded_skills
    _called_this_turn: bool = PrivateAttr(default=False)

    def __init__(self, **data):
        """Initialize with fresh call tracking state."""
        super().__init__(**data)
        self._internal_llm = None
        self._called_this_turn = False

    def _get_llm(self) -> Any:
        """Get or create an isolated internal Gemini LLM instance with google_search.

        This method creates a completely new, isolated LLM instance for internal
        summarization. The instance has:
        - streaming=False to prevent streaming output
        - No callbacks attached
        - Only the google_search tool bound

        This ensures the internal summarization is a synchronous operation that
        returns a single string without emitting any events to the parent agent.

        Returns:
            LLM instance (RunnableBinding) with google_search tool bound
        """
        if self._internal_llm is not None:
            return self._internal_llm

        # Build params for the isolated internal LLM
        params: dict[str, Any] = {}

        if self.llm is not None:
            # Extract configuration from the provided LLM instance
            # This allows us to reuse API keys, base URLs, etc.
            # but create a completely new, isolated instance
            params = _extract_llm_config(self.llm)
            logger.info(
                "[GeminiSearchTool] Extracted config from provided LLM: model=%s",
                params.get("model", "unknown"),
            )
        else:
            # Use explicitly provided configuration
            params = {
                "model": self.model,
                "google_api_key": self.google_api_key,
                "temperature": self.temperature,
            }

            if self.base_url:
                params["base_url"] = self.base_url

            if self.additional_headers:
                params["additional_headers"] = self.additional_headers

        # CRITICAL: Ensure streaming is disabled for the internal LLM
        # This prevents tokens from being streamed to the frontend
        params["streaming"] = False

        # Create a completely new, isolated Gemini LLM instance
        internal_base_llm = ChatGoogleGenerativeAI(**params)

        # Bind only the google_search tool (no other tools)
        self._internal_llm = internal_base_llm.bind_tools([GOOGLE_WEB_SEARCH_TOOL])

        logger.info(
            "[GeminiSearchTool] Created isolated internal Gemini LLM with "
            "google_search, model=%s, streaming=False",
            params.get("model", self.model),
        )

        return self._internal_llm

    def _run(
        self,
        query: str,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Execute a web search query using Gemini with Google Search.

        This method implements a "once per conversation turn" limit:
        - First call: executes the research and returns results
        - Subsequent calls: returns a short message asking to review previous results

        This method uses a completely isolated LLM instance with streaming=False
        and no callbacks to ensure the internal summarization doesn't emit any
        events to the parent agent's stream.

        Args:
            query: The search query string
            run_manager: Optional callback manager for tool run (ignored for isolation)

        Returns:
            AI-summarized search results as a string, or a message if already called
        """
        # Check if already called in this conversation turn
        if self._called_this_turn:
            logger.warning(
                "[GeminiSearchTool] Tool already called this turn, returning limit message. "
                "Query was: %s",
                query,
            )
            return ALREADY_CALLED_MESSAGE

        logger.info("[GeminiSearchTool] Executing search for query: %s", query)

        # Mark as called BEFORE executing (to prevent race conditions in async scenarios)
        self._called_this_turn = True

        # Use completely isolated config with no callbacks
        # The internal LLM already has streaming=False, but we also ensure
        # no callbacks are attached to prevent any event emission
        isolated_config = {"callbacks": [], "run_name": "gemini_search_internal"}

        try:
            # Get the isolated internal LLM (streaming=False, no parent callbacks)
            llm = self._get_llm()

            # Always use the default search system prompt optimized for comprehensive searches
            messages = [
                SystemMessage(content=DEFAULT_SEARCH_SYSTEM_PROMPT),
                HumanMessage(content=query),
            ]
            response = llm.invoke(messages, config=isolated_config)

            # Extract content from response
            result = self._extract_content(response)

            logger.info(
                "[GeminiSearchTool] Search completed, result length: %d",
                len(result),
            )
            return result

        except Exception as e:
            error_msg = f"Search failed: {str(e)}. Please try rephrasing your query or proceed without search results."
            logger.error("[GeminiSearchTool] %s", error_msg)
            return error_msg

    async def _arun(
        self,
        query: str,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> str:
        """Execute a web search query asynchronously.

        This method implements a "once per conversation turn" limit:
        - First call: executes the research and returns results
        - Subsequent calls: returns a short message asking to review previous results

        This method uses a completely isolated LLM instance with streaming=False
        and no callbacks to ensure the internal summarization doesn't emit any
        events to the parent agent's stream.

        Args:
            query: The search query string
            run_manager: Optional callback manager for tool run (ignored for isolation)

        Returns:
            AI-summarized search results as a string, or a message if already called
        """
        # Check if already called in this conversation turn
        if self._called_this_turn:
            logger.warning(
                "[GeminiSearchTool] Tool already called this turn (async), returning limit message. "
                "Query was: %s",
                query,
            )
            return ALREADY_CALLED_MESSAGE

        logger.info("[GeminiSearchTool] Executing async search for query: %s", query)

        # Mark as called BEFORE executing (to prevent race conditions)
        self._called_this_turn = True

        # Use completely isolated config with no callbacks
        # The internal LLM already has streaming=False, but we also ensure
        # no callbacks are attached to prevent any event emission
        isolated_config = {"callbacks": [], "run_name": "gemini_search_internal"}

        try:
            # Get the isolated internal LLM (streaming=False, no parent callbacks)
            llm = self._get_llm()

            # Always use the default search system prompt optimized for comprehensive searches
            messages = [
                SystemMessage(content=DEFAULT_SEARCH_SYSTEM_PROMPT),
                HumanMessage(content=query),
            ]
            response = await llm.ainvoke(messages, config=isolated_config)

            # Extract content from response
            result = self._extract_content(response)

            logger.info(
                "[GeminiSearchTool] Async search completed, result length: %d",
                len(result),
            )
            return result

        except Exception as e:
            error_msg = f"Search failed: {str(e)}. Please try rephrasing your query or proceed without search results."
            logger.error("[GeminiSearchTool] %s", error_msg)
            return error_msg

    def has_been_called(self) -> bool:
        """Check if this tool has been called in the current conversation turn.

        Returns:
            True if the tool has been called, False otherwise
        """
        return self._called_this_turn

    def reset_call_state(self) -> None:
        """Reset the call state for a new conversation turn.

        Call this method when starting a new conversation turn
        (after the AI has finished responding to the user).
        """
        self._called_this_turn = False

    def _extract_content(self, response: Any) -> str:
        """Extract text content from an LLM response.

        Args:
            response: The LLM response object

        Returns:
            Extracted text content as a string
        """
        result = ""
        if hasattr(response, "content"):
            if isinstance(response.content, str):
                result = response.content
            elif isinstance(response.content, list):
                # Handle multimodal or structured responses
                text_parts = []
                for part in response.content:
                    if isinstance(part, str):
                        text_parts.append(part)
                    elif isinstance(part, dict) and part.get("type") == "text":
                        text_parts.append(part.get("text", ""))
                result = "".join(text_parts)
        return result


def create_gemini_search_tool(llm: ChatGoogleGenerativeAI) -> GeminiSearchTool:
    """Create a GeminiSearchTool instance from an existing ChatGoogleGenerativeAI.

    This factory function extracts configuration from the existing Gemini LLM
    instance and creates a completely isolated internal LLM for the search tool.
    This ensures:
    - The internal LLM has streaming=False
    - No callbacks from the parent agent are attached
    - The search summarization is a synchronous operation
    - Uses the default search system prompt optimized for comprehensive searches
    - Each tool instance has its own call tracking state (once per conversation turn)

    Note: The tool uses its own internal system prompt (DEFAULT_SEARCH_SYSTEM_PROMPT)
    which is optimized for web search tasks. It does NOT inherit the main agent's
    system prompt, as the search task has different requirements.

    Args:
        llm: Existing ChatGoogleGenerativeAI instance (or BoundRunnable wrapping one)

    Returns:
        GeminiSearchTool instance with an isolated internal LLM
    """
    logger.info(
        "[create_gemini_search_tool] Creating GeminiSearchTool with isolated "
        "internal LLM (extracted config from provided LLM)"
    )

    return GeminiSearchTool(llm=llm)
