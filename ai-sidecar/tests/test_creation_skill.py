from creation.service import CreationService


def test_creation_skill_fallback_extracts_markdown_structure():
    result = CreationService._fallback_creation_skill_analysis(
        "数据平台技术架构设计",
        "# 背景与目标\n内容说明。\n## 总体架构\n架构说明。\n## 实施计划\n计划说明。",
        "技术架构设计文档",
    )

    assert result["title"] == "技术架构设计文档"
    assert result["structure_pattern"] == ["背景与目标", "总体方案", "实施计划"]
    assert result["common_titles"]
    assert result["diagram_style"]
    assert result["section_headings"]["common_titles"] == "这类文档标题通常怎么命名"
    assert all(result["field_examples"].values())
    assert "数据平台" not in result["example_document"]


def test_creation_skill_normalizer_fills_missing_model_fields():
    result = CreationService._normalize_creation_skill_analysis(
        {"title": "架构写作 Skill", "common_titles": ["A", "B"]},
        "原始架构文档",
        "# 背景\n正文内容足够长，用于测试缺失字段回退。",
        "架构设计文档",
    )

    assert result["title"] == "架构设计文档"
    assert result["common_titles"] == ["A", "B"]
    assert result["text_style"]
    assert result["structure_pattern"] == ["背景与目标"]
    assert result["example_document"]


def test_creation_skill_payload_puts_json_in_response_instead_of_thinking():
    payload = CreationService._creation_skill_analysis_payload("local-model", "prompt")

    assert payload["format"] == "json"
    assert payload["stream"] is False
    assert payload["think"] is False


def test_creation_skill_title_abstracts_specific_departments_and_meeting_guide_suffix():
    result = CreationService._normalize_creation_skill_analysis(
        {
            "title": "商业化研发中心与电商产品部跨部门技术沟通会纪要撰写指南",
            "summary": "适用于多团队技术协作。",
        },
        "商业化研发中心与电商产品部跨部门技术沟通会纪要",
        "# 会议目标\n对齐系统架构和跨团队依赖。\n## 行动项\n明确后续安排。",
        "会议纪要",
    )

    assert result["title"] == "跨部门技术沟通会文档"
    assert "研发中心" not in result["title"]
    assert "产品部" not in result["title"]
    assert "研发中心" not in str(result)
    assert "产品部" not in str(result)


def test_creation_skill_normalizer_replaces_source_copies_and_private_examples():
    source_sentence = "星火项目组需要在三季度完成订单中台迁移并达到既定指标。"
    result = CreationService._normalize_creation_skill_analysis(
        {
            "title": "通用实施方案",
            "summary": source_sentence,
            "common_titles": ["星火项目组迁移方案"],
            "example_document": f"# 示例\n\n{source_sentence}\n\n## 计划\n\n沿用原有安排。",
        },
        "星火项目组三季度迁移方案",
        f"# 背景\n{source_sentence}\n## 计划\n分阶段执行并复核。",
        "实施方案",
    )

    serialized = str(result)
    assert "星火项目组" not in serialized
    assert source_sentence not in serialized
    assert result["field_examples"]["text_style"]
    assert len(result["example_document"]) > 100
