# Modified for Memoia: relocated from the upstream memobase_server package.
class ExternalAPIError(Exception):
    """供应商错误只保留受控分类，不携带可能含输入的响应正文。"""

    def __init__(self, message: str = "External API request failed", *, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code
