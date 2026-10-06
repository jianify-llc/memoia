# Modified for Memoia: use the renamed internal server package.
import memoia_server.env
import os

# Done setting up env
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from memoia_server.connectors import (
    close_connection,
    init_redis_pool,
)
from memoia_server.api_layer import middleware
from memoia_server.env import LOG
from memoia_server.llms.embeddings import check_embedding_sanity
from memoia_server.llms import llm_sanity_check
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    from memoia_server.controllers.source import purge_expired_inputs
    from memoia_server.schema import check_schema
    check_schema()
    init_redis_pool()
    await check_embedding_sanity()
    await llm_sanity_check()
    LOG.info(f"Start Memoia Server {memoia_server.__version__} 🖼️")
    async def erase_expired():
        while True:
            try:
                sweep = asyncio.create_task(asyncio.to_thread(purge_expired_inputs))
                try:
                    await asyncio.shield(sweep)
                except asyncio.CancelledError:
                    # Cancelling a thread await does not stop its SQL transaction.
                    # Finish this sweep before closing shared connections.
                    await sweep
                    raise
            except Exception:
                LOG.error("Temporary input erasure failed; inspect database connectivity")
            await asyncio.sleep(60)
    eraser = asyncio.create_task(erase_expired())
    try:
        yield
    finally:
        eraser.cancel()
        try:
            await eraser
        except asyncio.CancelledError:
            pass
        await close_connection()


app = FastAPI(
    lifespan=lifespan,
)
from memoia_server.api_layer.source import router as source_router
app.include_router(source_router)
from memoia_server.api_layer.projects import router as project_router
app.include_router(project_router)
from memoia_server.api_layer.management import router as management_router
app.include_router(management_router)


@app.exception_handler(RequestValidationError)
async def private_validation_error(request, error):
    # Pydantic's default error includes the rejected message body; do not echo that input.
    details = [{key: item[key] for key in ("loc", "type", "msg") if key in item}
               for item in error.errors()]
    return JSONResponse(status_code=422, content={"detail": details})

# CORS configuration
USE_CORS = os.environ.get("USE_CORS", "False").lower() == "true"  # Default to False
API_HOSTS_STR = os.environ.get(
    "API_HOSTS", "https://api.memobase.dev,https://api.memobase.cn"
)
API_HOSTS = [host.strip() for host in API_HOSTS_STR.split(",")]

if USE_CORS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=API_HOSTS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

NO_AUTH = {"/api/healthcheck"}


def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema

    servers: list = []
    for host in API_HOSTS:
        servers.append({"url": host})

    openapi_schema = get_openapi(  # type: ignore
        title="Memoia API",
        version=memoia_server.__version__,
        summary="Memoia memory and administration API",
        routes=app.routes,
        servers=servers,
    )
    openapi_schema["components"]["securitySchemes"] = {
        "BearerAuth": {
            "type": "http",
            "scheme": "bearer",
        }
    }
    openapi_schema["security"] = [{"BearerAuth": []}]
    for path in openapi_schema["paths"]:
        if path in NO_AUTH:
            for method in openapi_schema["paths"][path]:
                openapi_schema["paths"][path][method]["security"] = []

    app.openapi_schema = openapi_schema  # type: ignore
    return app.openapi_schema


app.openapi = custom_openapi


@app.middleware("http")
async def global_wrapper_middleware(request, call_next):
    return await middleware.global_wrapper_middleware(request, call_next)


app.add_middleware(middleware.AuthMiddleware)

FastAPIInstrumentor.instrument_app(app)
