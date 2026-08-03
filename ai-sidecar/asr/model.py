"""
AsrModel — ASR 编排器（支持后端注入）
"""

from __future__ import annotations

import logging

from .backend import AsrBackend, AsrOutput
from .whisper  import WhisperBackend

logger = logging.getLogger(__name__)


class AsrModel:
    """
    ASR 模型编排器。

    默认使用 WhisperBackend，支持通过构造函数注入自定义后端。
    """

    def __init__(self, backend: Optional[AsrBackend] = None) -> None:
        self._backend = backend or WhisperBackend()

    @classmethod
    def create_default(cls) -> "AsrModel":
        """创建默认配置（whisper-base）"""
        return cls(backend=WhisperBackend())

    def transcribe(self, audio_path: str, language: Optional[str] = None) -> AsrOutput:
        """
        转录音频文件。

        Raises:
            FileNotFoundError: 音频文件不存在
            RuntimeError:      后端不可用或转录失败
        """
        if not self._backend.is_available():
            raise RuntimeError(
                f"ASR 后端 {self._backend.model_name!r} 不可用"
                "（请确认 pywhispercpp 已安装）"
            )
        return self._backend.transcribe(audio_path, language)

    @property
    def model_name(self) -> str:
        return self._backend.model_name
