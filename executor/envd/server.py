#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
Connect RPC routes for envd services using FastAPI
Registers Connect protocol HTTP endpoints to existing FastAPI app
"""

import json
from typing import AsyncIterator

from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
from google.protobuf.json_format import MessageToDict, ParseDict, ParseError

from shared.logger import setup_logger

logger = setup_logger("envd_server")

# Import service handlers
from .service import (
    ConnectError,
    FilesystemConnectError,
    FilesystemServiceHandler,
    ProcessServiceHandler,
)

# Global handlers
_process_handler: ProcessServiceHandler = None
_filesystem_handler: FilesystemServiceHandler = None


def register_envd_routes(app: FastAPI):
    """
    Register envd Connect RPC routes to existing FastAPI application
    Routes follow Connect protocol: POST /package.Service/Method
    """
    global _process_handler, _filesystem_handler

    logger.info("Registering envd Connect RPC routes")

    # Initialize handlers
    _process_handler = ProcessServiceHandler()
    _filesystem_handler = FilesystemServiceHandler()

    # Process service routes
    @app.post("/process.Process/List")
    async def process_list(request: Request):
        """List all running processes"""
        from .gen.process.process import process_pb2

        return await _handle_unary(
            request,
            _process_handler.List,
            process_pb2.ListRequest,
            process_pb2.ListResponse,
        )

    @app.post("/process.Process/Start")
    async def process_start(request: Request):
        """Start a new process and stream output"""
        from .gen.process.process import process_pb2

        return await _handle_server_stream(
            request,
            _process_handler.Start,
            process_pb2.StartRequest,
            process_pb2.StartResponse,
        )

    @app.post("/process.Process/Connect")
    async def process_connect(request: Request):
        """Connect to existing process"""
        from .gen.process.process import process_pb2

        return await _handle_server_stream(
            request,
            _process_handler.Connect,
            process_pb2.ConnectRequest,
            process_pb2.ConnectResponse,
        )

    @app.post("/process.Process/Update")
    async def process_update(request: Request):
        """Update process settings"""
        from .gen.process.process import process_pb2

        return await _handle_unary(
            request,
            _process_handler.Update,
            process_pb2.UpdateRequest,
            process_pb2.UpdateResponse,
        )

    @app.post("/process.Process/SendInput")
    async def process_send_input(request: Request):
        """Send input to process"""
        from .gen.process.process import process_pb2

        return await _handle_unary(
            request,
            _process_handler.SendInput,
            process_pb2.SendInputRequest,
            process_pb2.SendInputResponse,
        )

    @app.post("/process.Process/StreamInput")
    async def process_stream_input(request: Request):
        """Stream input to process"""
        from .gen.process.process import process_pb2

        return await _handle_client_stream(
            request,
            _process_handler.StreamInput,
            process_pb2.StreamInputRequest,
            process_pb2.StreamInputResponse,
        )

    @app.post("/process.Process/SendSignal")
    async def process_send_signal(request: Request):
        """Send signal to process"""
        from .gen.process.process import process_pb2

        return await _handle_unary(
            request,
            _process_handler.SendSignal,
            process_pb2.SendSignalRequest,
            process_pb2.SendSignalResponse,
        )

    # Filesystem service routes
    @app.post("/filesystem.Filesystem/Stat")
    async def filesystem_stat(request: Request):
        """Get file/directory information"""
        from .gen.filesystem.filesystem import filesystem_pb2

        return await _handle_unary(
            request,
            _filesystem_handler.Stat,
            filesystem_pb2.StatRequest,
            filesystem_pb2.StatResponse,
        )

    @app.post("/filesystem.Filesystem/MakeDir")
    async def filesystem_mkdir(request: Request):
        """Create directory"""
        from .gen.filesystem.filesystem import filesystem_pb2

        return await _handle_unary(
            request,
            _filesystem_handler.MakeDir,
            filesystem_pb2.MakeDirRequest,
            filesystem_pb2.MakeDirResponse,
        )

    @app.post("/filesystem.Filesystem/Move")
    async def filesystem_move(request: Request):
        """Move/rename file or directory"""
        from .gen.filesystem.filesystem import filesystem_pb2

        return await _handle_unary(
            request,
            _filesystem_handler.Move,
            filesystem_pb2.MoveRequest,
            filesystem_pb2.MoveResponse,
        )

    @app.post("/filesystem.Filesystem/ListDir")
    async def filesystem_listdir(request: Request):
        """List directory contents"""
        from .gen.filesystem.filesystem import filesystem_pb2

        return await _handle_unary(
            request,
            _filesystem_handler.ListDir,
            filesystem_pb2.ListDirRequest,
            filesystem_pb2.ListDirResponse,
        )

    @app.post("/filesystem.Filesystem/Remove")
    async def filesystem_remove(request: Request):
        """Remove file or directory"""
        from .gen.filesystem.filesystem import filesystem_pb2

        return await _handle_unary(
            request,
            _filesystem_handler.Remove,
            filesystem_pb2.RemoveRequest,
            filesystem_pb2.RemoveResponse,
        )

    @app.post("/filesystem.Filesystem/WatchDir")
    async def filesystem_watchdir(request: Request):
        """Watch directory for changes"""
        from .gen.filesystem.filesystem import filesystem_pb2

        return await _handle_server_stream(
            request,
            _filesystem_handler.WatchDir,
            filesystem_pb2.WatchDirRequest,
            filesystem_pb2.WatchDirResponse,
        )

    @app.post("/filesystem.Filesystem/CreateWatcher")
    async def filesystem_create_watcher(request: Request):
        """Create directory watcher"""
        from .gen.filesystem.filesystem import filesystem_pb2

        return await _handle_unary(
            request,
            _filesystem_handler.CreateWatcher,
            filesystem_pb2.CreateWatcherRequest,
            filesystem_pb2.CreateWatcherResponse,
        )

    @app.post("/filesystem.Filesystem/GetWatcherEvents")
    async def filesystem_get_watcher_events(request: Request):
        """Get watcher events"""
        from .gen.filesystem.filesystem import filesystem_pb2

        return await _handle_unary(
            request,
            _filesystem_handler.GetWatcherEvents,
            filesystem_pb2.GetWatcherEventsRequest,
            filesystem_pb2.GetWatcherEventsResponse,
        )

    @app.post("/filesystem.Filesystem/RemoveWatcher")
    async def filesystem_remove_watcher(request: Request):
        """Remove directory watcher"""
        from .gen.filesystem.filesystem import filesystem_pb2

        return await _handle_unary(
            request,
            _filesystem_handler.RemoveWatcher,
            filesystem_pb2.RemoveWatcherRequest,
            filesystem_pb2.RemoveWatcherResponse,
        )

    logger.info("Registered envd Connect RPC routes:")
    logger.info("  Process service: /process.Process/*")
    logger.info("  Filesystem service: /filesystem.Filesystem/*")

    # Register REST API endpoints
    from .api import register_rest_api

    register_rest_api(app)


async def _handle_unary(request: Request, handler, req_class, resp_class):
    """Handle unary (request-response) RPC"""
    try:
        content_type = request.headers.get("content-type", "")
        content_encoding = request.headers.get("content-encoding", "identity")
        body = await request.body()

        # Handle compression
        if content_encoding == "gzip":
            import gzip

            body = gzip.decompress(body)

        # Parse request
        if (
            "application/json" in content_type
            or "application/connect+json" in content_type
        ):
            data = json.loads(body.decode("utf-8"))
            req_obj = ParseDict(data, req_class())
        else:
            req_obj = req_class()
            req_obj.ParseFromString(body)

        # Call handler
        response = await handler(req_obj)

        # Return response
        if (
            "application/json" in content_type
            or "application/connect+json" in content_type
        ):
            response_data = MessageToDict(response, preserving_proto_field_name=True)
            # Manually add empty repeated fields that were omitted
            # This ensures API compatibility with clients expecting these fields
            if hasattr(response, "processes") and "processes" not in response_data:
                response_data["processes"] = []
            return Response(
                content=json.dumps(response_data),
                media_type="application/json",
                headers={"Connect-Protocol-Version": "1"},
            )
        else:
            return Response(
                content=response.SerializeToString(),
                media_type="application/proto",
                headers={"Connect-Protocol-Version": "1"},
            )

    except ParseError as e:
        # Handle protobuf parsing errors (invalid enum values, etc.)
        logger.warning(f"Parse error in unary RPC: {e}")
        return Response(
            content=json.dumps(
                {"code": "invalid_argument", "message": f"Invalid request: {str(e)}"}
            ),
            status_code=400,
            media_type="application/json",
            headers={"Connect-Protocol-Version": "1"},
        )
    except (ConnectError, FilesystemConnectError) as e:
        # Handle Connect RPC errors with proper error codes
        status_code = 400  # Default to bad request
        if e.code == "not_found":
            status_code = 404
        elif e.code == "already_exists":
            status_code = 409  # Conflict
        elif e.code == "invalid_argument":
            status_code = 400
        elif e.code == "permission_denied":
            status_code = 403  # Forbidden
        elif e.code == "failed_precondition":
            status_code = 412
        elif e.code == "internal":
            status_code = 500

        return Response(
            content=json.dumps({"code": e.code, "message": e.message}),
            status_code=status_code,
            media_type="application/json",
            headers={"Connect-Protocol-Version": "1"},
        )
    except Exception as e:
        logger.exception(f"Error handling unary RPC: {e}")
        return Response(
            content=json.dumps({"code": "internal", "message": str(e)}),
            status_code=500,
            media_type="application/json",
            headers={"Connect-Protocol-Version": "1"},
        )


async def _handle_server_stream(request: Request, handler, req_class, resp_class):
    """Handle server streaming RPC"""
    try:
        content_type = request.headers.get("content-type", "")
        body = await request.body()

        # Parse request - handle Connect protocol envelope format
        if "application/connect+json" in content_type:
            # Decode envelope: 5-byte header (1 byte flags + 4 bytes length) + data
            if len(body) < 5:
                raise ValueError("Invalid envelope: body too short")
            flags = body[0]
            data_len = int.from_bytes(body[1:5], byteorder="big")
            data = body[5 : 5 + data_len]

            # Check if data is compressed (flag bit 0)
            if flags & 0b00000001:
                import gzip

                data = gzip.decompress(data)

            json_data = json.loads(data.decode("utf-8"))
            req_obj = ParseDict(json_data, req_class())
        elif "application/json" in content_type:
            # Direct JSON without envelope
            data = json.loads(body.decode("utf-8"))
            req_obj = ParseDict(data, req_class())
        else:
            # Protobuf format
            req_obj = req_class()
            req_obj.ParseFromString(body)

        # Stream responses
        async def generate():
            try:
                async for response in handler(req_obj):
                    if "application/connect+json" in content_type:
                        # Connect protocol envelope format
                        response_data = MessageToDict(
                            response, preserving_proto_field_name=True
                        )
                        data = json.dumps(response_data).encode("utf-8")
                        flags = 0  # No compression, not end stream
                        # Yield envelope: 1 byte flags + 4 bytes length + data
                        yield bytes([flags]) + len(data).to_bytes(
                            4, byteorder="big"
                        ) + data
                    elif "application/json" in content_type:
                        # Direct JSON without envelope (for non-Connect clients)
                        response_data = MessageToDict(
                            response, preserving_proto_field_name=True
                        )
                        yield json.dumps(response_data) + "\n"
                    else:
                        # Protobuf format
                        serialized = response.SerializeToString()
                        length = len(serialized)
                        yield length.to_bytes(4, byteorder="big")
                        yield serialized
            except Exception as e:
                logger.exception(f"Error in stream: {e}")
                # Send error in envelope format with end_stream flag
                if "application/connect+json" in content_type:
                    error_data = json.dumps(
                        {"error": {"code": "internal", "message": str(e)}}
                    ).encode("utf-8")
                    flags = 0b00000010  # end_stream flag
                    yield bytes([flags]) + len(error_data).to_bytes(
                        4, byteorder="big"
                    ) + error_data
                else:
                    yield json.dumps({"code": "internal", "message": str(e)}) + "\n"

        media_type = (
            "application/connect+json"
            if "json" in content_type
            else "application/proto"
        )
        return StreamingResponse(
            generate(),
            media_type=media_type,
            headers={"Connect-Protocol-Version": "1", "Connect-Streaming": "true"},
        )

    except Exception as e:
        logger.exception(f"Error handling server stream RPC: {e}")
        return Response(
            content=json.dumps({"code": "internal", "message": str(e)}),
            status_code=500,
            media_type="application/json",
        )


async def _handle_client_stream(request: Request, handler, req_class, resp_class):
    """Handle client streaming RPC"""
    try:
        content_type = request.headers.get("content-type", "")

        async def request_iterator():
            body = await request.body()
            if "application/json" in content_type:
                for line in body.decode().split("\n"):
                    if line.strip():
                        data = json.loads(line)
                        yield ParseDict(data, req_class())
            else:
                offset = 0
                while offset < len(body):
                    if len(body) - offset < 4:
                        break
                    length = int.from_bytes(body[offset : offset + 4], byteorder="big")
                    offset += 4
                    if len(body) - offset < length:
                        break
                    msg_bytes = body[offset : offset + length]
                    offset += length
                    req_obj = req_class()
                    req_obj.ParseFromString(msg_bytes)
                    yield req_obj

        response = await handler(request_iterator())

        if "application/json" in content_type:
            response_data = MessageToDict(response, preserving_proto_field_name=True)
            return Response(
                content=json.dumps(response_data),
                media_type="application/json",
                headers={"Connect-Protocol-Version": "1"},
            )
        else:
            return Response(
                content=response.SerializeToString(),
                media_type="application/proto",
                headers={"Connect-Protocol-Version": "1"},
            )

    except Exception as e:
        logger.exception(f"Error handling client stream RPC: {e}")
        return Response(
            content=json.dumps({"code": "internal", "message": str(e)}),
            status_code=500,
            media_type="application/json",
        )
