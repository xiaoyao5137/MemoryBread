use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    api::{error::ApiError, state::AppState},
    storage::repo::creation_skill::{
        CreationSkillFieldExamples, CreationSkillRecord, CreationSkillSectionHeadings,
        UpsertCreationSkill,
    },
};

#[derive(Debug, Deserialize)]
pub struct AnalyzeCreationSkillRequest {
    pub source_kind: String,
    pub source_id: String,
    pub document_title: String,
    pub document_content: String,
    #[serde(default)]
    pub doc_type: String,
}

#[derive(Debug, Serialize)]
struct AnalyzeCreationSkillPayload<'a> {
    document_title: &'a str,
    document_content: &'a str,
    doc_type: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreationSkillAnalysis {
    pub title: String,
    pub summary: String,
    pub common_titles: Vec<String>,
    pub title_style: String,
    pub text_style: String,
    pub diagram_style: String,
    pub structure_pattern: Vec<String>,
    #[serde(default)]
    pub writing_guidelines: Vec<String>,
    #[serde(default)]
    pub section_headings: CreationSkillSectionHeadings,
    #[serde(default)]
    pub field_examples: CreationSkillFieldExamples,
    #[serde(default = "default_analysis_example_document")]
    pub example_document: String,
    #[serde(default)]
    pub suggested_category_keywords: Vec<String>,
    #[serde(default)]
    pub analysis_mode: String,
}

fn default_analysis_example_document() -> String {
    "# 跨团队知识交接优化方案\n\n## 摘要\n\n本示例围绕通用的知识交接场景，说明如何明确范围、责任角色、执行步骤与验收方式。\n\n## 背景与目标\n\n相关团队需要在任务变化时稳定传递必要信息，目标是减少遗漏并让接手者能够独立完成后续工作。\n\n## 方案设计\n\n建立“准备、讲解、确认、复核”四个阶段；每个阶段明确输入、责任角色、输出和完成标准。\n\n## 风险与验证\n\n重点检查资料缺失、理解偏差和权限不当三类风险，并以清单完成情况作为验收依据。".to_string()
}

#[derive(Debug, Default, Deserialize)]
pub struct CreationSkillQuery {
    #[serde(default)]
    pub source_kind: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub installed: Option<bool>,
}

pub async fn analyze_creation_skill(
    Json(request): Json<AnalyzeCreationSkillRequest>,
) -> Result<Json<CreationSkillAnalysis>, ApiError> {
    validate_source(&request.source_kind, &request.source_id)?;
    let title = request.document_title.trim();
    let content = request.document_content.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(ApiError::BadRequest(
            "文档标题需要在 1 到 200 个字符之间".into(),
        ));
    }
    if content.chars().count() < 20 || content.chars().count() > 80_000 {
        return Err(ApiError::BadRequest(
            "文档内容需要在 20 到 80000 个字符之间".into(),
        ));
    }

    let response = reqwest::Client::new()
        .post("http://127.0.0.1:8001/creation/skills/analyze")
        .json(&AnalyzeCreationSkillPayload {
            document_title: title,
            document_content: content,
            doc_type: request.doc_type.trim(),
        })
        .send()
        .await
        .map_err(|error| ApiError::Upstream {
            status: StatusCode::BAD_GATEWAY,
            code: "CREATION_SKILL_ANALYZER_UNAVAILABLE",
            message: format!("本地 Skill 分析服务不可用: {error}"),
        })?;
    if !response.status().is_success() {
        let message = response.text().await.unwrap_or_default();
        return Err(ApiError::Upstream {
            status: StatusCode::BAD_GATEWAY,
            code: "CREATION_SKILL_ANALYSIS_FAILED",
            message: if message.is_empty() {
                "本地 Skill 分析失败".to_string()
            } else {
                message
            },
        });
    }
    let analysis = response
        .json::<CreationSkillAnalysis>()
        .await
        .map_err(|error| ApiError::Upstream {
            status: StatusCode::BAD_GATEWAY,
            code: "INVALID_CREATION_SKILL_ANALYSIS",
            message: format!("本地 Skill 分析结果格式错误: {error}"),
        })?;
    validate_analysis(&analysis)?;
    Ok(Json(analysis))
}

