use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::storage::{db::current_ts_ms, StorageError, StorageManager};

const SELECT_COLUMNS: &str =
    "id, client_skill_key, cloud_skill_id, source_kind, source_id, title, summary,
     category_id, common_titles, title_style, text_style, diagram_style,
     structure_pattern, writing_guidelines, section_headings, field_examples,
     example_document, status, installed, published, created_at, updated_at";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreationSkillSectionHeadings {
    #[serde(default = "default_common_titles_heading")]
    pub common_titles: String,
    #[serde(default = "default_title_style_heading")]
    pub title_style: String,
    #[serde(default = "default_text_style_heading")]
    pub text_style: String,
    #[serde(default = "default_diagram_style_heading")]
    pub diagram_style: String,
    #[serde(default = "default_structure_pattern_heading")]
    pub structure_pattern: String,
    #[serde(default = "default_writing_guidelines_heading")]
    pub writing_guidelines: String,
}

impl Default for CreationSkillSectionHeadings {
    fn default() -> Self {
        Self {
            common_titles: default_common_titles_heading(),
            title_style: default_title_style_heading(),
            text_style: default_text_style_heading(),
            diagram_style: default_diagram_style_heading(),
            structure_pattern: default_structure_pattern_heading(),
            writing_guidelines: default_writing_guidelines_heading(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreationSkillFieldExamples {
    #[serde(default = "default_common_title_examples")]
    pub common_titles: Vec<String>,
    #[serde(default = "default_title_style_examples")]
    pub title_style: Vec<String>,
    #[serde(default = "default_text_style_examples")]
    pub text_style: Vec<String>,
    #[serde(default = "default_diagram_style_examples")]
    pub diagram_style: Vec<String>,
    #[serde(default = "default_structure_pattern_examples")]
    pub structure_pattern: Vec<String>,
    #[serde(default = "default_writing_guideline_examples")]
    pub writing_guidelines: Vec<String>,
}

impl Default for CreationSkillFieldExamples {
    fn default() -> Self {
        Self {
            common_titles: default_common_title_examples(),
            title_style: default_title_style_examples(),
            text_style: default_text_style_examples(),
            diagram_style: default_diagram_style_examples(),
            structure_pattern: default_structure_pattern_examples(),
            writing_guidelines: default_writing_guideline_examples(),
        }
    }
}

fn default_common_titles_heading() -> String {
    "这类文档标题通常怎么命名".to_string()
}

fn default_title_style_heading() -> String {
    "标题如何传递重点".to_string()
}

fn default_text_style_heading() -> String {
    "正文怎样组织和表达".to_string()
}

fn default_diagram_style_heading() -> String {
    "图示怎样服务于内容".to_string()
}

fn default_structure_pattern_heading() -> String {
    "从开篇到结论的章节骨架".to_string()
}

fn default_writing_guidelines_heading() -> String {
    "保持这份风格的关键约束".to_string()
}

fn default_common_title_examples() -> Vec<String> {
    vec![
        "协作流程优化方案".to_string(),
        "阶段复盘与后续行动报告".to_string(),
    ]
}

fn default_title_style_examples() -> Vec<String> {
    vec!["协作流程优化方案：明确目标、范围与交付边界".to_string()]
}

fn default_text_style_examples() -> Vec<String> {
    vec!["本方案先明确适用范围，再说明关键步骤、责任边界与验收方式。".to_string()]
}

fn default_diagram_style_examples() -> Vec<String> {
    vec!["用泳道图展示提出、处理、复核三个阶段，并用统一图例标注责任角色。".to_string()]
}

fn default_structure_pattern_examples() -> Vec<String> {
    vec!["背景与目标 → 现状与约束 → 方案设计 → 实施计划 → 风险与验证".to_string()]
}

fn default_writing_guideline_examples() -> Vec<String> {
    vec!["把“提升效率”改写为“减少交接步骤，并设置可核验的完成标准”。".to_string()]
}

fn default_example_document() -> String {
    "# 跨团队知识交接优化方案\n\n## 摘要\n\n本示例围绕通用的知识交接场景，说明如何明确范围、责任角色、执行步骤与验收方式。\n\n## 背景与目标\n\n相关团队需要在任务变化时稳定传递必要信息，目标是减少遗漏并让接手者能够独立完成后续工作。\n\n## 方案设计\n\n建立“准备、讲解、确认、复核”四个阶段；每个阶段明确输入、责任角色、输出和完成标准。\n\n## 风险与验证\n\n重点检查资料缺失、理解偏差和权限不当三类风险，并以清单完成情况作为验收依据。".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CreationSkillRecord {
    pub id: i64,
    pub client_skill_key: String,
    pub cloud_skill_id: Option<String>,
    pub source_kind: String,
    pub source_id: String,
    pub title: String,
    pub summary: String,
    pub category_id: Option<String>,
    pub common_titles: Vec<String>,
    pub title_style: String,
    pub text_style: String,
    pub diagram_style: String,
    pub structure_pattern: Vec<String>,
    pub writing_guidelines: Vec<String>,
    pub section_headings: CreationSkillSectionHeadings,
    pub field_examples: CreationSkillFieldExamples,
    pub example_document: String,
    pub status: String,
    pub installed: bool,
    pub published: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertCreationSkill {
    pub client_skill_key: String,
    pub cloud_skill_id: Option<String>,
    pub source_kind: String,
    pub source_id: String,
    pub title: String,
    pub summary: String,
    pub category_id: Option<String>,
    pub common_titles: Vec<String>,
    pub title_style: String,
    pub text_style: String,
    pub diagram_style: String,
    pub structure_pattern: Vec<String>,
    pub writing_guidelines: Vec<String>,
    #[serde(default)]
    pub section_headings: CreationSkillSectionHeadings,
    #[serde(default)]
    pub field_examples: CreationSkillFieldExamples,
    #[serde(default = "default_example_document")]
    pub example_document: String,
    pub status: String,
    pub installed: bool,
    pub published: bool,
}

impl StorageManager {
    pub fn list_creation_skills(&self) -> Result<Vec<CreationSkillRecord>, StorageError> {
        self.list_creation_skills_filtered(None, None, None)
    }

    pub fn list_creation_skills_filtered(
        &self,
        source_kind: Option<&str>,
        source_id: Option<&str>,
        installed: Option<bool>,
    ) -> Result<Vec<CreationSkillRecord>, StorageError> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT {SELECT_COLUMNS} FROM creation_skills
                 WHERE deleted_at IS NULL
                   AND (?1 IS NULL OR source_kind = ?1)
                   AND (?2 IS NULL OR source_id = ?2)
                   AND (?3 IS NULL OR installed = ?3)
                 ORDER BY updated_at DESC, id DESC"
            ))?;
            let installed_value = installed.map(i64::from);
            let rows = stmt.query_map(
                params![source_kind, source_id, installed_value],
                row_to_skill,
            )?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::Sqlite)
        })
    }

