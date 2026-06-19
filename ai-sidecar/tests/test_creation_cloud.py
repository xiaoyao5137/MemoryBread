from __future__ import annotations

import asyncio

import httpx
import pytest

from creation.service import CreationService


def test_anthropic_messages_url_accepts_common_base_url_shapes():
    assert CreationService._anthropic_messages_url("") == "https://api.anthropic.com/v1/messages"
    assert CreationService._anthropic_messages_url("https://api.anthropic.com") == "https://api.anthropic.com/v1/messages"
    assert CreationService._anthropic_messages_url("https://api.anthropic.com/v1") == "https://api.anthropic.com/v1/messages"
    assert CreationService._anthropic_messages_url("https://api.anthropic.com/v1/messages") == "https://api.anthropic.com/v1/messages"


def test_normalize_anthropic_messages_removes_empty_messages_and_merges_roles():
    system, messages = CreationService._normalize_anthropic_messages(
        [
            {"role": "system", "content": "Be concise."},
            {"role": "user", "content": "在吗"},
            {"role": "assistant", "content": ""},
            {"role": "user", "content": "继续"},
        ]
    )

    assert system == "Be concise."
    assert messages == [{"role": "user", "content": "在吗\n\n继续"}]


def test_raise_for_cloud_error_exposes_provider_message():
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(
        400,
        request=request,
        json={"error": {"type": "invalid_request_error", "message": "messages: text content blocks must be non-empty"}},
    )

    with pytest.raises(RuntimeError, match="text content blocks must be non-empty"):
        asyncio.run(CreationService._raise_for_cloud_error(response))