pub async fn list_creation_skills(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CreationSkillQuery>,
) -> Result<Json<Vec<CreationSkillRecord>>, ApiError> {
    if query.source_kind.is_some() != query.source_id.is_some() {
        return Err(ApiError::BadRequest(
            "按来源查询 Skill 时需要同时提供来源类型和来源标识".into(),
        ));
    }
    if let (Some(source_kind), Some(source_id)) = (&query.source_kind, &query.source_id) {
        validate_persisted_source(source_kind, source_id)?;
    }
    Ok(Json(state.storage.list_creation_skills_filtered(
        query.source_kind.as_deref(),
        query.source_id.as_deref(),
        query.installed,
    )?))
}

pub async fn get_creation_skill(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<CreationSkillRecord>, ApiError> {
    state
        .storage
        .get_creation_skill(id)?
        .map(Json)
        .ok_or_else(|| ApiError::NotFound("创作 Skill 不存在".into()))
}

pub async fn save_creation_skill(
    State(state): State<Arc<AppState>>,
    Json(skill): Json<UpsertCreationSkill>,
) -> Result<(StatusCode, Json<CreationSkillRecord>), ApiError> {
    validate_persisted_source(&skill.source_kind, &skill.source_id)?;
    validate_skill_input(&skill)?;
    let saved = state.storage.upsert_creation_skill(&skill)?;
    Ok((StatusCode::CREATED, Json(saved)))
}

pub async fn update_creation_skill(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(mut skill): Json<UpsertCreationSkill>,
) -> Result<Json<CreationSkillRecord>, ApiError> {
    let existing = state
        .storage
        .get_creation_skill(id)?
        .ok_or_else(|| ApiError::NotFound("创作 Skill 不存在".into()))?;
    validate_persisted_source(&skill.source_kind, &skill.source_id)?;
    skill.client_skill_key = existing.client_skill_key;
    validate_skill_input(&skill)?;
    Ok(Json(state.storage.upsert_creation_skill(&skill)?))
}

pub async fn delete_creation_skill(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let existing = state
        .storage
        .get_creation_skill(id)?
        .ok_or_else(|| ApiError::NotFound("创作 Skill 不存在".into()))?;
    if existing.published {
        return Err(ApiError::BadRequest(
            "请先从创作市场下架，再删除本地 Skill".into(),
        ));
    }
    if state.storage.delete_creation_skill(id)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound("创作 Skill 不存在".into()))
    }
}

