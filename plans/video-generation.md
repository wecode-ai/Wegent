实现视频生成模式支持，作为 Polling Agent 下的一个子 Agent，支持多种视频生成模型。

---

## 1. 核心架构设计

### 1.1 层级结构
```
CommunicationMode
├── SSE (Chat Shell)
├── WebSocket (Local Device)
├── HTTP_CALLBACK (Executor Manager)
└── POLLING (Long-running Agents)
    ├── ResearchAgent (gemini-deep-research)
    └── VideoAgent (modelType=video)    ← 新增
        ├── SeedanceProvider
        ├── RunwayProvider (future)
        └── PikaProvider (future)
```

### 1.2 路由机制
基于 `modelType` 而非 `protocol` 进行路由：

```python
# ExecutionRouter.route()
def route(self, request: ExecutionRequest, device_id: Optional[str] = None) -> ExecutionTarget:
    # Priority 0: Model type based routing for polling agents
    model_type = self._get_model_type(request)
    
    if model_type == "video" and not device_id:
        return ExecutionTarget(mode=CommunicationMode.POLLING)
    
    # Priority 1: Protocol-based routing (existing)
    protocol = request.model_config.get("protocol") if request.model_config else None
    if protocol == "gemini-deep-research" and not device_id:
        return ExecutionTarget(mode=CommunicationMode.POLLING)
    
    # ... rest of routing
```

### 1.3 Polling Dispatcher 内部路由
```python
# polling_dispatcher.py
async def dispatch_polling(request, target, emitter):
    """Polling mode dispatcher - routes to specific agents."""
    
    # Determine which agent to use
    model_type = request.model_config.get("modelType") if request.model_config else None
    protocol = request.model_config.get("protocol") if request.model_config else None
    
    if model_type == "video":
        from .agents.video_agent import VideoAgent
        agent = VideoAgent()
    elif protocol == "gemini-deep-research":
        from .agents.research_agent import ResearchAgent
        agent = ResearchAgent()
    else:
        raise ValueError(f"Unknown polling agent for modelType={model_type}, protocol={protocol}")
    
    await agent.execute(request, emitter)
```

### 1.4 secondaryModelRef 生效条件
当主模型 `modelType == "video"` 时，自动启用 `secondaryModelRef` 进行意图识别。

---

## 2. Schema 变更

### 2.1 ModelCategoryType 新增视频类型
**文件**: `backend/app/schemas/kind.py`

```python
class ModelCategoryType(str, Enum):
    LLM = "llm"
    TTS = "tts"
    STT = "stt"
    EMBEDDING = "embedding"
    RERANK = "rerank"
    VIDEO = "video"  # 新增
```

### 2.2 新增 VideoGenerationConfig
**文件**: `backend/app/schemas/kind.py`

```python
class VideoGenerationConfig(BaseModel):
    """Video generation specific configuration"""
    
    resolution: Optional[str] = Field("1080p", description="Video resolution")
    fps: Optional[int] = Field(24, description="Frames per second")
    max_duration: Optional[int] = Field(None, description="Maximum duration in seconds")
```

### 2.3 ModelSpec 新增视频配置
```python
# 在 ModelSpec 中新增
videoConfig: Optional[VideoGenerationConfig] = Field(
    None, description="Video generation configuration (when modelType='video')"
)
```

### 2.4 BotSpec 新增辅助模型引用
```python
class BotSpec(BaseModel):
    ghostRef: GhostRef
    shellRef: ShellRef
    modelRef: Optional[ModelRef] = None
    secondaryModelRef: Optional[ModelRef] = Field(
        None,
        description="Secondary LLM model for auxiliary tasks. "
        "Effective when primary modelRef.modelType is 'video'. "
        "Used for intent recognition and prompt merging."
    )
```

### 2.5 task_type 新增 video 类型
**文件**: `backend/app/api/ws/events.py`

