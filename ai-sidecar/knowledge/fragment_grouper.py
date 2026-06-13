"""
工作片段分组器

将连续的 captures 按语义相似度分组为工作片段。
核心原则：不依赖应用/窗口切换判断任务边界，而是用内容语义判断。
"""

import re
import logging
import numpy as np
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# 文档类 URL 识别：用于"一份文档独占一个 timeline"的边界判断。
_DOC_URL_MARKERS = (
    'docs.corp', '/docs/', 'docs.google', '/document/', 'yuque.com',
    'feishu.cn/docx', 'feishu.cn/wiki', 'notion.so', 'confluence',
    '/wiki/', 'shimo.im', '/d/home/', '/s/home/',
)


def _is_document_url(url: Optional[str]) -> bool:
    """URL 是否指向一份文档。"""
    if not url:
        return False
    u = url.strip().lower()
    if not u:
        return False
    return any(marker in u for marker in _DOC_URL_MARKERS)


def _document_identity(url: Optional[str]) -> Optional[str]:
    """从文档 URL 提取稳定的文档标识，用于区分"是否同一份文档"。

    多数企业文档形如 https://docs.corp.x.com/d/home/<docId>，docId 段唯一标识一份文档。
    取 path 最后一个非空段作为标识；无法解析时回退到去掉 query/fragment 的完整 path。
    """
    if not _is_document_url(url):
        return None
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return None
    path = (parsed.path or '').rstrip('/')
    if not path:
        return (parsed.netloc or url).lower()
    last_segment = path.rsplit('/', 1)[-1]
    # docId 通常是较长的标识串；过短的段（如 home/d）回退到完整 path 以免误并不同文档。
    if len(last_segment) >= 6:
        return f"{parsed.netloc.lower()}::{last_segment}"
    return f"{parsed.netloc.lower()}::{path.lower()}"



_HISTORY_APP_KEYWORDS = (
    'wechat', 'wecom', 'feishu', 'slack', 'teams', 'discord',
    'telegram', 'imessage', 'messages', 'gemini', 'claude', 'chatgpt',
)

_HISTORY_TEXT_PATTERNS = (
    '昨天', '前天', '历史消息', '历史记录', '聊天记录', '更早', '回看', '回顾',
    '历史对话', '上一轮', '上周', '上个月', '昨天的', '前天的', 'earlier', 'history',
    'previous', 'yesterday', 'last week', 'last month',
)

# 同一工作流中常见的应用组合（来回切换不算任务切换）
RELATED_APP_GROUPS = [
    {'Code', 'Cursor', 'VSCode', 'Visual Studio Code', 'Xcode', 'Terminal', 'iTerm2', 'iTerm'},
    {'Slack', 'DingTalk', 'Feishu', 'WeCom', 'Teams', 'Discord'},
    {'Chrome', 'Safari', 'Firefox', 'Arc', 'Edge'},
    {'Word', 'Pages', 'Notion', 'Obsidian', 'Typora', 'Bear'},
    {'Excel', 'Numbers', 'Google Sheets'},
    {'Figma', 'Sketch', 'Adobe XD'},
]

# 中文停用词
STOP_WORDS = {
    '的', '了', '是', '在', '和', '有', '我', '你', '他', '她', '它',
    '们', '这', '那', '就', '都', '也', '还', '但', '而', '或', '与',
    '对', '从', '到', '以', '为', '被', '把', '让', '使', '将', '已',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in',
    'on', 'at', 'by', 'for', 'with', 'as', 'be', 'been', 'being',
}