fn validate_skill_input(skill: &UpsertCreationSkill) -> Result<(), ApiError> {
    let valid_list = |items: &[String], min: usize, max: usize, item_max: usize| {
        items.len() >= min
            && items.len() <= max
            && items
                .iter()
                .all(|item| !item.trim().is_empty() && item.trim().chars().count() <= item_max)
    };
    if skill.client_skill_key.trim().is_empty()
        || skill.client_skill_key.chars().count() > 80
        || skill.title.trim().is_empty()
        || skill.title.trim().chars().count() > 80
        || skill.summary.trim().is_empty()
        || skill.summary.trim().chars().count() > 400
        || !valid_list(&skill.common_titles, 1, 12, 80)
        || skill.title_style.trim().is_empty()
        || skill.title_style.trim().chars().count() > 1_200
        || skill.text_style.trim().is_empty()
        || skill.text_style.trim().chars().count() > 2_000
        || skill.diagram_style.trim().is_empty()
        || skill.diagram_style.trim().chars().count() > 1_200
        || !valid_list(&skill.structure_pattern, 1, 16, 160)
        || !valid_list(&skill.writing_guidelines, 0, 16, 240)
        || skill.section_headings.common_titles != "这类文档标题通常怎么命名"
        || skill.section_headings.title_style.trim().is_empty()
        || skill.section_headings.title_style.trim().chars().count() > 120
        || skill.section_headings.text_style.trim().is_empty()
        || skill.section_headings.text_style.trim().chars().count() > 120
        || skill.section_headings.diagram_style.trim().is_empty()
        || skill.section_headings.diagram_style.trim().chars().count() > 120
        || skill.section_headings.structure_pattern.trim().is_empty()
        || skill
            .section_headings
            .structure_pattern
            .trim()
            .chars()
            .count()
            > 120
        || skill.section_headings.writing_guidelines.trim().is_empty()
        || skill
            .section_headings
            .writing_guidelines
            .trim()
            .chars()
            .count()
            > 120
        || !valid_list(&skill.field_examples.common_titles, 1, 6, 240)
        || !valid_list(&skill.field_examples.title_style, 1, 6, 500)
        || !valid_list(&skill.field_examples.text_style, 1, 6, 500)
        || !valid_list(&skill.field_examples.diagram_style, 1, 6, 500)
        || !valid_list(&skill.field_examples.structure_pattern, 1, 6, 500)
        || !valid_list(&skill.field_examples.writing_guidelines, 1, 6, 500)
        || skill.example_document.trim().chars().count() < 100
        || skill.example_document.trim().chars().count() > 12_000
        || !matches!(skill.status.as_str(), "draft" | "saved")
        || (skill.installed && skill.status != "saved")
        || (skill.published && skill.status != "saved")
    {
        return Err(ApiError::BadRequest(
            "创作 Skill 内容不完整或超过长度限制".into(),
        ));
    }
    if contains_private_skill_marker(skill) {
        return Err(ApiError::BadRequest(
            "Skill 内容或示例仍包含具体组织线索、日期或指标，请改写为通用表达".into(),
        ));
    }
    if skill.published
        && (skill
            .cloud_skill_id
            .as_deref()
            .unwrap_or_default()
            .is_empty()
            || skill.category_id.as_deref().unwrap_or_default().is_empty())
    {
        return Err(ApiError::BadRequest(
            "已公开 Skill 需要关联云端标识和第四级类目".into(),
        ));
    }
    Ok(())
}

fn contains_private_skill_marker(skill: &UpsertCreationSkill) -> bool {
    let values = [
        skill.title.as_str(),
        skill.summary.as_str(),
        skill.title_style.as_str(),
        skill.text_style.as_str(),
        skill.diagram_style.as_str(),
        skill.example_document.as_str(),
        skill.section_headings.common_titles.as_str(),
        skill.section_headings.title_style.as_str(),
        skill.section_headings.text_style.as_str(),
        skill.section_headings.diagram_style.as_str(),
        skill.section_headings.structure_pattern.as_str(),
        skill.section_headings.writing_guidelines.as_str(),
    ]
    .into_iter()
    .chain(skill.common_titles.iter().map(String::as_str))
    .chain(skill.structure_pattern.iter().map(String::as_str))
    .chain(skill.writing_guidelines.iter().map(String::as_str))
    .chain(
        skill
            .field_examples
            .common_titles
            .iter()
            .map(String::as_str),
    )
    .chain(skill.field_examples.title_style.iter().map(String::as_str))
    .chain(skill.field_examples.text_style.iter().map(String::as_str))
    .chain(
        skill
            .field_examples
            .diagram_style
            .iter()
            .map(String::as_str),
    )
    .chain(
        skill
            .field_examples
            .structure_pattern
            .iter()
            .map(String::as_str),
    )
    .chain(
        skill
            .field_examples
            .writing_guidelines
            .iter()
            .map(String::as_str),
    );
    values.into_iter().any(|value| {
        contains_named_private_marker(value) || value.chars().any(|ch| ch.is_ascii_digit())
    })
}

fn contains_named_private_marker(value: &str) -> bool {
    if value.contains("有限责任公司") || value.contains("股份有限公司") {
        return true;
    }
    const MARKERS: &[&str] = &["事业群", "事业部", "研发中心", "产品部", "项目组", "工作组"];
    const GENERIC_PREFIXES: &[&str] = &[
        "跨", "多", "多个", "各", "相关", "某", "示例", "通用", "不同", "该", "由", "与", "和",
        "及", "为", "在", "向", "对", "于",
    ];
    MARKERS.iter().any(|marker| {
        value.match_indices(marker).any(|(index, _)| {
            let prefix = value[..index].trim_end();
            !prefix.is_empty()
                && !GENERIC_PREFIXES
                    .iter()
                    .any(|generic| prefix.ends_with(generic))
        })
    })
}