```python
task_type: Optional[Literal["chat", "code", "knowledge", "task", "video"]] = Field(...)
```

### 2.6 ChatChunkPayload 新增 progress 字段
```python
class ChatChunkPayload(BaseModel):
    # ... existing fields
    progress: Optional[int] = Field(None, description="Progress percentage (0-100)")
```

---

## 3. Polling Agent 架构

### 3.1 目录结构
```
backend/app/services/execution/
├── dispatcher.py              # 主调度器
├── router.py                  # 路由器
├── polling_dispatcher.py      # Polling 模式调度器（重构）
└── agents/                    # Polling Agents（新建目录）
    ├── __init__.py
    ├── base.py               # 基类 PollingAgent
    ├── research_agent.py     # 从现有 polling_dispatcher.py 提取
    └── video/                # 视频 Agent
        ├── __init__.py
        ├── video_agent.py    # VideoAgent 主逻辑
        ├── intent_analyzer.py # 意图识别
        └── providers/        # 视频模型提供者
            ├── __init__.py
            ├── base.py       # VideoProvider 基类
            └── seedance.py   # Seedance 实现
```

### 3.2 PollingAgent 基类
**文件**: `backend/app/services/execution/agents/base.py`

```python
"""
Base class for polling agents.

Polling agents handle long-running tasks that require:
1. Creating a job/task
2. Polling for progress
3. Streaming results on completion
"""

from abc import ABC, abstractmethod
from typing import Optional

from shared.models import ExecutionRequest
from ..emitters import ResultEmitter


class PollingAgent(ABC):
    """Base class for polling mode agents."""
    
    @abstractmethod
    async def execute(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None:
        """
        Execute the agent task.
        
        Args:
            request: Execution request
            emitter: Result emitter for streaming events
        """
        pass
    
    @property
    @abstractmethod
    def name(self) -> str:
        """Agent name for logging."""
        pass
```

### 3.3 重构后的 polling_dispatcher.py
**文件**: `backend/app/services/execution/polling_dispatcher.py`

```python
"""
Polling dispatcher for long-running async tasks.

Routes to specific polling agents based on model type or protocol.
"""

import logging
from typing import Optional

from shared.models import ExecutionRequest

from .emitters import ResultEmitter
from .router import ExecutionTarget

logger = logging.getLogger(__name__)


async def dispatch_polling(
    request: ExecutionRequest,
    target: ExecutionTarget,
    emitter: ResultEmitter,
) -> None:
    """
    Dispatch to appropriate polling agent.
    
    Routing logic:
    1. modelType == "video" -> VideoAgent
    2. protocol == "gemini-deep-research" -> ResearchAgent
    """
    model_config = request.model_config or {}
    model_type = model_config.get("modelType")
    protocol = model_config.get("protocol")
    
    agent = _get_polling_agent(model_type, protocol)
    
    logger.info(
        f"[PollingDispatcher] Routing to {agent.name}: "
        f"task_id={request.task_id}, modelType={model_type}, protocol={protocol}"
    )
    
    await agent.execute(request, emitter)


def _get_polling_agent(
    model_type: Optional[str],
    protocol: Optional[str],
):
    """Get appropriate polling agent based on model type or protocol."""
    
    if model_type == "video":
        from .agents.video.video_agent import VideoAgent
        return VideoAgent()
    
    if protocol == "gemini-deep-research":
        from .agents.research_agent import ResearchAgent
        return ResearchAgent()
    
    raise ValueError(
        f"No polling agent available for modelType={model_type}, protocol={protocol}"
    )
```

### 3.4 ResearchAgent（从现有代码提取）
**文件**: `backend/app/services/execution/agents/research_agent.py`