class FragmentGrouper:
    """
    将连续的 captures 分组为工作片段。

    分组策略（优先级从高到低）：
    1. 时间间隔 > HARD_SPLIT_MINUTES → 强制切断
    2. 语义相似度 >= SAME_TASK_THRESHOLD → 合并
    3. 语义相似度 < DIFF_TASK_THRESHOLD → 切断
    4. 模糊区域 → 用应用回归 + 关键词重叠辅助判断
    """

    HARD_SPLIT_MINUTES = 30     # 超过此时间强制切断
    SOFT_SPLIT_MINUTES = 10     # 超过此时间，要求更高相似度
    SAME_TASK_THRESHOLD = 0.65  # 高于此值：同一件事
    DIFF_TASK_THRESHOLD = 0.40  # 低于此值：不同的事
    SAME_TASK_THRESHOLD_SOFT = 0.72  # 间隔较长时的更高阈值
    MIN_GROUP_WAIT = 3          # 至少积累3条才开始处理，避免切断进行中的任务

    def __init__(self, embedding_model=None):
        self.embedding_model = embedding_model

    def group_captures(self, captures: list[dict]) -> list[list[dict]]:
        """
        输入：按时间升序排列的 captures 列表
        输出：分组后的片段列表，每个片段是一组 captures

        注意：最后一组可能是进行中的任务，调用方应自行决定是否处理。
        """
        if not captures:
            return []

        if len(captures) == 1:
            return [captures]

        # 批量向量化（有 embedding_model 时）
        vectors = self._batch_encode(captures)

        groups: list[list[dict]] = []
        current_group: list[dict] = [captures[0]]
        current_vectors: list = [vectors[0]] if vectors else []

        for i in range(1, len(captures)):
            curr = captures[i]
            prev = captures[i - 1]
            gap_minutes = (curr['ts'] - prev['ts']) / 60000

            # 规则1：强制切断
            if gap_minutes > self.HARD_SPLIT_MINUTES:
                groups.append(current_group)
                current_group = [curr]
                current_vectors = [vectors[i]] if vectors else []
                continue

            # 规则1.5：文档边界 —— 一份文档独占一个片段。
            # 当前组的"主文档"由组内首个文档型 capture 确定；
            # 新 capture 指向不同文档，或在文档组里出现非文档内容时，强制切断。
            doc_split = self._document_boundary_split(current_group, curr)
            if doc_split:
                groups.append(current_group)
                current_group = [curr]
                current_vectors = [vectors[i]] if vectors else []
                continue

            # 规则2/3/4：语义判断
            if vectors:
                should_merge = self._semantic_judge(
                    curr_vector=vectors[i],
                    group_vectors=current_vectors,
                    gap_minutes=gap_minutes,
                    current_group=current_group,
                    curr_capture=curr,
                )
                # 夹心检测：curr 与主题相似度不高，但下一条会回归主题 → curr 是短暂插入，强制切断
                if should_merge and i + 1 < len(captures):
                    theme_vec = self._compute_theme_vector(current_vectors)
                    curr_sim = self._cosine_similarity(vectors[i], theme_vec)
                    if curr_sim < self.SAME_TASK_THRESHOLD:
                        next_sim = self._cosine_similarity(vectors[i + 1], theme_vec)
                        next_gap = (captures[i + 1]['ts'] - curr['ts']) / 60000
                        if next_sim >= self.SAME_TASK_THRESHOLD and next_gap < self.SOFT_SPLIT_MINUTES:
                            should_merge = False
            else:
                # 无向量模型时，退化为关键词判断
                should_merge = self._keyword_judge(current_group, curr)

            if should_merge:
                current_group.append(curr)
                if vectors:
                    current_vectors.append(vectors[i])
            else:
                groups.append(current_group)
                current_group = [curr]
                current_vectors = [vectors[i]] if vectors else []

        if current_group:
            groups.append(current_group)

        logger.info(f"分组完成: {len(captures)} 条 captures → {len(groups)} 个片段")
        return groups

    # ─────────────────────────────────────────────────────────────────────────
    # 内部方法
    # ─────────────────────────────────────────────────────────────────────────

    def _group_primary_document(self, group: list[dict]) -> Optional[str]:
        """当前组的主文档标识：组内第一个文档型 capture 决定。无则 None。"""
        for cap in group:
            ident = _document_identity(cap.get('url'))
            if ident:
                return ident
        return None

    def _document_boundary_split(self, current_group: list[dict], curr: dict) -> bool:
        """判断是否因文档边界而强制切片。

        规则（"一份文档独占一个片段，且片段聚焦同一份文档"）：
        - 组已有主文档 A（文档组）：严格排他，只接纳 A 自己的后续浏览。
            * curr 是文档 A → 不切（继续浏览同一文档）
            * curr 是其它文档 B → 切（B 另起一组）
            * curr 非文档型 → 切（IM/编码等杂项不并入文档组，避免污染）
        - 组无主文档（操作/IM/编码组）：
            * curr 是文档型 → 切（让文档干净地独占新组）
            * curr 非文档型 → 不切（留给语义判断）
        """
        curr_doc = _document_identity(curr.get('url'))
        primary_doc = self._group_primary_document(current_group)

        if primary_doc is not None:
            if curr_doc == primary_doc:
                return False
            if curr_doc is not None and curr_doc != primary_doc:
                return True
            # curr 非文档型：文档组一旦确立即严格排他，
            # 不让 IM/编码等杂项靠应用回归吸附进来污染文档 timeline。
            return True
        else:
            if curr_doc is not None:
                return True
            return False

    def _batch_encode(self, captures: list[dict]) -> Optional[list]:
        """批量向量化所有 captures"""
        if not self.embedding_model:
            return None
        try:
            texts = [self._get_semantic_text(c) for c in captures]
            embeddings = self.embedding_model.encode(texts)
            return [np.array(e.vector) for e in embeddings]
        except Exception as ex:
            logger.warning(f"向量化失败，退化为关键词判断: {ex}")
            return None

    def _get_semantic_text(self, capture: dict) -> str:
        """提取用于语义判断的文本，过滤短行噪声"""
        text = capture.get('ax_text') or capture.get('ocr_text') or ''
        lines = [l.strip() for l in text.split('\n') if len(l.strip()) > 10]
        return ' '.join(lines)[:512]

    def _compute_theme_vector(self, vectors: list) -> np.ndarray:
        """
        计算当前片段的"主题向量"。
        最近3条 capture 权重更高，反映当前任务焦点。
        """
        if len(vectors) == 1:
            return vectors[0]

        n = len(vectors)
        weights = np.ones(n) * 0.5
        # 最近3条加权
        for j, idx in enumerate(range(max(0, n - 3), n)):
            weights[idx] = [0.3, 0.35, 0.4][j] if n >= 3 else 0.5
        weights = weights / weights.sum()

        stacked = np.stack(vectors, axis=0)
        theme = np.average(stacked, axis=0, weights=weights)
        norm = np.linalg.norm(theme)
        return theme / norm if norm > 0 else theme

    def _cosine_similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        norm_a = np.linalg.norm(a)
        norm_b = np.linalg.norm(b)
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return float(np.dot(a, b) / (norm_a * norm_b))

    def _semantic_judge(
        self,
        curr_vector: np.ndarray,
        group_vectors: list,
        gap_minutes: float,
        current_group: list[dict],
        curr_capture: dict,
    ) -> bool:
        """基于语义相似度判断是否合并"""
        theme_vector = self._compute_theme_vector(group_vectors)
        similarity = self._cosine_similarity(curr_vector, theme_vector)

        # 间隔较长时要求更高相似度
        threshold = (
            self.SAME_TASK_THRESHOLD_SOFT
            if gap_minutes > self.SOFT_SPLIT_MINUTES
            else self.SAME_TASK_THRESHOLD
        )

        if similarity >= threshold:
            return True
        elif similarity < self.DIFF_TASK_THRESHOLD:
            return False
        else:
            # 模糊区域：用上下文辅助判断
            return self._check_context_continuity(current_group, curr_capture)

    def _looks_like_history_review(self, capture: dict) -> bool:
        app_name = (capture.get('app_name') or '').lower()
        title = (capture.get('window_title') or '').lower()
        text = ((capture.get('ax_text') or '') + '\n' + (capture.get('ocr_text') or '')).lower()
        if not any(keyword in app_name or keyword in title for keyword in _HISTORY_APP_KEYWORDS):
            return False
        return any(pattern in text or pattern in title for pattern in _HISTORY_TEXT_PATTERNS)

    def _history_mode_changed(self, current_group: list[dict], new_capture: dict) -> bool:
        if not current_group:
            return False
        prev = current_group[-1]
        return self._looks_like_history_review(prev) != self._looks_like_history_review(new_capture)

    def _check_context_continuity(
        self,
        current_group: list[dict],
        new_capture: dict,
    ) -> bool:
        """
        模糊区域辅助判断：
        1. 应用回归：新 capture 的 app 在当前片段中出现过（来回切换场景）
        2. 关键词重叠：新 capture 与片段近期内容有2个以上关键词重叠
        """
        # 历史回看与实时互动切换时强制切片，避免时间语义混片
        if self._history_mode_changed(current_group, new_capture):
            return False

        # 1. 应用回归
        group_apps = {c.get('app_name') for c in current_group if c.get('app_name')}
        if new_capture.get('app_name') in group_apps:
            return True

        # 2. 关键词重叠（只看最近5条，避免早期内容干扰）
        recent_text = ' '.join(
            c.get('ax_text') or c.get('ocr_text') or ''
            for c in current_group[-5:]
        )
        new_text = new_capture.get('ax_text') or new_capture.get('ocr_text') or ''

        group_kw = self._extract_keywords(recent_text)
        new_kw = self._extract_keywords(new_text)

        if len(group_kw & new_kw) >= 2:
            return True

        return False

    def _keyword_judge(self, current_group: list[dict], new_capture: dict) -> bool:
        """无向量模型时的退化判断（仅关键词 + 应用回归）"""
        return self._check_context_continuity(current_group, new_capture)

    def _extract_keywords(self, text: str) -> set:
        """提取关键词：中文2字以上词组 + 英文3字以上单词，过滤停用词"""
        words = re.findall(r'[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}', text)
        return {w for w in words if w.lower() not in STOP_WORDS}
