# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ResponsesAPIEmitter Factory and Builder."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from shared.models import (
    CallbackTransport,
    EmitterBuilder,
    EventTransport,
    GeneratorTransport,
    RedisTransport,
    ResponsesAPIEmitter,
    ThrottleConfig,
    ThrottledTransport,
    TransportFactory,
    TransportType,
    WebSocketTransport,
)


class TestTransportType:
    """Tests for TransportType enum."""

    def test_transport_type_values(self):
        """Test that TransportType has expected values."""
        assert TransportType.CALLBACK.value == "callback"
        assert TransportType.WEBSOCKET.value == "websocket"
        assert TransportType.GENERATOR.value == "generator"
        assert TransportType.REDIS.value == "redis"


class TestTransportFactory:
    """Tests for TransportFactory."""

    def test_create_callback_with_client(self):
        """Test creating CallbackTransport with provided client."""
        mock_client = MagicMock()
        transport = TransportFactory.create_callback(client=mock_client)
        assert isinstance(transport, CallbackTransport)
        assert transport.client == mock_client

    def test_create_websocket(self):
        """Test creating WebSocketTransport."""
        mock_client = MagicMock()
        event_mapping = {"response.created": "chat:start"}
        transport = TransportFactory.create_websocket(mock_client, event_mapping)
        assert isinstance(transport, WebSocketTransport)
        assert transport.client == mock_client
        assert transport.event_mapping == event_mapping

    def test_create_generator(self):
        """Test creating GeneratorTransport."""
        callback = MagicMock()
        transport = TransportFactory.create_generator(callback)
        assert isinstance(transport, GeneratorTransport)
        assert transport.callback == callback

    def test_create_generator_without_callback(self):
        """Test creating GeneratorTransport without callback."""
        transport = TransportFactory.create_generator()
        assert isinstance(transport, GeneratorTransport)
        assert transport.callback is None

    def test_create_redis(self):
        """Test creating RedisTransport."""
        mock_storage = MagicMock()
        transport = TransportFactory.create_redis(mock_storage)
        assert isinstance(transport, RedisTransport)
        assert transport._storage == mock_storage

    def test_create_callback_throttled(self):
        """Test creating throttled CallbackTransport."""
        mock_client = MagicMock()
        config = ThrottleConfig(default_interval=0.5)
        transport = TransportFactory.create_callback_throttled(
            client=mock_client, config=config
        )
        assert isinstance(transport, ThrottledTransport)
        assert isinstance(transport._transport, CallbackTransport)
        assert transport._config.default_interval == 0.5

    def test_create_websocket_throttled(self):
        """Test creating throttled WebSocketTransport."""
        mock_client = MagicMock()
        config = ThrottleConfig(default_interval=0.3)
        transport = TransportFactory.create_websocket_throttled(
            mock_client, config=config
        )
        assert isinstance(transport, ThrottledTransport)
        assert isinstance(transport._transport, WebSocketTransport)

    def test_with_throttle(self):
        """Test wrapping any transport with throttling."""
        mock_transport = MagicMock(spec=EventTransport)
        config = ThrottleConfig(max_buffer_size=2048)
        throttled = TransportFactory.with_throttle(mock_transport, config)
        assert isinstance(throttled, ThrottledTransport)
        assert throttled._transport == mock_transport
        assert throttled._config.max_buffer_size == 2048