```python
"""
Research agent for Gemini Deep Research.

Extracted from original polling_dispatcher.py.
"""

import asyncio
import json
import logging
from typing import Any, Optional

from shared.clients.gemini_interaction import GeminiInteractionClient, GeminiInteractionError
from shared.models import EventType, ExecutionEvent, ExecutionRequest

from ..emitters import ResultEmitter
from .base import PollingAgent

logger = logging.getLogger(__name__)

# ... 将现有 polling_dispatcher.py 的逻辑封装到 ResearchAgent 类中 ...

class ResearchAgent(PollingAgent):
    """Gemini Deep Research agent."""
    
    POLL_INTERVAL_SECONDS = 5
    MAX_POLL_COUNT = 720
    
    @property
    def name(self) -> str:
        return "ResearchAgent"
    
    async def execute(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None:
        """Execute deep research task."""
        # ... 现有 dispatch_polling 逻辑 ...
```

---

## 4. VideoAgent 实现

### 4.1 VideoAgent 主逻辑
**文件**: `backend/app/services/execution/agents/video/video_agent.py`

```python
"""
Video generation agent.

Handles video generation workflow:
1. Intent analysis for follow-up messages (using secondary LLM)
2. Video generation via provider (Seedance, Runway, etc.)
3. Progress polling and streaming
4. Result upload as attachment
"""

import asyncio
import logging
from typing import Optional

from shared.models import EventType, ExecutionEvent, ExecutionRequest

from ...emitters import ResultEmitter
from ..base import PollingAgent
from .intent_analyzer import VideoIntentAnalyzer, VideoIntentResult
from .providers import get_video_provider

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 3
MAX_POLL_COUNT = 600  # 30 minutes


class VideoAgent(PollingAgent):
    """Video generation polling agent."""
    
    @property
    def name(self) -> str:
        return "VideoAgent"
    
    async def execute(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None:
        """
        Execute video generation task.
        
        Workflow:
        1. Emit START event
        2. Analyze intent if follow-up (using secondary model)
        3. Create video generation job via provider
        4. Poll for progress
        5. Upload result as attachment
        6. Emit DONE event
        """
        from app.services.chat.storage.session import session_manager
        
        cancel_event = await session_manager.register_stream(request.subtask_id)
        
        task_id = request.task_id
        subtask_id = request.subtask_id
        message_id = request.message_id
        model_config = request.model_config or {}
        
        # Emit START
        await emitter.emit_start(
            task_id=task_id,
            subtask_id=subtask_id,
            message_id=message_id,
            data={"shell_type": "Chat"},
        )
        
        try:
            # Step 1: Intent analysis for follow-ups
            intent_result = await self._analyze_intent(
                request=request,
                emitter=emitter,
            )
            
            # Step 2: Get video provider based on protocol
            protocol = model_config.get("protocol", "seedance")
            provider = get_video_provider(protocol, model_config)
            
            # Step 3: Create video job
            await self._emit_progress(emitter, task_id, subtask_id, message_id, 5, "开始生成视频...")
            
            job_id = await provider.create_job(
                prompt=intent_result.merged_prompt,
                reference_image=intent_result.reference_image,
                image_mode=intent_result.image_mode,
            )
            
            logger.info(f"[VideoAgent] Job created: job_id={job_id}, task_id={task_id}")
            
            # Step 4: Poll for completion
            for poll_num in range(1, MAX_POLL_COUNT + 1):
                # Check cancellation
                if cancel_event.is_set() or await session_manager.is_cancelled(subtask_id):
                    logger.info(f"[VideoAgent] Cancelled: task_id={task_id}")
                    await emitter.emit(
                        ExecutionEvent(
                            type=EventType.CANCELLED,
                            task_id=task_id,
                            subtask_id=subtask_id,
                            message_id=message_id,
                        )
                    )
                    return
                
                status = await provider.get_status(job_id)
                
                if status.is_completed:
                    break
                elif status.is_failed:
                    raise Exception(status.error or "Video generation failed")
                
                await self._emit_progress(
                    emitter, task_id, subtask_id, message_id,
                    progress=min(status.progress, 90),
                    message=f"视频生成中... {status.progress}%"
                )
                
                await asyncio.sleep(POLL_INTERVAL_SECONDS)
            else:
                raise Exception("Video generation timed out")
            
            # Step 5: Get result and upload
            await self._emit_progress(emitter, task_id, subtask_id, message_id, 92, "获取视频结果...")
            
            result = await provider.get_result(job_id)
            
            await self._emit_progress(emitter, task_id, subtask_id, message_id, 95, "上传视频文件...")
            
            user_id = request.user.get("id") if request.user else None
            attachment_id = await self._upload_attachment(
                result=result,
                user_id=user_id,
                task_id=task_id,
                subtask_id=subtask_id,
            )
            
            # Step 6: Emit DONE
            result_data = {
                "value": "视频生成完成",
                "image": result.thumbnail,  # For follow-up reference
                "video": {
                    "attachment_id": attachment_id,
                    "video_url": result.video_url,
                    "thumbnail": result.thumbnail,
                    "duration": result.duration,
                },
            }
            
            await emitter.emit(
                ExecutionEvent(
                    type=EventType.DONE,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    result=result_data,
                    message_id=message_id,
                )
            )
            
            logger.info(f"[VideoAgent] Completed: task_id={task_id}, attachment_id={attachment_id}")
        
        except Exception as e:
            logger.exception(f"[VideoAgent] Error: task_id={task_id}, error={e}")
            await emitter.emit(
                ExecutionEvent(
                    type=EventType.ERROR,
                    task_id=task_id,
                    subtask_id=subtask_id,
                    error=str(e),
                    message_id=message_id,
                )
            )
        
        finally:
            await session_manager.unregister_stream(subtask_id)
    
    async def _analyze_intent(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> VideoIntentResult:
        """Analyze intent for follow-up messages."""
        current_prompt = (
            request.prompt if isinstance(request.prompt, str)
            else str(request.prompt)
        )
        
        # Check if this is a follow-up
        if not request.task_id:
            return VideoIntentResult(merged_prompt=current_prompt, should_use_image=False)
        
        # Emit progress
        await self._emit_progress(
            emitter, request.task_id, request.subtask_id, request.message_id,
            progress=2, message="分析用户意图..."
        )
        
        analyzer = VideoIntentAnalyzer()
        return await analyzer.analyze(
            task_id=request.task_id,
            current_prompt=current_prompt,
            secondary_model_config=request.secondary_model_config,
        )
    
    async def _emit_progress(
        self,
        emitter: ResultEmitter,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int],
        progress: int,
        message: str,
    ) -> None:
        """Emit progress update."""
        await emitter.emit(
            ExecutionEvent(
                type=EventType.CHUNK,
                task_id=task_id,
                subtask_id=subtask_id,
                content=message,
                offset=0,
                result={"progress": progress},
                message_id=message_id,
            )
        )
    
    async def _upload_attachment(
        self,
        result,
        user_id: int,
        task_id: int,
        subtask_id: int,
    ) -> int:
        """Upload video as attachment."""
        from .attachment_uploader import upload_video_attachment
        
        return await upload_video_attachment(
            video_url=result.video_url,
            thumbnail=result.thumbnail,
            duration=result.duration,
            user_id=user_id,
            task_id=task_id,
            subtask_id=subtask_id,
        )
```

