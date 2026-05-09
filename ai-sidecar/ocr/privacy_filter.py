"""
敏感内容过滤模块

提供三种过滤能力：
1. 敏感聊天内容过滤 (chat)
2. 敏感个人信息过滤 (pii)
3. 敏感政策信息过滤 (policy)
"""

import re
from typing import List, Tuple, Optional
from dataclasses import dataclass


@dataclass
class FilterResult:
    """过滤结果"""
    sanitized_text: str
    detected_types: List[str]
    is_sensitive: bool


class PrivacyFilter:
    """敏感内容过滤器"""

    def __init__(self, config: Optional[dict] = None):
        self.config = config or self._default_config()

    def _default_config(self) -> dict:
        """默认配置"""
        return {
            'chat': {
                'enabled': True,
                'keywords': ['密码', '验证码', '身份证', '银行卡', '支付宝', '微信支付'],
                'patterns': [r'密码[:：]\s*.+', r'验证码[:：]\s*\d+', r'账号[:：]\s*.+']
            },
            'pii': {
                'enabled': True,
                'patterns': {
                    'id_card': r'\d{17}[0-9Xx]',
                    'bank_card': r'\d{16,19}',
                    'phone': r'1[3-9]\d{9}',
                    'email': r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
                }
            },
            'policy': {
                'enabled': True,
                'keywords': ['涉密', '机密', '内部文件', '保密协议'],
                'context_window': 50
            }
        }

    def detect_and_redact(self, text: str, ocr_boxes: Optional[List] = None) -> FilterResult:
        """检测并标记敏感内容"""
        detected_types = []
        sanitized_text = text

        if self.config['chat']['enabled']:
            chat_matches = self._detect_chat_content(text)
            if chat_matches:
                detected_types.append('chat')
                sanitized_text = self._redact_matches(sanitized_text, chat_matches)

        if self.config['pii']['enabled']:
            pii_matches = self._detect_pii(text)
            if pii_matches:
                detected_types.append('pii')
                sanitized_text = self._redact_matches(sanitized_text, pii_matches)

        if self.config['policy']['enabled']:
            policy_matches = self._detect_policy_content(text)
            if policy_matches:
                detected_types.append('policy')
                sanitized_text = self._redact_matches(sanitized_text, policy_matches)

        return FilterResult(
            sanitized_text=sanitized_text,
            detected_types=detected_types,
            is_sensitive=len(detected_types) > 0
        )

    def _detect_chat_content(self, text: str) -> List[Tuple[int, int]]:
        """检测敏感聊天内容"""
        matches = []
        for keyword in self.config['chat']['keywords']:
            for match in re.finditer(re.escape(keyword), text):
                matches.append((match.start(), match.end()))
        for pattern in self.config['chat']['patterns']:
            for match in re.finditer(pattern, text):
                matches.append((match.start(), match.end()))
        return self._merge_overlapping_matches(matches)

    def _detect_pii(self, text: str) -> List[Tuple[int, int]]:
        """检测敏感个人信息"""
        matches = []
        for entity_type, pattern in self.config['pii']['patterns'].items():
            for match in re.finditer(pattern, text):
                if entity_type == 'id_card' and not self._validate_id_card(match.group()):
                    continue
                if entity_type == 'bank_card' and not self._validate_luhn(match.group()):
                    continue
                matches.append((match.start(), match.end()))
        return self._merge_overlapping_matches(matches)

    def _detect_policy_content(self, text: str) -> List[Tuple[int, int]]:
        """检测敏感政策信息"""
        matches = []
        context_window = self.config['policy']['context_window']
        for keyword in self.config['policy']['keywords']:
            for match in re.finditer(re.escape(keyword), text):
                start = max(0, match.start() - context_window)
                end = min(len(text), match.end() + context_window)
                matches.append((start, end))
        return self._merge_overlapping_matches(matches)

    def _validate_id_card(self, id_card: str) -> bool:
        """验证身份证号校验位"""
        if len(id_card) != 18:
            return False
        weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
        check_codes = '10X98765432'
        try:
            sum_val = sum(int(id_card[i]) * weights[i] for i in range(17))
            return id_card[-1].upper() == check_codes[sum_val % 11]
        except (ValueError, IndexError):
            return False

    def _validate_luhn(self, card_number: str) -> bool:
        """Luhn 算法验证银行卡号"""
        try:
            digits = [int(d) for d in card_number]
            checksum = 0
            for i, digit in enumerate(reversed(digits)):
                if i % 2 == 1:
                    digit *= 2
                    if digit > 9:
                        digit -= 9
                checksum += digit
            return checksum % 10 == 0
        except ValueError:
            return False

    def _merge_overlapping_matches(self, matches: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
        """合并重叠的匹配区间"""
        if not matches:
            return []
        sorted_matches = sorted(matches, key=lambda x: x[0])
        merged = [sorted_matches[0]]
        for current in sorted_matches[1:]:
            last = merged[-1]
            if current[0] <= last[1]:
                merged[-1] = (last[0], max(last[1], current[1]))
            else:
                merged.append(current)
        return merged

    def _redact_matches(self, text: str, matches: List[Tuple[int, int]]) -> str:
        """将匹配的文本替换为 [已过滤]"""
        if not matches:
            return text
        result = []
        last_end = 0
        for start, end in sorted(matches, key=lambda x: x[0]):
            result.append(text[last_end:start])
            result.append('[已过滤]')
            last_end = end
        result.append(text[last_end:])
        return ''.join(result)