    pub fn get_creation_skill(&self, id: i64) -> Result<Option<CreationSkillRecord>, StorageError> {
        self.with_conn(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {SELECT_COLUMNS} FROM creation_skills
                     WHERE id = ?1 AND deleted_at IS NULL"
                ),
                params![id],
                row_to_skill,
            )
            .optional()
            .map_err(StorageError::Sqlite)
        })
    }

    pub fn upsert_creation_skill(
        &self,
        skill: &UpsertCreationSkill,
    ) -> Result<CreationSkillRecord, StorageError> {
        validate_skill(skill)?;
        let now = current_ts_ms();
        let common_titles = serde_json::to_string(&skill.common_titles)?;
        let structure_pattern = serde_json::to_string(&skill.structure_pattern)?;
        let writing_guidelines = serde_json::to_string(&skill.writing_guidelines)?;
        let section_headings = serde_json::to_string(&skill.section_headings)?;
        let field_examples = serde_json::to_string(&skill.field_examples)?;
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO creation_skills (
                    client_skill_key, cloud_skill_id, source_kind, source_id, title, summary,
                    category_id, common_titles, title_style, text_style, diagram_style,
                    structure_pattern, writing_guidelines, section_headings, field_examples,
                    example_document, status, installed, published, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20)
                 ON CONFLICT(client_skill_key) DO UPDATE SET
                    cloud_skill_id = excluded.cloud_skill_id,
                    source_kind = excluded.source_kind,
                    source_id = excluded.source_id,
                    title = excluded.title,
                    summary = excluded.summary,
                    category_id = excluded.category_id,
                    common_titles = excluded.common_titles,
                    title_style = excluded.title_style,
                    text_style = excluded.text_style,
                    diagram_style = excluded.diagram_style,
                    structure_pattern = excluded.structure_pattern,
                    writing_guidelines = excluded.writing_guidelines,
                    section_headings = excluded.section_headings,
                    field_examples = excluded.field_examples,
                    example_document = excluded.example_document,
                    status = excluded.status,
                    installed = excluded.installed,
                    published = excluded.published,
                    updated_at = excluded.updated_at,
                    deleted_at = NULL",
                params![
                    skill.client_skill_key,
                    skill.cloud_skill_id,
                    skill.source_kind,
                    skill.source_id,
                    skill.title,
                    skill.summary,
                    skill.category_id,
                    common_titles,
                    skill.title_style,
                    skill.text_style,
                    skill.diagram_style,
                    structure_pattern,
                    writing_guidelines,
                    section_headings,
                    field_examples,
                    skill.example_document,
                    skill.status,
                    i64::from(skill.installed),
                    i64::from(skill.published),
                    now,
                ],
            )?;
            conn.query_row(
                &format!(
                    "SELECT {SELECT_COLUMNS} FROM creation_skills WHERE client_skill_key = ?1"
                ),
                params![skill.client_skill_key],
                row_to_skill,
            )
            .map_err(StorageError::Sqlite)
        })
    }

    pub fn delete_creation_skill(&self, id: i64) -> Result<bool, StorageError> {
        let now = current_ts_ms();
        self.with_conn(|conn| {
            Ok(conn.execute(
                "UPDATE creation_skills SET deleted_at = ?1, updated_at = ?1
                 WHERE id = ?2 AND deleted_at IS NULL",
                params![now, id],
            )? > 0)
        })
    }
}

