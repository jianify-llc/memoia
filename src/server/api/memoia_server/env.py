# Modified for Memoia: relocated from the upstream memobase_server package.
"""
Initialize logger, encoder, and config.
"""

import os
import datetime
import json
import yaml
import logging
import tiktoken
import dataclasses
from dataclasses import dataclass, field
from typing import Optional, Literal, Union
from dotenv import load_dotenv
from zoneinfo import ZoneInfo
from datetime import timezone
from typeguard import check_type, TypeCheckError
from openai.types.shared import ReasoningEffort
import structlog
from .types import UserProfileTopic
from .struct_logger import ProjectStructLogger, configure_logger
from pydantic import ValidationError

load_dotenv()


class BillingStatus:
    free = "free"
    pro = "pro"
    usage_based = "usage_based"


BILLING_REFILL_AMOUNT_MAP = {
    BillingStatus.free: int(os.getenv("USAGE_TOKEN_LIMIT_ACTIVE", 0)) or None,
}


class ProjectStatus:
    ultra = "ultra"
    pro = "pro"
    active = "active"
    suspended = "suspended"


USAGE_TOKEN_LIMIT_MAP = {
    ProjectStatus.active: int(os.getenv("USAGE_TOKEN_LIMIT_ACTIVE", -1)),
    ProjectStatus.pro: int(os.getenv("USAGE_TOKEN_LIMIT_PRO", -1)),
    ProjectStatus.ultra: int(os.getenv("USAGE_TOKEN_LIMIT_ULTRA", -1)),
}


class ContanstTable:
    topic = "topic"
    sub_topic = "sub_topic"
    memo = "memo"
    update_hits = "update_hits"


class BufferStatus:
    idle = "idle"
    processing = "processing"
    done = "done"
    failed = "failed"


class TelemetryKeyName:
    insert_blob_request = "insert_blob_request"
    insert_blob_success_request = "insert_blob_success_request"
    llm_input_tokens = "llm_input_tokens"
    llm_output_tokens = "llm_output_tokens"
    llm_usage_unknown = "llm_usage_unknown"
    has_request = "has_request"


def _validate_llm_configuration(model: str | None, effort: ReasoningEffort) -> None:
    if model is not None and (not isinstance(model, str) or not model.strip()):
        raise ValueError("llm_model must be a non-empty string")
    try:
        check_type(effort, ReasoningEffort)
    except TypeCheckError:
        raise ValueError("reasoning_effort must match the OpenAI SDK ReasoningEffort values") from None


def _supported_config(cls, value):
    if value is None:
        return {}
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError("Configuration must be a YAML mapping with field names")
    unknown = set(value) - {item.name for item in dataclasses.fields(cls)}
    if unknown:
        raise ValueError("Unsupported configuration fields: " + ", ".join(sorted(unknown)))
    return dict(value)


def _validate_topics(topics):
    if topics is None:
        return
    if not isinstance(topics, list):
        raise ValueError("Topic configuration must be a list")
    try:
        for topic in topics:
            UserProfileTopic(**topic)
    except ValidationError as error:
        fields = sorted({".".join(map(str, item["loc"])) for item in error.errors(include_input=False)})
        raise ValueError("Invalid topic configuration fields: " + ", ".join(fields)) from None
    except (TypeError, AttributeError):
        raise ValueError("Invalid topic configuration fields") from None