### 4.2 VideoProvider 基类
**文件**: `backend/app/services/execution/agents/video/providers/base.py`

```python
"""
Base class for video generation providers.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Literal, Optional


@dataclass
class VideoJobStatus:
    """Video job status."""
    progress: int  # 0-100
    is_completed: bool = False
    is_failed: bool = False
    error: Optional[str] = None


@dataclass
class VideoJobResult:
    """Video job result."""
    video_url: str
    thumbnail: Optional[str] = None  # Base64
    duration: Optional[float] = None
    image: Optional[str] = None  # For follow-up reference


class VideoProvider(ABC):
    """Base class for video generation providers."""
    
    @property
    @abstractmethod
    def name(self) -> str:
        """Provider name."""
        pass
    
    @abstractmethod
    async def create_job(
        self,
        prompt: str,
        reference_image: Optional[str] = None,
        image_mode: Optional[Literal["first_frame", "last_frame", "reference"]] = None,
    ) -> str:
        """
        Create video generation job.
        
        Returns:
            Job ID
        """
        pass
    
    @abstractmethod
    async def get_status(self, job_id: str) -> VideoJobStatus:
        """Get job status."""
        pass
    
    @abstractmethod
    async def get_result(self, job_id: str) -> VideoJobResult:
        """Get completed job result."""
        pass
```

