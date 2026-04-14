"""
PaddleOCR 后端

中文识别最优选择。采用懒加载策略：第一次请求时才初始化模型，
避免 Sidecar 启动时的长时间等待。

安装：
    pip install paddlepaddle paddleocr
    # GPU 版本：pip install paddlepaddle-gpu
"""

from __future__ import annotations

import logging
import threading

from .base import OcrBackend, OcrBox, OcrOutput

logger = logging.getLogger(__name__)


class PaddleBackend(OcrBackend):
    """
    PaddleOCR 后端。

    支持中/英双语，自动检测文字方向（use_angle_cls=True）。
    使用 PP-OCRv4 模型（paddleocr>=2.7）。
    """

    def __init__(self, lang: str = "ch", use_gpu: bool = False) -> None:
        self._lang    = lang
        self._use_gpu = use_gpu
        self._ocr: object | None = None  # 懒加载，避免启动延迟
        self._ocr_lock = threading.Lock()

    # ── 公共接口 ──────────────────────────────────────────────────────────────

    def is_available(self) -> bool:
        """检查 paddleocr 是否已安装"""
        try:
            import paddleocr  # noqa: F401
            return True
        except ImportError:
            return False

    def run(self, image_path: str) -> OcrOutput:
        self._ensure_loaded()

        raw = self._ocr.ocr(image_path)  # type: ignore[union-attr]

        boxes: list[OcrBox] = []

        # 新版 PaddleOCR (>=2.8) 返回 OCRResult 对象
        if raw and raw[0]:
            result = raw[0]

            # 检查是否是新版 OCRResult 对象（类字典）
            if hasattr(result, 'get') and 'rec_texts' in result:
                # 新版格式：OCRResult 对象
                texts = result.get('rec_texts', [])
                scores = result.get('rec_scores', [])
                polys = result.get('rec_polys', result.get('dt_polys', []))

                for i, text in enumerate(texts):
                    if text and text.strip():
                        conf = scores[i] if i < len(scores) else 0.0
                        bbox = polys[i].tolist() if i < len(polys) else []
                        boxes.append(
                            OcrBox(
                                text=text,
                                confidence=float(conf),
                                bbox=bbox,
                            )
                        )
            else:
                # 旧版格式：List[List[[bbox, (text, conf)], ...]]
                for line in result:
                    bbox_raw, (text, conf) = line
                    if text.strip():
                        boxes.append(
                            OcrBox(
                                text=text,
                                confidence=float(conf),
                                bbox=bbox_raw,
                            )
                        )

        return OcrOutput(boxes=boxes, language=self._lang)

    # ── 内部方法 ──────────────────────────────────────────────────────────────

    def _ensure_loaded(self) -> None:
        """首次调用时初始化 PaddleOCR 模型（线程不安全，Sidecar 应单线程初始化）"""
        if self._ocr is not None:
            return

        with self._ocr_lock:
            if self._ocr is not None:
                return
            try:
                from paddleocr import PaddleOCR
                # 新版 PaddleOCR (>=2.8) 使用 use_textline_orientation 替代 use_angle_cls
                self._ocr = PaddleOCR(
                    use_textline_orientation=True,
                    lang=self._lang,
                )
                logger.info(
                    "PaddleOCR 模型加载完成（lang=%s）",
                    self._lang,
                )
            except ImportError as e:
                raise RuntimeError(
                    "paddleocr 未安装，请运行: pip install paddlepaddle paddleocr"
                ) from e