@dataclass
class Config:
    # IMPORTANT!
    persistent_chat_blobs: bool = False
    use_timezone: Optional[
        Literal[
            "UTC", "America/New_York", "Europe/London", "Asia/Tokyo", "Asia/Shanghai"
        ]
    ] = None

    max_chat_blob_buffer_token_size: int = 1024

    # LLM
    language: Literal["en", "zh"] = "en"
    llm_style: Literal["openai"] = "openai"
    llm_base_url: str = None
    # Custom gateways must declare support; absent means only native OpenAI enables it.
    llm_prompt_cache_options: bool | None = None
    llm_api_key: str = None
    llm_openai_default_query: dict[str, str] = None
    llm_openai_default_header: dict[str, str] = None
    best_llm_model: str = "gpt-6-luna"
    llm_reasoning_effort: ReasoningEffort = "high"

    enable_event_embedding: bool = True
    embedding_provider: Literal["openai", "jina", "ollama"] = "openai"
    embedding_api_key: str = None
    embedding_base_url: str = None
    embedding_dim: int = 1536
    embedding_model: str = "text-embedding-3-small"
    embedding_max_token_size: int = 8192
    embedding_batch_size: int = 64
    source_max_input_tokens: int = 16384
    source_context_window_tokens: int = 131072
    source_output_reserve_tokens: int = 32768
    source_input_retention_seconds: int = 7 * 24 * 60 * 60

    additional_user_profiles: list[dict] = field(default_factory=list)
    overwrite_user_profiles: Optional[list[dict]] = None
    event_tags: list[dict] = field(default_factory=list)
    # Telemetry
    telemetry_deployment_environment: str = "local"

    @classmethod
    def _process_env_vars(cls, config_dict):
        config_dict = _supported_config(cls, config_dict)
        names = {f"MEMOBASE_{item.name.upper()}" for item in dataclasses.fields(cls)}
        unknown = {key for key in os.environ if key.startswith("MEMOBASE_")} - names
        if unknown:
            raise ValueError("Unsupported configuration fields: " + ", ".join(sorted(unknown)))

        for field in dataclasses.fields(cls):
            field_name = field.name
            field_type = field.type
            env_var_name = f"MEMOBASE_{field_name.upper()}"
            if env_var_name in os.environ:
                env_value = os.environ[env_var_name]
                if field_name == "llm_style" and env_value not in ("openai", '"openai"'):
                    raise ValueError("Only llm_style=openai is supported; doubao_cache has been removed")

                # Try to parse as JSON first
                try:
                    parsed_value = json.loads(env_value)
                    # Check if parsed value matches the type
                    try:
                        check_type(parsed_value, field_type)
                        config_dict[field_name] = parsed_value
                        continue
                    except (TypeError, TypeCheckError):
                        # Parsed value doesn't match type, fall through to try raw string
                        pass
                except json.JSONDecodeError:
                    # Not valid JSON, fall through to try raw string
                    pass

                # Try the raw string
                try:
                    check_type(env_value, field_type)
                    config_dict[field_name] = env_value
                except (TypeError, TypeCheckError):
                    raise ValueError(f"Invalid configuration field: {env_var_name}") from None

        return config_dict

    @classmethod
    def load_config(cls) -> "Config":
        if not os.path.exists("config.yaml"):
            overwrite_config = {}
        else:
            with open("config.yaml") as f:
                try:
                    overwrite_config = yaml.safe_load(f)
                except yaml.YAMLError:
                    raise ValueError("Invalid service configuration YAML") from None
                LOG.info(f"Load ./config.yaml")

        # Process environment variables
        overwrite_config = cls._process_env_vars(overwrite_config)

        overwrite_config = cls(**overwrite_config)
        LOG.info("Memoia configuration loaded")
        return overwrite_config

    def __post_init__(self):
        if self.llm_prompt_cache_options is not None and type(self.llm_prompt_cache_options) is not bool:
            raise ValueError("llm_prompt_cache_options must be a boolean or null")
        if self.llm_style != "openai":
            raise ValueError("Only llm_style=openai is supported; doubao_cache has been removed")
        if self.best_llm_model is None or self.llm_reasoning_effort is None:
            raise ValueError("The service model and reasoning effort must be configured")
        _validate_llm_configuration(self.best_llm_model, self.llm_reasoning_effort)
        if self.source_input_retention_seconds <= 0:
            raise ValueError("source_input_retention_seconds must be positive")
        assert self.llm_api_key is not None, "llm_api_key is required"
        if self.enable_event_embedding:
            if self.embedding_api_key is None and (
                self.llm_style == self.embedding_provider == "openai"
            ):
                # default to llm config if embedding_api_key is not set
                self.embedding_api_key = self.llm_api_key
                self.embedding_base_url = self.llm_base_url
            assert (
                self.embedding_api_key is not None
            ), "embedding_api_key is required for event embedding"

            if self.embedding_provider == "jina":
                self.embedding_base_url = (
                    self.embedding_base_url or "https://api.jina.ai/v1"
                )
                assert self.embedding_model in {
                    "jina-embeddings-v3",
                }, "embedding_model must be one of the following: jina-embeddings-v3"

        _validate_topics(self.additional_user_profiles)
        _validate_topics(self.overwrite_user_profiles)

    @property
    def timezone(self) -> timezone:
        if self.use_timezone is None:
            return datetime.datetime.now().astimezone().tzinfo

        # For named timezones, we need to use the datetime.timezone.ZoneInfo
        return ZoneInfo(self.use_timezone)


