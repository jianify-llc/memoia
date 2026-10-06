# Modified for Memoia: relocated from the upstream memobase_server package.
import os
import time
import uuid
import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi import Request
from fastapi.responses import JSONResponse
from uvicorn.protocols.utils import get_path_with_query_string
from ..env import ProjectStatus, LOG
from ..models.database import DEFAULT_PROJECT_ID
from ..models.utils import Promise
from ..telemetry import (
    telemetry_manager,
    CounterMetricName,
    HistogramMetricName,
)
from .. import __version__
from ..models.response import CODE
from ..auth.token import (
    parse_project_id,
    check_project_secret,
    get_project_status,
)




async def global_wrapper_middleware(request: Request, call_next):
    req_id = request.headers.get("X-Request-ID")
    if req_id is None:
        req_id = str(uuid.uuid4())
    project_id = getattr(request.state, "memobase_project_id", None)
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(
        request_id=req_id, project_id=project_id, memobase_version=__version__
    )

    private_context = request.url.path.startswith("/api/")
    # Do not log query strings, including rejected legacy requests.
    url = request.url.path if private_context else get_path_with_query_string(request.scope)
    client_host = request.client.host
    client_port = request.client.port
    http_method = request.method
    http_version = request.scope["http_version"]

    start_time = time.perf_counter_ns()

    try:
        response = await call_next(request)
        status_code = response.status_code
        errmsg = None
        traceback_str = None
    except Exception:
        status_code = 500
        errmsg = "Service unavailable"
        traceback_str = None
        response = JSONResponse(status_code=500, content={"detail": {
            "code": "internal_error", "message": "Service unavailable", "retryable": True,
        }})
    process_time = time.perf_counter_ns() - start_time

    if status_code >= 400:
        _log_f = LOG.error
    else:
        _log_f = LOG.info
    _log_f(
        f"""{client_host}:{client_port} - "{http_method} {url} HTTP/{http_version}" {status_code}""",
        extra={
            "http": {
                "url": request.url.path if private_context else str(request.url),
                "status_code": status_code,
                "method": http_method,
                "version": http_version,
            },
            "network": {"client": {"ip": client_host, "port": client_port}},
            "duration": process_time / 10**9,  # convert to s
            "type": "access",
            "errmsg": errmsg,
            "__internal_traceback": traceback_str,
        },
    )
    response.headers["X-Process-Time"] = str(process_time / 10**9)

    return response


class AuthMiddleware(BaseHTTPMiddleware):
    def normalize_path(self, path: str) -> str:
        """Remove dynamic path parameters to get normalized path for metrics"""
        if not path.startswith("/api"):
            return path

        # 路径只保留资源形状，UUID 和来源编号不能制造高基数指标。
        import re
        return re.sub(r"(/users|/projects|/sources|/blobs|/operations|/keys|/profiles|/events)/[^/]+", r"\1/{id}", path)

    async def dispatch(self, request, call_next):
        if not request.url.path.startswith("/api"):
            return await call_next(request)

        if request.url.path == "/api/healthcheck":
            telemetry_manager.increment_counter_metric(
                CounterMetricName.HEALTHCHECK,
                1,
            )
            return await call_next(request)

        auth_token = request.headers.get("Authorization")
        if not auth_token or not auth_token.startswith("Bearer "):
            return JSONResponse(status_code=401, content={"detail": {"code": "unauthorized", "message": "Unauthorized", "retryable": False}})
        auth_token = (auth_token.split(" ")[1]).strip()
        is_root = self.is_valid_root(auth_token)
        request.state.is_memobase_root = is_root
        request.state.memobase_project_id = DEFAULT_PROJECT_ID
        request.state.memoia_scopes = ["admin"]
        if not is_root:
            from ..auth.token import authenticate_scoped_key
            scoped = authenticate_scoped_key(auth_token) if auth_token.startswith("mka_") else None
            p = await self.parse_project_token(auth_token) if scoped is None else Promise.resolve(scoped[0])
            if not p.ok():
                return JSONResponse(status_code=401, content={"detail": {"code": "unauthorized", "message": "Unauthorized", "retryable": False}})
            request.state.memobase_project_id = p.data()
            if scoped is not None:
                request.state.memoia_scopes = scoped[1]
        read_request = request.method in {"GET", "HEAD", "OPTIONS"}
        if request.method == "POST" and request.url.path.endswith(("/context", "/search")):
            read_request = True
        required = "read" if read_request else "write"
        if not read_request and request.url.path == "/api/project/config":
            required = "admin"
        scopes = request.state.memoia_scopes
        if "admin" not in scopes and required not in scopes:
            return JSONResponse(status_code=403, content={"detail": {"code": "scope_required", "message": "API key lacks required scope", "retryable": False}})

        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            maximum = 2 * 1024 * 1024
            body = bytearray()
            async for chunk in request.stream():
                if len(body) + len(chunk) > maximum:
                    return JSONResponse(status_code=413, content={"detail": {"code": "body_too_large", "message": "Request body exceeds 2 MiB", "retryable": False}})
                body.extend(chunk)
            request._body = bytes(body)
        # await capture_int_key(TelemetryKeyName.has_request)

        normalized_path = self.normalize_path(request.url.path)

        telemetry_manager.increment_counter_metric(
            CounterMetricName.REQUEST,
            1,
            {
                "project_id": request.state.memobase_project_id,
                "path": normalized_path,
                "method": request.method,
            },
        )

        start_time = time.time()
        response = await call_next(request)

        telemetry_manager.record_histogram_metric(
            HistogramMetricName.REQUEST_LATENCY_MS,
            (time.time() - start_time) * 1000,
            {
                "project_id": request.state.memobase_project_id,
                "path": normalized_path,
                "method": request.method,
            },
        )
        return response

    def is_valid_root(self, token: str) -> bool:
        access_token = os.getenv("ACCESS_TOKEN")
        from hmac import compare_digest
        if not access_token or not access_token.strip():
            return False
        return compare_digest(token, access_token.strip())

    async def parse_project_token(self, token: str) -> Promise[str]:
        p = parse_project_id(token)
        if not p.ok():
            return Promise.reject(CODE.UNAUTHORIZED, "Invalid project id format")
        project_id = p.data()
        p = await check_project_secret(project_id, token)
        if not p.ok():
            return p
        if not p.data():
            return Promise.reject(CODE.UNAUTHORIZED, "Wrong secret key")
        p = await get_project_status(project_id)
        if not p.ok():
            return p
        if p.data() == ProjectStatus.suspended:
            return Promise.reject(CODE.FORBIDDEN, "Your project is suspended!")
        return Promise.resolve(project_id)
