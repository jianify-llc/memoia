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


def test_fact_overrides_survive_project_yaml_without_changing_loop_config():
    project = ProfileConfig.load_config_string("""llm_model: gpt-6-luna
reasoning_effort: high
fact_llm_model: gpt-6.1-terra
fact_reasoning_effort: none
fact_temperature: 0.2
""")
    assert (project.llm_model, project.reasoning_effort) == ("gpt-6-luna", "high")
    assert (project.fact_llm_model, project.fact_reasoning_effort, project.fact_temperature) == (
        "gpt-6.1-terra", "none", 0.2)


@pytest.mark.parametrize("text", ["fact_llm_model: ''", "fact_reasoning_effort: ultra",
    "fact_temperature: true", "fact_temperature: 2.1", "fact_temperature: -0.1",
    "fact_temperature: .nan", "fact_temperature: .inf", "fact_temperature: '0.2'"])
def test_invalid_fact_overrides_are_rejected(text):
    assert not is_valid_profile_config(text).ok()


@pytest.mark.parametrize("field", ["profile_strict_mode", "profile_validate_mode", "event_theme_requirement", "unknown_field"])
def test_retired_and_unknown_project_fields_are_rejected_without_values(field):
    with pytest.raises(ValueError) as error:
        ProfileConfig.load_config_string(f"{field}: private-configuration-value")
    assert field in str(error.value)
    assert "private-configuration-value" not in str(error.value)
    assert not is_valid_profile_config(f"{field}: private-configuration-value").ok()


@pytest.mark.parametrize("field", ["summary_llm_model", "buffer_flush_interval", "thinking_llm_model", "unknown_field"])
def test_service_fields_are_checked_in_yaml_and_environment(monkeypatch, field):
    with pytest.raises(ValueError, match=field):
        Config._process_env_vars({field: "not-to-be-logged"})
    monkeypatch.setenv("MEMOBASE_" + field.upper(), "not-to-be-logged")
    with pytest.raises(ValueError) as error:
        Config._process_env_vars({})
    assert field.upper() in str(error.value) and "not-to-be-logged" not in str(error.value)


def test_malformed_project_config_does_not_echo_body():
    result = is_valid_profile_config('language: [private-configuration-value')
    assert not result.ok()
    assert "private-configuration-value" not in str(result)


@pytest.mark.parametrize("value", [False, 0, "private-value", {"topic": "private-value"}])
@pytest.mark.parametrize("field", ["overwrite_user_profiles", "additional_user_profiles"])
def test_invalid_topic_containers_rejected_at_load(value, field):
    import json
    with pytest.raises(ValueError, match="must be a list"):
        ProfileConfig.load_config_string(json.dumps({field: value}))
    with pytest.raises(ValueError, match="must be a list"):
        Config(llm_api_key="local-test-key", enable_event_embedding=False, **{field: value})