class TestEmitterBuilder:
    """Tests for EmitterBuilder."""

    def test_build_with_required_params(self):
        """Test building emitter with required parameters."""
        mock_transport = MagicMock(spec=EventTransport)
        emitter = (
            EmitterBuilder().with_task(123, 456).with_transport(mock_transport).build()
        )
        assert isinstance(emitter, ResponsesAPIEmitter)
        assert emitter.task_id == 123
        assert emitter.subtask_id == 456
        assert emitter.transport == mock_transport

    def test_build_with_all_params(self):
        """Test building emitter with all parameters."""
        mock_transport = MagicMock(spec=EventTransport)
        emitter = (
            EmitterBuilder()
            .with_task(123, 456)
            .with_transport(mock_transport)
            .with_model("claude-3")
            .with_message_id(789)
            .with_executor_info("executor-1", "default")
            .build()
        )
        assert emitter.task_id == 123
        assert emitter.subtask_id == 456
        assert emitter.builder.model == "claude-3"
        assert emitter.message_id == 789
        assert emitter.executor_name == "executor-1"
        assert emitter.executor_namespace == "default"

    def test_build_without_task_raises_error(self):
        """Test that building without task raises ValueError."""
        mock_transport = MagicMock(spec=EventTransport)
        with pytest.raises(ValueError, match="task_id and subtask_id are required"):
            EmitterBuilder().with_transport(mock_transport).build()

    def test_build_without_transport_raises_error(self):
        """Test that building without transport raises ValueError."""
        with pytest.raises(ValueError, match="transport is required"):
            EmitterBuilder().with_task(123, 456).build()

    def test_builder_chaining(self):
        """Test that builder methods return self for chaining."""
        builder = EmitterBuilder()
        mock_transport = MagicMock(spec=EventTransport)

        result = builder.with_task(1, 2)
        assert result is builder

        result = builder.with_transport(mock_transport)
        assert result is builder

        result = builder.with_model("test")
        assert result is builder

        result = builder.with_message_id(3)
        assert result is builder

        result = builder.with_executor_info("name", "ns")
        assert result is builder


class TestThrottleConfig:
    """Tests for ThrottleConfig."""

    def test_default_config(self):
        """Test default configuration values."""
        config = ThrottleConfig()
        assert config.default_interval == 2
        assert config.max_buffer_size == 4096
        assert config.throttled_events is None
        assert "response.created" in config.bypass_events
        assert "response.completed" in config.bypass_events
        assert "error" in config.bypass_events

    def test_custom_config(self):
        """Test custom configuration values."""
        config = ThrottleConfig(
            default_interval=0.5,
            event_intervals={"response.output_text.delta": 0.2},
            max_buffer_size=2048,
        )
        assert config.default_interval == 0.5
        assert config.get_interval("response.output_text.delta") == 0.2
        assert config.get_interval("unknown_event") == 0.5
        assert config.max_buffer_size == 2048

    def test_should_throttle_bypass_events(self):
        """Test that bypass events are not throttled."""
        config = ThrottleConfig()
        assert not config.should_throttle("response.created")
        assert not config.should_throttle("response.completed")
        assert not config.should_throttle("error")

    def test_should_throttle_regular_events(self):
        """Test that regular events are throttled."""
        config = ThrottleConfig()
        assert config.should_throttle("response.output_text.delta")
        assert config.should_throttle("response.part.added")

    def test_should_throttle_with_throttled_events_set(self):
        """Test throttling with explicit throttled_events set."""
        config = ThrottleConfig(
            throttled_events={"response.output_text.delta"},
            bypass_events=set(),
        )
        assert config.should_throttle("response.output_text.delta")
        assert not config.should_throttle("response.created")


