"""
ASR 后端抽象基类与数据类型

ASR (Automatic Speech Recognition) 将音频文件转录为文本。
"""

from __future__ import annotations

from abc         import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class AsrSegment:
    """单个转录片段（含时间戳）"""
    start_sec: float
    end_sec:   float
    text:      str


@dataclass
class AsrOutput:
    """ASR 完整输出"""
    text:      str
    language:  str                  = "zh"
    segments:  list[AsrSegment]     = field(default_factory=list)

    @property
    def duration(self) -> float:
        """总时长（秒）"""
        if not self.segments:
            return 0.0
        return self.segments[-1].end_sec

    @property
    def is_empty(self) -> bool:
        return not self.text.strip()


class AsrBackend(ABC):
    """所有 ASR 后端必须实现的接口"""

    @abstractmethod
    def is_available(self) -> bool:
        """当前环境是否可用"""

    @abstractmethod
    def transcribe(self, audio_path: str, language: Optional[str] = None) -> AsrOutput:
        """
        将音频文件转录为文本。

        Args:
            audio_path: 音频文件路径（WAV/MP3/M4A）
            language:   语言代码（None 时自动检测）

        Returns:
            AsrOutput（含 text / language / segments）
        """

    @property
    @abstractmethod
    def model_name(self) -> str:
        """模型标识符"""
