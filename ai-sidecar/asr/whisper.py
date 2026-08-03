"""
Whisper ASR 后端

使用 pywhispercpp（whisper.cpp 的 Python 绑定）进行本地语音识别。
支持 gguf 量化模型（tiny/base/small/medium/large），CPU 运行。
"""

from __future__ import annotations

import logging
import os

from .backend import AsrBackend, AsrOutput, AsrSegment

logger = logging.getLogger(__name__)

_DEFAULT_MODEL = "base"


class WhisperBackend(AsrBackend):
    """
    whisper.cpp Python 后端（pywhispercpp）。

    首次调用 transcribe() 时懒加载模型，避免启动时占用过多内存。
    """

    def __init__(
        self,
        model_name: str = _DEFAULT_MODEL,
        n_threads:  int = 4,
    ) -> None:
        self._model_name = model_name
        self._n_threads  = n_threads
        self._model      = None   # 懒加载

    # ── 接口实现 ──────────────────────────────────────────────────────────────

    def is_available(self) -> bool:
        try:
            import pywhispercpp  # type: ignore  # noqa: F401
            return True
        except ImportError:
            return False

    def transcribe(self, audio_path: str, language: Optional[str] = None) -> AsrOutput:
        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"音频文件不存在: {audio_path}")

        if not self.is_available():
            raise RuntimeError("pywhispercpp 未安装，请运行: pip install pywhispercpp")

        self._ensure_loaded()

        logger.debug("开始转录: %s", audio_path)

        # 设置语言参数
        params_kw: dict = {}
        if language:
            params_kw["language"] = language

        raw_segments = self._model.transcribe(audio_path, **params_kw)  # type: ignore[union-attr]

        segments: list[AsrSegment] = []
        full_text_parts: list[str] = []

        for seg in raw_segments:
            text = seg.text.strip()
            if text:
                segments.append(AsrSegment(
                    start_sec = seg.t0 / 100.0,  # whisper.cpp 单位：厘秒
                    end_sec   = seg.t1 / 100.0,
                    text      = text,
                ))
                full_text_parts.append(text)

        full_text  = "\n".join(full_text_parts)
        # 尝试从模型输出获取检测到的语言
        detected_lang = language or "zh"

        return AsrOutput(
            text     = full_text,
            language = detected_lang,
            segments = segments,
        )

    @property
    def model_name(self) -> str:
        return f"whisper-{self._model_name}"

    # ── 内部 ──────────────────────────────────────────────────────────────────

    def _ensure_loaded(self) -> None:
        if self._model is None:
            from pywhispercpp.model import Model  # type: ignore
            logger.info("正在加载 Whisper 模型: %s", self._model_name)
            self._model = Model(
                self._model_name,
                n_threads=self._n_threads,
                print_progress=False,
                print_realtime=False,
            )
            logger.info("Whisper 模型加载完成")