### 4.3 Provider 工厂
**文件**: `backend/app/services/execution/agents/video/providers/__init__.py`

```python
"""
Video provider factory.
"""

from typing import Dict, Any

from .base import VideoProvider


def get_video_provider(protocol: str, model_config: Dict[str, Any]) -> VideoProvider:
    """
    Get video provider by protocol.
    
    Args:
        protocol: Provider protocol (e.g., 'seedance', 'runway', 'pika')
        model_config: Model configuration
        
    Returns:
        VideoProvider instance
    """
    if protocol == "seedance":
        from .seedance import SeedanceProvider
        return SeedanceProvider(
            base_url=model_config.get("base_url"),
            api_key=model_config.get("api_key"),
            video_config=model_config.get("videoConfig", {}),
        )
    
    # Future providers
    # elif protocol == "runway":
    #     from .runway import RunwayProvider
    #     return RunwayProvider(...)
    
    raise ValueError(f"Unknown video provider: {protocol}")
```

### 4.4 Seedance Provider 实现
**文件**: `backend/app/services/execution/agents/video/providers/seedance.py`

```python
"""
Seedance video generation provider.
"""

import httpx
import logging
from typing import Any, Dict, Literal, Optional

from .base import VideoProvider, VideoJobStatus, VideoJobResult

logger = logging.getLogger(__name__)


class SeedanceProvider(VideoProvider):
    """Seedance 1.5 video generation provider."""
    
    def __init__(
        self,
        base_url: str,
        api_key: str,
        video_config: Optional[Dict[str, Any]] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.video_config = video_config or {}
    
    @property
    def name(self) -> str:
        return "Seedance"
    
    async def create_job(
        self,
        prompt: str,
        reference_image: Optional[str] = None,
        image_mode: Optional[Literal["first_frame", "last_frame", "reference"]] = None,
    ) -> str:
        """Create Seedance video generation job."""
        payload = {
            "prompt": prompt,
            "resolution": self.video_config.get("resolution", "1080p"),
            "fps": self.video_config.get("fps", 24),
        }
        
        if reference_image and image_mode:
            payload["reference_image"] = reference_image
            payload["image_mode"] = image_mode
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.base_url}/v1/videos/generate",
                json=payload,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
            )
            response.raise_for_status()
            data = response.json()
            return data["id"]
    
    async def get_status(self, job_id: str) -> VideoJobStatus:
        """Get Seedance job status."""
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{self.base_url}/v1/videos/{job_id}/status",
                headers={"Authorization": f"Bearer {self.api_key}"},
            )
            response.raise_for_status()
            data = response.json()
            
            status = data.get("status", "processing")
            return VideoJobStatus(
                progress=data.get("progress", 0),
                is_completed=(status == "completed"),
                is_failed=(status == "failed"),
                error=data.get("error"),
            )
    
    async def get_result(self, job_id: str) -> VideoJobResult:
        """Get Seedance job result."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                f"{self.base_url}/v1/videos/{job_id}/result",
                headers={"Authorization": f"Bearer {self.api_key}"},
            )
            response.raise_for_status()
            data = response.json()
            
            return VideoJobResult(
                video_url=data["video_url"],
                thumbnail=data.get("thumbnail"),
                duration=data.get("duration"),
                image=data.get("image"),  # For follow-up reference
            )
```

