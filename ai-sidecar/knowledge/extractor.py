"""
时间线提炼模块（旧版） - 使用 Qwen3.5-4B 从 OCR 文本中提取结构化知识
"""

import json
import logging
import re
from typing import Optional, Dict, Any
from datetime import datetime

try:
    from ollama import Client
    OLLAMA_AVAILABLE = True
except ImportError:
    OLLAMA_AVAILABLE = False
    logger = logging.getLogger(__name__)
    logger.warning("Ollama 未安装，将使用基于规则的简单提炼器")

logger = logging.getLogger(__name__)


SYSTEM_PROMPT = """你是一个专业的工作记录提炼助手。你的任务是从 OCR 识别的屏幕文本中提取有价值的工作信息。

**提炼规则**：
1. 忽略 UI 元素（按钮、菜单、状态栏等）
2. 提取核心工作内容（会议记录、文档内容、代码片段、聊天记录等）
3. 生成简洁的摘要（50-200 字）
4. 识别关键实体（人名、项目名、时间、地点）
5. 如果内容无价值（纯 UI、重复内容），返回 "SKIP"

**输出格式**（JSON）：
{
  "summary": "简洁摘要",
  "entities": ["实体1", "实体2"],
  "category": "会议|文档|代码|聊天|其他",
  "importance": 1-5
}"""


MENU_NOISE_PATTERNS = (
    re.compile(r'^(file|edit|selection|view|go|run|terminal|window|help)(\s+\w+){0,10}$', re.IGNORECASE),
    re.compile(r'^(welcome|explorer|extensions?)$', re.IGNORECASE),
    re.compile(r'^[\d\s]{4,}$'),
    re.compile(r'^[=+\-_*~•·。，、…<>|/\\]{3,}$'),
)

MENU_NOISE_KEYWORDS = {
    'file', 'edit', 'selection', 'view', 'go', 'run', 'terminal', 'window', 'help',
    'welcome', 'explorer', 'taskoutput tool output', 'bash tool output',
}

ACTION_HINTS = (
    ('修复', '修复问题'),
    ('排查', '排查异常'),
    ('提炼', '执行时间线提炼'),
    ('启动', '启动服务'),
    ('重启', '重启服务'),
    ('日志', '查看日志'),
    ('sql', '查询数据库'),
    ('api', '调用接口验证'),
    ('test', '执行测试验证'),
    ('ocr', '处理 OCR 识别结果'),
)

RESULT_HINTS = (
    ('成功', '并得到成功结果'),
    ('完成', '并完成关键操作'),
    ('超时', '但出现超时需继续优化'),
    ('失败', '但遇到失败需继续排查'),
    ('error', '并出现错误需继续排查'),
)


def _normalize_text(text: str) -> str:
    return re.sub(r'\s+', ' ', str(text or '').replace('\r', ' ').replace('\n', ' ')).strip()


def _sanitize_ocr_text(raw_text: str) -> str:
    lines = str(raw_text or '').replace('\r', '\n').split('\n')
    cleaned = []
    for line in lines:
        normalized = _normalize_text(line)
        if not normalized:
            continue
        lowered = normalized.lower()
        if any(pattern.match(normalized) for pattern in MENU_NOISE_PATTERNS):
            continue
        if lowered in MENU_NOISE_KEYWORDS:
            continue
        cleaned.append(normalized)
    if cleaned:
        return '\n'.join(cleaned)
    return _normalize_text(raw_text)


def _is_noise_dominant(text: str) -> bool:
    compact = _normalize_text(text).lower()
    if not compact:
        return True
    words = re.findall(r'[a-zA-Z]+|\d+', compact)
    if len(words) < 8:
        return False
    noisy_terms = sum(1 for word in words if word.isdigit() or word in MENU_NOISE_KEYWORDS)
    return (noisy_terms / len(words)) >= 0.35


def _build_work_summary(app_name: str, window_title: str, text: str) -> Optional[str]:
    compact = _normalize_text(text)
    if not compact:
        return None

    lower_text = compact.lower()
    actions = [label for keyword, label in ACTION_HINTS if keyword in lower_text]
    unique_actions = list(dict.fromkeys(actions))
    action_text = '、'.join(unique_actions[:2]) if unique_actions else ''
    result_text = ''
    for keyword, label in RESULT_HINTS:
        if keyword in lower_text:
            result_text = label
            break

    scene = window_title or app_name or '当前应用'
    if action_text:
        summary = f"在{scene}中{action_text}{result_text}"
    else:
        # 没有动作词时，只保留有信息密度的前段文本作为概述
        summary = compact[:72].rstrip()

    if len(summary) > 120:
        summary = summary[:120].rstrip() + '…'
    return summary