fn validate_source(source_kind: &str, source_id: &str) -> Result<(), ApiError> {
    if !matches!(source_kind, "creation_history" | "bake_document") {
        return Err(ApiError::BadRequest("Skill 来源类型不受支持".into()));
    }
    if source_id.trim().is_empty() || source_id.chars().count() > 80 {
        return Err(ApiError::BadRequest("Skill 来源标识不正确".into()));
    }
    Ok(())
}

fn validate_persisted_source(source_kind: &str, source_id: &str) -> Result<(), ApiError> {
    if !matches!(source_kind, "creation_history" | "bake_document" | "market") {
        return Err(ApiError::BadRequest("Skill 来源类型不受支持".into()));
    }
    if source_id.trim().is_empty() || source_id.chars().count() > 80 {
        return Err(ApiError::BadRequest("Skill 来源标识不正确".into()));
    }
    Ok(())
}

fn validate_analysis(analysis: &CreationSkillAnalysis) -> Result<(), ApiError> {
    if analysis.title.trim().is_empty()
        || analysis.summary.trim().is_empty()
        || analysis.common_titles.is_empty()
        || analysis.title_style.trim().is_empty()
        || analysis.text_style.trim().is_empty()
        || analysis.diagram_style.trim().is_empty()
        || analysis.structure_pattern.is_empty()
        || analysis.section_headings.common_titles != "这类文档标题通常怎么命名"
        || analysis.section_headings.title_style.trim().is_empty()
        || analysis.section_headings.text_style.trim().is_empty()
        || analysis.section_headings.diagram_style.trim().is_empty()
        || analysis
            .section_headings
            .structure_pattern
            .trim()
            .is_empty()
        || analysis
            .section_headings
            .writing_guidelines
            .trim()
            .is_empty()
        || analysis.field_examples.common_titles.is_empty()
        || analysis.field_examples.title_style.is_empty()
        || analysis.field_examples.text_style.is_empty()
        || analysis.field_examples.diagram_style.is_empty()
        || analysis.field_examples.structure_pattern.is_empty()
        || analysis.field_examples.writing_guidelines.is_empty()
        || analysis.example_document.trim().chars().count() < 100
    {
        return Err(ApiError::Upstream {
            status: StatusCode::BAD_GATEWAY,
            code: "INCOMPLETE_CREATION_SKILL_ANALYSIS",
            message: "本地模型没有生成完整的 Skill 内容".to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allows_known_document_sources() {
        assert!(validate_source("creation_history", "1").is_ok());
        assert!(validate_source("bake_document", "2").is_ok());
        assert!(validate_source("market", "3").is_err());
        assert!(validate_source("capture", "3").is_err());
        assert!(validate_persisted_source("market", "3").is_ok());
    }

    #[test]
    fn rejects_published_skill_without_cloud_reference() {
        let skill = UpsertCreationSkill {
            client_skill_key: "local-1".into(),
            cloud_skill_id: None,
            source_kind: "creation_history".into(),
            source_id: "42".into(),
            title: "架构文档写作法".into(),
            summary: "沉淀架构设计的写作方式。".into(),
            category_id: Some("leaf".into()),
            common_titles: vec!["总体架构设计".into()],
            title_style: "结论先行。".into(),
            text_style: "正式、克制。".into(),
            diagram_style: "标注系统边界。".into(),
            structure_pattern: vec!["背景".into(), "方案".into()],
            writing_guidelines: vec![],
            section_headings: CreationSkillSectionHeadings::default(),
            field_examples: CreationSkillFieldExamples::default(),
            example_document: "# 示例服务架构设计\n\n## 背景与目标\n\n为通用知识服务明确系统边界和演进目标。\n\n## 总体架构\n\n系统划分为接入、服务和数据三层，各层通过稳定接口协作。\n\n## 实施与验证\n\n先验证关键链路，再逐步扩展能力，并用可观测指标检查结果。\n\n## 风险与结论\n\n重点关注依赖失效和数据一致性风险，所有示例均使用虚构场景。".into(),
            status: "saved".into(),
            installed: false,
            published: true,
        };
        assert!(validate_skill_input(&skill).is_err());
    }
}