### 4.5 意图识别器
**文件**: `backend/app/services/execution/agents/video/intent_analyzer.py`

```python
"""
Video intent analyzer for follow-up messages.
"""

import json
import logging
from dataclasses import dataclass
from typing import Literal, Optional

from app.db.session import SessionLocal
from app.models.subtask import Subtask, SubtaskRole

logger = logging.getLogger(__name__)


@dataclass
class VideoIntentResult:
    """Result of video intent analysis."""
    merged_prompt: str
    should_use_image: bool
    image_mode: Optional[Literal["first_frame", "last_frame", "reference"]] = None
    reference_image: Optional[str] = None


INTENT_PROMPT = """你是一个视频生成意图分析助手。用户正在进行多轮视频生成对话。

上一轮用户的提示词：{previous_prompt}
当前用户的提示词：{current_prompt}
上一轮是否生成了参考图片：{has_image}

请分析用户意图并输出 JSON：
{{
    "merged_prompt": "合并优化后的视频生成提示词",
    "should_use_image": true/false,
    "image_mode": "first_frame" | "last_frame" | "reference" | null
}}

规则：
- merged_prompt: 将两轮提示词合并为完整、连贯的视频生成描述
- should_use_image: 仅当 has_image=true 且用户意图使用图片时为 true
- image_mode:
  - "first_frame": 视频从该图片开始
  - "last_frame": 视频以该图片结束
  - "reference": 参考该图片的风格/内容

只输出 JSON。"""


class VideoIntentAnalyzer:
    """Analyzes video generation intent for follow-up messages."""
    
    async def analyze(
        self,
        task_id: int,
        current_prompt: str,
        secondary_model_config: Optional[dict],
    ) -> VideoIntentResult:
        """
        Analyze intent for follow-up message.
        
        Args:
            task_id: Task ID
            current_prompt: Current user prompt
            secondary_model_config: LLM config for intent analysis
        """
        db = SessionLocal()
        try:
            # Get previous messages
            subtasks = (
                db.query(Subtask)
                .filter(Subtask.task_id == task_id)
                .order_by(Subtask.message_id.asc())
                .all()
            )
            
            if len(subtasks) < 2:
                return VideoIntentResult(
                    merged_prompt=current_prompt,
                    should_use_image=False,
                )
            
            # Find previous user and AI messages
            prev_user, prev_ai = None, None
            for st in reversed(subtasks):
                if st.role == SubtaskRole.ASSISTANT and not prev_ai:
                    prev_ai = st
                elif st.role == SubtaskRole.USER and not prev_user:
                    prev_user = st
                if prev_user and prev_ai:
                    break
            
            if not prev_user or not prev_ai:
                return VideoIntentResult(
                    merged_prompt=current_prompt,
                    should_use_image=False,
                )
            
            prev_prompt = prev_user.prompt or ""
            prev_result = prev_ai.result or {}
            prev_image = prev_result.get("image")
            has_image = prev_image is not None
            
            # If no secondary model, use simple merge
            if not secondary_model_config:
                logger.warning("[VideoIntentAnalyzer] No secondary model, using simple merge")
                return VideoIntentResult(
                    merged_prompt=f"{prev_prompt}\n\n{current_prompt}",
                    should_use_image=has_image,
                    image_mode="reference" if has_image else None,
                    reference_image=prev_image,
                )
            
            # Call LLM for intent analysis
            intent = await self._call_llm(
                prev_prompt, current_prompt, has_image, secondary_model_config
            )
            
            if intent.should_use_image and has_image:
                intent.reference_image = prev_image
            
            return intent
            
        finally:
            db.close()
    
    async def _call_llm(
        self,
        prev_prompt: str,
        current_prompt: str,
        has_image: bool,
        model_config: dict,
    ) -> VideoIntentResult:
        """Call secondary LLM for intent analysis."""
        from openai import AsyncOpenAI
        
        prompt = INTENT_PROMPT.format(
            previous_prompt=prev_prompt,
            current_prompt=current_prompt,
            has_image=str(has_image).lower(),
        )
        
        client = AsyncOpenAI(
            api_key=model_config.get("api_key"),
            base_url=model_config.get("base_url"),
        )
        
        try:
            response = await client.chat.completions.create(
                model=model_config.get("model_id", "gpt-4o-mini"),
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
                response_format={"type": "json_object"},
            )
            
            result = json.loads(response.choices[0].message.content)
            
            return VideoIntentResult(
                merged_prompt=result.get("merged_prompt", current_prompt),
                should_use_image=result.get("should_use_image", False),
                image_mode=result.get("image_mode"),
            )
        except Exception as e:
            logger.error(f"[VideoIntentAnalyzer] LLM call failed: {e}")
            return VideoIntentResult(
                merged_prompt=f"{prev_prompt}\n\n{current_prompt}",
                should_use_image=has_image,
                image_mode="reference" if has_image else None,
            )
```