fn validate_skill(skill: &UpsertCreationSkill) -> Result<(), StorageError> {
    if skill.client_skill_key.trim().is_empty()
        || !matches!(
            skill.source_kind.as_str(),
            "creation_history" | "bake_document" | "market"
        )
        || skill.source_id.trim().is_empty()
        || skill.title.trim().is_empty()
        || skill.summary.trim().is_empty()
        || skill.common_titles.is_empty()
        || skill.title_style.trim().is_empty()
        || skill.text_style.trim().is_empty()
        || skill.diagram_style.trim().is_empty()
        || skill.structure_pattern.is_empty()
        || skill.section_headings.common_titles.trim().is_empty()
        || skill.section_headings.title_style.trim().is_empty()
        || skill.section_headings.text_style.trim().is_empty()
        || skill.section_headings.diagram_style.trim().is_empty()
        || skill.section_headings.structure_pattern.trim().is_empty()
        || skill.section_headings.writing_guidelines.trim().is_empty()
        || skill.field_examples.common_titles.is_empty()
        || skill.field_examples.title_style.is_empty()
        || skill.field_examples.text_style.is_empty()
        || skill.field_examples.diagram_style.is_empty()
        || skill.field_examples.structure_pattern.is_empty()
        || skill.field_examples.writing_guidelines.is_empty()
        || skill.example_document.trim().is_empty()
        || !matches!(skill.status.as_str(), "draft" | "saved")
        || (skill.installed && skill.status != "saved")
    {
        return Err(StorageError::MigrationFailed {
            version: "creation_skill_validation",
            reason: "创作 Skill 内容不完整".to_string(),
        });
    }
    Ok(())
}

