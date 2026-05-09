#!/usr/bin/env python3
"""
隐私保护模块测试脚本

测试：
1. 敏感聊天内容过滤
2. 敏感个人信息过滤（身份证、银行卡、手机号）
3. 敏感政策信息过滤
"""

import sys
sys.path.insert(0, '/Users/xianjiaqi/Documents/mygit/cy/gzdz/ai-sidecar')

from ocr.privacy_filter import PrivacyFilter


def test_chat_filter():
    """测试聊天内容过滤"""
    print("=== 测试聊天内容过滤 ===")
    filter = PrivacyFilter()

    test_cases = [
        "请输入密码: abc123",
        "验证码: 123456",
        "我的支付宝账号是 xxx",
    ]

    for text in test_cases:
        result = filter.detect_and_redact(text)
        print(f"原文: {text}")
        print(f"过滤后: {result.sanitized_text}")
        print(f"检测类型: {result.detected_types}")
        print()


def test_pii_filter():
    """测试个人信息过滤"""
    print("=== 测试个人信息过滤 ===")
    filter = PrivacyFilter()

    test_cases = [
        "我的手机号是 13812345678",
        "身份证号: 110101199001011234",  # 假身份证
        "银行卡号: 6222021234567890123",  # 假银行卡
        "邮箱: test@example.com",
    ]

    for text in test_cases:
        result = filter.detect_and_redact(text)
        print(f"原文: {text}")
        print(f"过滤后: {result.sanitized_text}")
        print(f"检测类型: {result.detected_types}")
        print()


def test_policy_filter():
    """测试政策信息过滤"""
    print("=== 测试政策信息过滤 ===")
    filter = PrivacyFilter()

    test_cases = [
        "这是一份涉密文件，请勿外传",
        "根据保密协议，此内容不得公开",
    ]

    for text in test_cases:
        result = filter.detect_and_redact(text)
        print(f"原文: {text}")
        print(f"过滤后: {result.sanitized_text}")
        print(f"检测类型: {result.detected_types}")
        print()


def test_mixed_content():
    """测试混合敏感内容"""
    print("=== 测试混合敏感内容 ===")
    filter = PrivacyFilter()

    text = """
    用户信息：
    姓名：张三
    手机：13812345678
    密码：abc123
    这是一份涉密文件
    """

    result = filter.detect_and_redact(text)
    print(f"原文:\n{text}")
    print(f"过滤后:\n{result.sanitized_text}")
    print(f"检测类型: {result.detected_types}")
    print(f"是否敏感: {result.is_sensitive}")


if __name__ == '__main__':
    test_chat_filter()
    test_pii_filter()
    test_policy_filter()
    test_mixed_content()
    print("\n✅ 所有测试完成")