class TestThrottledTransport:
    """Tests for ThrottledTransport."""

    @pytest.mark.asyncio
    async def test_bypass_events_sent_immediately(self):
        """Test that bypass events are sent immediately without buffering."""
        mock_transport = AsyncMock(spec=EventTransport)
        throttled = ThrottledTransport(mock_transport)

        await throttled.send("response.created", 1, 2, {"test": "data"})

        mock_transport.send.assert_called_once_with(
            "response.created", 1, 2, {"test": "data"}, None, None, None
        )

    @pytest.mark.asyncio
    async def test_throttled_events_sent_on_interval(self):
        """Test that throttled events are sent when interval is exceeded."""
        mock_transport = AsyncMock(spec=EventTransport)
        # Use default config - first event will be sent immediately since
        # time_since_last (from 0) will exceed interval
        throttled = ThrottledTransport(mock_transport)

        await throttled.send("response.output_text.delta", 1, 2, {"delta": "hello"})

        # First event should be sent immediately (time_since_last > interval)
        mock_transport.send.assert_called_once()

    @pytest.mark.asyncio
    async def test_events_aggregated_within_interval(self):
        """Test that multiple events within interval are aggregated."""
        mock_transport = AsyncMock(spec=EventTransport)
        config = ThrottleConfig(default_interval=10.0)  # Long interval
        throttled = ThrottledTransport(mock_transport, config)

        # First event triggers immediate send (time_since_last from 0 > interval)
        await throttled.send("response.output_text.delta", 1, 2, {"delta": "hello"})
        mock_transport.send.assert_called_once()
        mock_transport.reset_mock()

        # Subsequent events within interval should be buffered
        await throttled.send("response.output_text.delta", 1, 2, {"delta": " world"})
        await throttled.send("response.output_text.delta", 1, 2, {"delta": "!"})

        # Should not have sent yet (within interval)
        mock_transport.send.assert_not_called()

        # Flush to send aggregated
        await throttled.flush_all()
        mock_transport.send.assert_called_once()
        call_args = mock_transport.send.call_args
        assert call_args[0][3]["delta"] == " world!"

    @pytest.mark.asyncio
    async def test_flush_all(self):
        """Test flushing all buffers."""
        mock_transport = AsyncMock(spec=EventTransport)
        config = ThrottleConfig(default_interval=10.0)
        throttled = ThrottledTransport(mock_transport, config)

        # First event triggers immediate send
        await throttled.send("response.output_text.delta", 1, 2, {"delta": "hello"})
        mock_transport.reset_mock()

        # Buffer more events
        await throttled.send("response.output_text.delta", 1, 2, {"delta": " world"})

        # Flush all
        await throttled.flush_all()

        # Should have sent aggregated event
        mock_transport.send.assert_called_once()
        call_args = mock_transport.send.call_args
        assert call_args[0][0] == "response.output_text.delta"
        assert call_args[0][3]["delta"] == " world"

    @pytest.mark.asyncio
    async def test_buffer_size_triggers_immediate_send(self):
        """Test that exceeding buffer size triggers immediate send."""
        mock_transport = AsyncMock(spec=EventTransport)
        config = ThrottleConfig(default_interval=10.0, max_buffer_size=10)
        throttled = ThrottledTransport(mock_transport, config)

        # First event triggers immediate send
        await throttled.send("response.output_text.delta", 1, 2, {"delta": "hi"})
        mock_transport.reset_mock()

        # Send event that exceeds buffer size
        await throttled.send(
            "response.output_text.delta", 1, 2, {"delta": "this is a long text"}
        )

        # Should have sent immediately due to buffer size
        mock_transport.send.assert_called_once()


class TestRedisTransport:
    """Tests for RedisTransport."""

    @pytest.mark.asyncio
    async def test_send_publishes_to_redis(self):
        """Test that send publishes event to Redis channel."""
        mock_storage = AsyncMock()
        transport = RedisTransport(mock_storage)

        await transport.send(
            "response.created",
            task_id=1,
            subtask_id=2,
            data={"test": "data"},
            message_id=3,
        )

        mock_storage.publish_streaming_chunk.assert_called_once()
        call_args = mock_storage.publish_streaming_chunk.call_args
        assert call_args[0][0] == 2  # subtask_id
        # Verify JSON contains expected fields
        import json

        published_data = json.loads(call_args[0][1])
        assert published_data["event_type"] == "response.created"
        assert published_data["task_id"] == 1
        assert published_data["subtask_id"] == 2
        assert published_data["data"] == {"test": "data"}
        assert published_data["message_id"] == 3
