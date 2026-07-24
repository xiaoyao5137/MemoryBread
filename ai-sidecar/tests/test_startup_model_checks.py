from __future__ import annotations

import pytest

import startup_checks


@pytest.mark.parametrize(
    (
        "ollama_installed",
        "ollama_running",
        "llm_available",
        "embedding_available",
        "expected_critical",
        "expected_all",
    ),
    [
        pytest.param(False, False, False, False, False, False, id="clean-mac-without-ollama"),
        pytest.param(True, True, False, False, False, False, id="missing-text-model"),
        pytest.param(True, True, True, False, True, False, id="missing-vector-model-degraded"),
        pytest.param(True, True, True, True, True, True, id="all-local-models-ready"),
    ],
)
def test_startup_model_readiness_matrix(
    monkeypatch,
    ollama_installed,
    ollama_running,
    llm_available,
    embedding_available,
    expected_critical,
    expected_all,
):
    detail = {
        "ollama_installed": ollama_installed,
        "ollama_running": ollama_running,
        "message": "test setup status",
        "recommended_install_method": "official download",
    }
    monkeypatch.setattr(startup_checks, "get_ollama_setup_detail", lambda: detail)
    monkeypatch.setattr(startup_checks, "check_ollama_installed", lambda: ollama_installed)
    monkeypatch.setattr(startup_checks, "check_ollama_running", lambda: ollama_running)
    monkeypatch.setattr(startup_checks, "check_model_available", lambda *_args, **_kwargs: llm_available)
    monkeypatch.setattr(startup_checks, "check_embedding_model", lambda: embedding_available)
    monkeypatch.setattr(startup_checks, "check_knowledge_fts", lambda: True)

    result = startup_checks.run_startup_checks()

    assert result["critical_passed"] is expected_critical
    assert result["all_passed"] is expected_all
    assert result["embedding_ok"] is embedding_available
