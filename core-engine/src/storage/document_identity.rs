/// 将文档 URL 归一化为稳定身份。
///
/// query/fragment 通常只表示章节、视图或分享参数，不应把同一份文档拆成多条；
/// scheme、host 和企业文档 ID 的大小写在实际 capture 中也并不稳定，因此统一小写。
pub(crate) fn canonical_document_identity(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lowered = trimmed.to_lowercase();
    const DOCUMENT_URL_MARKERS: &[&str] = &[
        "docs.corp",
        "/docs/",
        "docs.google",
        "/document/",
        "yuque.com",
        "feishu.cn/docx",
        "feishu.cn/wiki",
        "larkoffice.com/wiki",
        "notion.so",
        "confluence",
        "/wiki/",
        "shimo.im",
        "/d/home/",
        "/s/home/",
        "/k/home/",
    ];
    if !DOCUMENT_URL_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
    {
        return None;
    }

    let without_fragment = trimmed.split('#').next().unwrap_or(trimmed);
    let without_query = without_fragment
        .split('?')
        .next()
        .unwrap_or(without_fragment);
    let without_scheme = without_query
        .strip_prefix("https://")
        .or_else(|| without_query.strip_prefix("http://"))
        .unwrap_or(without_query);
    let identity = without_scheme.trim_end_matches('/').trim().to_lowercase();
    (!identity.is_empty()).then_some(identity)
}

/// 标题只作为无 URL 文档的保守兜底身份。
///
/// 这里只消除展示层差异：空白、横线样式、浏览器/编辑器后缀和“云文档”UI 后缀；
/// “修订版”“会议纪要”等有语义的版本词不会被移除。
pub(crate) fn canonical_document_title_identity(title: &str) -> Option<String> {
    let mut normalized = title
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .map(|ch| match ch {
            '–' | '—' | '－' => '-',
            other => other,
        })
        .collect::<String>();

    const UI_SUFFIXES: &[&str] = &[
        "-googlechrome",
        "-microsoftedge",
        "-safari",
        "-firefox",
        "-arc",
        "-microsoftword",
        "-word",
        "-pages",
        "-云文档",
        "（云文档）",
        "(云文档)",
    ];
    loop {
        let Some(suffix) = UI_SUFFIXES
            .iter()
            .find(|suffix| normalized.ends_with(**suffix))
        else {
            break;
        };
        normalized.truncate(normalized.len().saturating_sub(suffix.len()));
        normalized = normalized.trim_end_matches('-').to_string();
    }

    (!normalized.is_empty()).then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_url_ignores_view_parameters_and_scheme() {
        assert_eq!(
            canonical_document_identity(
                "https://Docs.Corp.Example/d/home/ABC123?section=one#comment"
            ),
            canonical_document_identity("http://docs.corp.example/d/home/abc123/")
        );
    }

    #[test]
    fn canonical_title_only_removes_ui_variants() {
        assert_eq!(
            canonical_document_title_identity("商业体系-AI 建设资产复用方案 - 云文档"),
            canonical_document_title_identity("商业体系-AI建设资产复用方案（云文档）")
        );
        assert_ne!(
            canonical_document_title_identity("商业体系-AI建设资产复用方案（修订版）"),
            canonical_document_title_identity("商业体系-AI建设资产复用方案")
        );
    }
}