def simple_extract(capture_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    基于规则的简单时间线提炼（当 Ollama 不可用时使用）

    Args:
        capture_data: 采集数据

    Returns:
        提炼后的知识，如果无价值则返回 None
    """
    raw_text = capture_data.get('ocr_text') or capture_data.get('ax_text') or ''
    ocr_text = _sanitize_ocr_text(raw_text)
    app_name = capture_data.get('app_name', '')
    window_title = capture_data.get('window_title', '')

    if not ocr_text or len(_normalize_text(ocr_text)) < 24:
        return None

    if _is_noise_dominant(ocr_text):
        return None

    summary = _build_work_summary(app_name, window_title, ocr_text)
    if not summary:
        return None

    entities = []
    english_entities = re.findall(r'\b[A-Z][a-zA-Z]{2,}\b', ocr_text)
    entities.extend(english_entities[:5])
    if app_name:
        entities.append(app_name)
    if window_title and window_title != app_name:
        entities.append(window_title)
    entities = list(dict.fromkeys(entities))[:10]

    category = '其他'
    app_lower = app_name.lower()
    if any(kw in app_lower for kw in ['code', 'vscode', 'pycharm', 'idea']):
        category = '代码'
    elif any(kw in app_lower for kw in ['chrome', 'safari', 'firefox', 'edge']):
        category = '浏览器'
    elif any(kw in app_lower for kw in ['word', 'pages', 'notion', 'typora']):
        category = '文档'
    elif any(kw in app_lower for kw in ['wechat', 'slack', 'feishu', 'dingtalk']):
        category = '聊天'
    elif any(kw in app_lower for kw in ['zoom', 'teams', 'meet']):
        category = '会议'

    importance = 3
    if any(kw in _normalize_text(ocr_text).lower() for kw in ['决策', '上线', '发布', '修复', '回归', '故障', '超时']):
        importance = 4
    if len(_normalize_text(ocr_text)) > 900:
        importance = max(importance, 4)

    return {
        'capture_id': capture_data['id'],
        'summary': summary,
        'entities': json.dumps(entities, ensure_ascii=False),
        'category': category,
        'importance': importance,
    }



class KnowledgeExtractor:
    """时间线提炼器（旧版）"""

    def __init__(self, model: str = "qwen3.5:4b"):
        """
        初始化时间线提炼器

        Args:
            model: Ollama 模型名称
        """
        self.model = model
        self.use_ollama = OLLAMA_AVAILABLE

        if OLLAMA_AVAILABLE:
            try:
                self.client = Client()
                logger.info(f"初始化时间线提炼器，模型: {model}")
            except Exception as e:
                logger.warning(f"Ollama 客户端初始化失败: {e}，将使用简单提炼器")
                self.use_ollama = False
        else:
            logger.info("使用基于规则的简单时间线提炼器")
            self.use_ollama = False

    def _build_prompt(self, capture_data: Dict[str, Any]) -> str:
        """构建提炼 prompt"""
        app_name = capture_data.get('app_name', '未知应用')
        window_title = capture_data.get('window_title', '未知窗口')
        timestamp = capture_data.get('timestamp', datetime.now().isoformat())
        ocr_text = capture_data.get('ocr_text', '')

        # 限制文本长度，避免超过上下文
        if len(ocr_text) > 2000:
            ocr_text = ocr_text[:2000] + "..."

        prompt = f"""**应用名称**：{app_name}
**窗口标题**：{window_title}
**时间戳**：{timestamp}
**OCR 文本**：
{ocr_text}

请提炼上述内容。"""

        return prompt

    async def extract(self, capture_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        从采集数据中提炼知识

        Args:
            capture_data: 采集数据字典，包含 id, app_name, window_title, ocr_text 等

        Returns:
            提炼后的知识字典，如果无价值则返回 None
        """
        # 如果 Ollama 不可用，使用简单提炼器
        if not self.use_ollama:
            logger.info(f"使用简单提炼器处理采集记录 {capture_data.get('id')}")
            result = simple_extract(capture_data)
            if result:
                logger.info(f"成功提炼采集记录 {capture_data.get('id')}: {result['summary'][:50]}...")
            else:
                logger.info(f"采集记录 {capture_data.get('id')} 无价值，跳过")
            return result

        try:
            # 1. 构建 prompt
            prompt = self._build_prompt(capture_data)

            # 2. 调用本地 LLM
            logger.info(f"开始提炼采集记录 {capture_data.get('id')}")
            response = self.client.chat(
                model=self.model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt}
                ],
                format="json",  # 强制 JSON 输出
                options={
                    "temperature": 0.3,  # 降低随机性
                    "num_predict": 256,  # 限制输出长度
                }
            )

            # 3. 解析结果
            msg = response['message']
            content = msg.get('content', '')
            # Qwen3.5 等推理模型可能将内容放在 thinking 字段
            if not content:
                content = msg.get('thinking', '')
            result = json.loads(content)

            # 4. 跳过无价值内容
            if result.get('summary') == 'SKIP' or not result.get('summary'):
                logger.info(f"采集记录 {capture_data.get('id')} 无价值，跳过")
                return None

            # 5. 返回结构化知识
            knowledge = {
                'capture_id': capture_data['id'],
                'summary': result['summary'],
                'entities': json.dumps(result.get('entities', []), ensure_ascii=False),
                'category': result.get('category', '其他'),
                'importance': result.get('importance', 3),
            }

            logger.info(f"成功提炼采集记录 {capture_data.get('id')}: {knowledge['summary'][:50]}...")
            return knowledge

        except json.JSONDecodeError as e:
            logger.error(f"JSON 解析失败: {e}, 响应内容: {content}")
            return None
        except Exception as e:
            logger.error(f"时间线提炼失败: {e}")
            return None

    def extract_sync(self, capture_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """同步版本的提炼方法（用于非异步环境）"""
        # 如果 Ollama 不可用，使用简单提炼器
        if not self.use_ollama:
            logger.info(f"使用简单提炼器处理采集记录 {capture_data.get('id')}")
            result = simple_extract(capture_data)
            if result:
                logger.info(f"成功提炼采集记录 {capture_data.get('id')}: {result['summary'][:50]}...")
            else:
                logger.info(f"采集记录 {capture_data.get('id')} 无价值，跳过")
            return result

        try:
            # 1. 构建 prompt
            prompt = self._build_prompt(capture_data)

            # 2. 调用本地 LLM
            logger.info(f"开始提炼采集记录 {capture_data.get('id')}")
            response = self.client.chat(
                model=self.model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt}
                ],
                format="json",
                options={
                    "temperature": 0.3,
                    "num_predict": 256,
                }
            )

            # 3. 解析结果
            msg = response['message']
            content = msg.get('content', '')
            # Qwen3.5 等推理模型可能将内容放在 thinking 字段
            if not content:
                content = msg.get('thinking', '')
            result = json.loads(content)

            # 4. 跳过无价值内容
            if result.get('summary') == 'SKIP' or not result.get('summary'):
                logger.info(f"采集记录 {capture_data.get('id')} 无价值，跳过")
                return None

            # 5. 返回结构化知识
            knowledge = {
                'capture_id': capture_data['id'],
                'summary': result['summary'],
                'entities': json.dumps(result.get('entities', []), ensure_ascii=False),
                'category': result.get('category', '其他'),
                'importance': result.get('importance', 3),
            }

            logger.info(f"成功提炼采集记录 {capture_data.get('id')}: {knowledge['summary'][:50]}...")
            return knowledge

        except json.JSONDecodeError as e:
            logger.error(f"JSON 解析失败: {e}")
            return None
        except Exception as e:
            logger.error(f"时间线提炼失败: {e}")
            return None


# 测试代码
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    # 测试数据
    test_capture = {
        'id': 1,
        'app_name': '飞书',
        'window_title': '产品评审会',
        'timestamp': '2026-03-07 10:30:00',
        'ocr_text': '''
        【飞书会议】产品评审会
        时间：2026-03-07 14:00
        参与人：张三、李四、王五

        讨论内容：
        1. Q1 产品路线图确认
        2. AI 功能优先级排序
        3. 下周开始开发

        决策：优先实现 OCR 采集功能
        '''
    }

    extractor = KnowledgeExtractor()
    result = extractor.extract_sync(test_capture)

    if result:
        print("提炼结果：")
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print("无价值内容，已跳过")