fn row_to_skill(row: &rusqlite::Row<'_>) -> rusqlite::Result<CreationSkillRecord> {
    Ok(CreationSkillRecord {
        id: row.get("id")?,
        client_skill_key: row.get("client_skill_key")?,
        cloud_skill_id: row.get("cloud_skill_id")?,
        source_kind: row.get("source_kind")?,
        source_id: row.get("source_id")?,
        title: row.get("title")?,
        summary: row.get("summary")?,
        category_id: row.get("category_id")?,
        common_titles: parse_json(row.get::<_, String>("common_titles")?),
        title_style: row.get("title_style")?,
        text_style: row.get("text_style")?,
        diagram_style: row.get("diagram_style")?,
        structure_pattern: parse_json(row.get::<_, String>("structure_pattern")?),
        writing_guidelines: parse_json(row.get::<_, String>("writing_guidelines")?),
        section_headings: parse_json_object(row.get::<_, String>("section_headings")?),
        field_examples: parse_json_object(row.get::<_, String>("field_examples")?),
        example_document: {
            let value = row.get::<_, String>("example_document")?;
            if value.trim().is_empty() {
                default_example_document()
            } else {
                value
            }
        },
        status: row.get("status")?,
        installed: row.get::<_, i64>("installed")? != 0,
        published: row.get::<_, i64>("published")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn parse_json(value: String) -> Vec<String> {
    serde_json::from_str(&value).unwrap_or_default()
}

fn parse_json_object<T>(value: String) -> T
where
    T: serde::de::DeserializeOwned + Default,
{
    serde_json::from_str(&value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_skill() -> UpsertCreationSkill {
        UpsertCreationSkill {
            client_skill_key: "skill-local-1".into(),
            cloud_skill_id: None,
            source_kind: "creation_history".into(),
            source_id: "12".into(),
            title: "架构文档 Skill".into(),
            summary: "复用架构文档的写作方式。".into(),
            category_id: Some("category-1".into()),
            common_titles: vec!["总体架构设计".into()],
            title_style: "结论先行。".into(),
            text_style: "正式、克制。".into(),
            diagram_style: "分层架构图。".into(),
            structure_pattern: vec!["背景".into(), "总体架构".into()],
            writing_guidelines: vec!["说明取舍。".into()],
            section_headings: CreationSkillSectionHeadings::default(),
            field_examples: CreationSkillFieldExamples::default(),
            example_document: default_example_document(),
            status: "saved".into(),
            installed: false,
            published: false,
        }
    }

    #[test]
    fn local_skill_upsert_is_idempotent() {
        let storage = StorageManager::open_in_memory().unwrap();
        let first = storage.upsert_creation_skill(&sample_skill()).unwrap();
        let mut updated = sample_skill();
        updated.title = "更新后的架构文档 Skill".into();
        let second = storage.upsert_creation_skill(&updated).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(second.title, "更新后的架构文档 Skill");
        assert_eq!(storage.list_creation_skills().unwrap().len(), 1);
    }

    #[test]
    fn filters_skills_by_source_and_installation() {
        let storage = StorageManager::open_in_memory().unwrap();
        let mut installed = sample_skill();
        installed.installed = true;
        storage.upsert_creation_skill(&installed).unwrap();

        let by_source = storage
            .list_creation_skills_filtered(Some("creation_history"), Some("12"), None)
            .unwrap();
        let installed_only = storage
            .list_creation_skills_filtered(None, None, Some(true))
            .unwrap();

        assert_eq!(by_source.len(), 1);
        assert_eq!(installed_only.len(), 1);
        assert!(installed_only[0].installed);
    }

    #[test]
    fn stores_market_skill_as_an_installed_local_copy() {
        let storage = StorageManager::open_in_memory().unwrap();
        let mut market = sample_skill();
        market.client_skill_key = "market-01900000-0000-7000-8000-000000000001".into();
        market.cloud_skill_id = Some("01900000-0000-7000-8000-000000000001".into());
        market.source_kind = "market".into();
        market.source_id = "01900000-0000-7000-8000-000000000001".into();
        market.installed = true;

        let saved = storage.upsert_creation_skill(&market).unwrap();

        assert_eq!(saved.source_kind, "market");
        assert!(saved.installed);
        assert!(!saved.published);
    }
}