@dataclass
class ProfileConfig:
    language: Literal["en", "zh"] = None
    llm_model: str | None = None
    reasoning_effort: ReasoningEffort = None
    additional_user_profiles: list[dict] = field(default_factory=list)
    overwrite_user_profiles: Optional[list[dict]] = None

    event_tags: list[dict] = None

    def __post_init__(self):
        _validate_llm_configuration(self.llm_model, self.reasoning_effort)
        if self.language not in ["en", "zh"]:
            self.language = None
        _validate_topics(self.additional_user_profiles)
        _validate_topics(self.overwrite_user_profiles)

    @classmethod
    def load_config_string(cls, config_string: str) -> "ProfileConfig":
        try:
            value = yaml.safe_load(config_string)
        except yaml.YAMLError:
            raise ValueError("Invalid project configuration YAML") from None
        return cls(**_supported_config(cls, value))


class Colors:
    BLUE = "\033[94m"
    BOLD = "\033[1m"
    GREEN = "\033[92m"
    END = "\033[0m"


# remove default uvicorn loggers cause we have our own
for _log in ["uvicorn", "uvicorn.error", "uvicorn.access"]:
    logging.getLogger(_log).handlers.clear()
    # logging.getLogger(_log).propagate = True

log_format = os.getenv("LOG_FORMAT", "plain")
if log_format == "json":
    configure_logger()
    logger = structlog.get_logger()
    LOG = logger.bind(app_name="memobase_server")
else:
    LOG = logging.getLogger("memobase_server")
    LOG.setLevel(logging.INFO)

    formatter = logging.Formatter(
        f"{Colors.BOLD}{Colors.BLUE}%(name)s |{Colors.END}  %(levelname)s - %(asctime)s  -  %(message)s"
    )
    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    LOG.addHandler(handler)


ENCODER = tiktoken.encoding_for_model("gpt-4o")

CONFIG = Config.load_config()


class ProjectLogger:
    def __init__(self, logger: logging.Logger):
        self.logger = logger

    def debug(self, project_id: str, user_id: str, message: str):
        self.logger.debug(
            json.dumps({"project_id": str(project_id), "user_id": str(user_id)})
            + " | "
            + message
        )

    def info(self, project_id: str, user_id: str, message: str):
        self.logger.info(
            json.dumps({"project_id": str(project_id), "user_id": str(user_id)})
            + " | "
            + message
        )

    def warning(self, project_id: str, user_id: str, message: str):
        self.logger.warning(
            json.dumps({"project_id": str(project_id), "user_id": str(user_id)})
            + " | "
            + message
        )

    def error(
        self, project_id: str, user_id: str, message: str, exc_info: bool = False
    ):
        self.logger.error(
            json.dumps({"project_id": str(project_id), "user_id": str(user_id)})
            + " | "
            + message,
            exc_info=exc_info,
        )


if log_format == "json":
    TRACE_LOG = ProjectStructLogger(LOG)
else:
    TRACE_LOG = ProjectLogger(LOG)