### 4.6 附件上传
**文件**: `backend/app/services/execution/agents/video/attachment_uploader.py`

```python
"""
Upload generated video as attachment.
"""

import httpx
import logging
from typing import Optional

from app.db.session import SessionLocal
from app.models.subtask_context import SubtaskContext, SubtaskContextStatus

logger = logging.getLogger(__name__)


async def upload_video_attachment(
    video_url: str,
    thumbnail: Optional[str],
    duration: Optional[float],
    user_id: int,
    task_id: int,
    subtask_id: int,
) -> int:
    """
    Download video and create attachment record.
    
    Returns:
        Attachment ID (SubtaskContext ID)
    """
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.get(video_url)
        response.raise_for_status()
        video_size = len(response.content)
    
    db = SessionLocal()
    try:
        context = SubtaskContext(
            subtask_id=subtask_id,
            context_type="attachment",
            name=f"video_{task_id}_{subtask_id}.mp4",
            status=SubtaskContextStatus.COMPLETED,
            type_data={
                "file_extension": "mp4",
                "file_size": video_size,
                "mime_type": "video/mp4",
                "video_metadata": {
                    "video_url": video_url,
                    "thumbnail": thumbnail,
                    "duration": duration,
                },
            },
        )
        db.add(context)
        db.commit()
        db.refresh(context)
        
        logger.info(f"[VideoUploader] Created: id={context.id}, size={video_size}")
        return context.id
        
    finally:
        db.close()
```

---

## 5. Router 变更

**文件**: `backend/app/services/execution/router.py`

```python
def route(
    self,
    request: ExecutionRequest,
    device_id: Optional[str] = None,
) -> ExecutionTarget:
    user_id = request.user.get("id") if request.user else None
    
    # Priority 0: Model type based routing for polling agents
    model_type = self._get_model_type(request)
    if model_type == "video" and not device_id:
        return ExecutionTarget(mode=CommunicationMode.POLLING)
    
    # Priority 1: Protocol-based routing (existing)
    protocol = request.model_config.get("protocol") if request.model_config else None
    if protocol == "gemini-deep-research" and not device_id:
        return ExecutionTarget(mode=CommunicationMode.POLLING)
    
    # ... rest of existing routing logic

def _get_model_type(self, request: ExecutionRequest) -> Optional[str]:
    """Get model type from request."""
    if request.model_config:
        return request.model_config.get("modelType")
    return None
```

---

## 6. ExecutionRequest 扩展

**文件**: `shared/models/execution.py`

```python
@dataclass
class ExecutionRequest:
    # ... existing fields ...
    
    # Secondary model config for auxiliary tasks (video intent analysis)
    secondary_model_config: Optional[dict] = field(default_factory=dict)
```

---

## 7. 涉及文件清单

