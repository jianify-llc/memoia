"""Export the single typed contract; does not initialize connections or call models."""
import json
import os
from pathlib import Path
import sys

from fastapi import FastAPI
os.environ.setdefault("MEMOBASE_LLM_API_KEY", "openapi-export-not-a-credential")
os.environ.setdefault("MEMOBASE_EMBEDDING_API_KEY", "openapi-export-not-a-credential")
os.environ.setdefault("DATABASE_URL", "postgresql://localhost/openapi_export")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
from memoia_server.api_layer.source import router
from memoia_server.api_layer.projects import router as project_router

sdk_package = Path(__file__).resolve().parents[3] / "sdks/typescript/package.json"
app = FastAPI(title="Memoia API", version=json.loads(sdk_package.read_text())["version"])
app.include_router(router)
app.include_router(project_router)
from memoia_server.api_layer.management import router as management_router
app.include_router(management_router)
schema = app.openapi()
schema.setdefault("components", {})["securitySchemes"] = {"BearerAuth": {"type": "http", "scheme": "bearer"}}
schema["security"] = [{"BearerAuth": []}]
schema["paths"]["/api/healthcheck"]["get"]["security"] = []
output = json.dumps(schema, indent=2, ensure_ascii=False) + "\n"
if len(sys.argv) > 1:
    # Contract generation is a mechanical rewrite, not an application source edit.
    Path(sys.argv[1]).write_text(output)
else:
    sys.stdout.write(output)
