"""Project configuration validation uses the pinned SDK's reasoning contract."""

import pytest
from openai.types.shared import ReasoningEffort
from typeguard import check_type

from memoia_server.env import Config, ProfileConfig
from memoia_server.utils import is_valid_profile_config


def test_service_defaults_and_project_fallback_are_explicit():
    service = Config(llm_api_key="local-test-key", enable_event_embedding=False)
    assert service.best_llm_model == "gpt-6-luna"
    assert service.llm_reasoning_effort == "high"
    for text in ("", "language: en", "llm_model: null\nreasoning_effort: null"):
        project = ProfileConfig.load_config_string(text)
        assert project.llm_model is None and project.reasoning_effort is None
        assert (project.llm_model or service.best_llm_model,
                project.reasoning_effort or service.llm_reasoning_effort) == ("gpt-6-luna", "high")


@pytest.mark.parametrize("effort", ["none", "minimal", "low", "medium", "high", "xhigh", "max"])
def test_project_model_and_effort_survive_yaml_validation(effort):
    check_type(effort, ReasoningEffort)
    text = f"llm_model: project-model\nreasoning_effort: {effort}"
    project = ProfileConfig.load_config_string(text)
    assert project.llm_model == "project-model" and project.reasoning_effort == effort
    assert is_valid_profile_config(text).ok()


@pytest.mark.parametrize("text", [
    "reasoning_effort: ultra", "reasoning_effort: HIGH", "reasoning_effort: 4",
    "reasoning_effort: true", "llm_model: ''", "llm_model: '   '",
    "llm_model: 4", "[llm_model, project-model]",
])
def test_invalid_project_configuration_is_rejected_not_silently_defaulted(text):
    with pytest.raises(ValueError):
        ProfileConfig.load_config_string(text)
    assert not is_valid_profile_config(text).ok()


@pytest.mark.parametrize("changes", [
    {"best_llm_model": None}, {"best_llm_model": ""},
    {"llm_reasoning_effort": None}, {"llm_reasoning_effort": "ultra"},
])
def test_invalid_service_model_configuration_fails_closed(changes):
    with pytest.raises(ValueError):
        Config(llm_api_key="local-test-key", enable_event_embedding=False, **changes)


def test_project_model_and_effort_can_override_independently():
    project = ProfileConfig.load_config_string("llm_model: project-model")
    assert project.llm_model == "project-model" and project.reasoning_effort is None
    project = ProfileConfig.load_config_string("reasoning_effort: none")
    assert project.llm_model is None and project.reasoning_effort == "none"