### 新增文件
| 文件路径 | 说明 |
|---------|------|
| `backend/app/services/execution/agents/__init__.py` | Agents 模块初始化 |
| `backend/app/services/execution/agents/base.py` | PollingAgent 基类 |
| `backend/app/services/execution/agents/research_agent.py` | ResearchAgent（从 polling_dispatcher.py 提取） |
| `backend/app/services/execution/agents/video/__init__.py` | Video Agent 模块 |
| `backend/app/services/execution/agents/video/video_agent.py` | VideoAgent 主逻辑 |
| `backend/app/services/execution/agents/video/intent_analyzer.py` | 意图识别 |
| `backend/app/services/execution/agents/video/attachment_uploader.py` | 附件上传 |
| `backend/app/services/execution/agents/video/providers/__init__.py` | Provider 工厂 |
| `backend/app/services/execution/agents/video/providers/base.py` | VideoProvider 基类 |
| `backend/app/services/execution/agents/video/providers/seedance.py` | Seedance 实现 |

### 修改文件
| 文件路径 | 修改内容 |
|---------|---------|
| `backend/app/schemas/kind.py` | `ModelCategoryType.VIDEO`、`VideoGenerationConfig`、`BotSpec.secondaryModelRef` |
| `backend/app/api/ws/events.py` | `task_type` 新增 `"video"`；`ChatChunkPayload` 新增 `progress` |
| `backend/app/services/execution/router.py` | 新增 `modelType == "video"` 路由到 POLLING |
| `backend/app/services/execution/polling_dispatcher.py` | 重构为 Agent 路由分发器 |
| `shared/models/execution.py` | 新增 `secondary_model_config` 字段 |
| `backend/app/services/execution/request_builder.py` | 构建 `secondary_model_config` |

---

## 8. 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                      ExecutionDispatcher                         │
│                                                                  │
│  dispatch(request, device_id, emitter)                          │
│      │                                                           │
│      ▼                                                           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                   ExecutionRouter                         │   │
│  │                                                           │   │
│  │  route(request, device_id) -> ExecutionTarget            │   │
│  │      │                                                    │   │
│  │      ├── modelType == "video"  ──► POLLING               │   │
│  │      ├── protocol == "gemini-deep-research" ──► POLLING  │   │
│  │      ├── device_id ──► WEBSOCKET                         │   │
│  │      ├── shellType == "Chat" ──► SSE                     │   │
│  │      └── else ──► HTTP_CALLBACK                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│      │                                                           │
│      ▼                                                           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  Communication Modes                      │   │
│  │                                                           │   │
│  │  ├── SSE ──► Chat Shell                                  │   │
│  │  ├── WEBSOCKET ──► Local Device                          │   │
│  │  ├── HTTP_CALLBACK ──► Executor Manager                  │   │
│  │  └── POLLING ──► Polling Dispatcher                      │   │
│  │                    │                                      │   │
│  │                    ▼                                      │   │
│  │         ┌────────────────────────────────┐              │   │
│  │         │     Polling Dispatcher          │              │   │
│  │         │                                 │              │   │
│  │         │  _get_polling_agent()          │              │   │
│  │         │      │                          │              │   │
│  │         │      ├── modelType=video       │              │   │
│  │         │      │       ▼                  │              │   │
│  │         │      │   VideoAgent            │              │   │
│  │         │      │       │                  │              │   │
│  │         │      │       ├── IntentAnalyzer │              │   │
│  │         │      │       └── VideoProvider  │              │   │
│  │         │      │           ├── Seedance   │              │   │
│  │         │      │           ├── Runway     │              │   │
│  │         │      │           └── Pika       │              │   │
│  │         │      │                          │              │   │
│  │         │      └── protocol=gemini-...   │              │   │
│  │         │              ▼                  │              │   │
│  │         │          ResearchAgent         │              │   │
│  │         └────────────────────────────────┘              │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

