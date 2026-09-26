# Modified for Memoia: relocated from the upstream memobase_server package.
from typing import Optional
from pydantic import BaseModel, Field


class ClaimData(BaseModel):
    claim: Optional[str] = None
