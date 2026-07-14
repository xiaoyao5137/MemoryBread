//! Cron 表达式兼容与规范化。
//!
//! 产品界面和历史数据使用常见的五段格式（分 时 日 月 周），
//! `cron` crate 使用包含秒字段的六/七段格式。这里统一兼容并存储六段格式。

use std::str::FromStr;

use chrono::Local;
use cron::Schedule;

/// 五段 cron 沿用 Vixie 约定（0/7=周日、1=周一），而 `cron` crate
/// 使用 1=周日、2=周一。数字星期在补秒字段时必须同步平移。
fn normalize_five_field_day_of_week(field: &str) -> Result<String, String> {
    fn map_day(day: u8) -> Result<u8, String> {
        match day {
            0 | 7 => Ok(1),
            1..=6 => Ok(day + 1),
            _ => Err(format!("星期数字应在 0..=7 范围内，当前为 {day}")),
        }
    }

    let mut normalized = Vec::new();
    for item in field.split(',') {
        if item.is_empty() {
            return Err("星期字段包含空列表项".to_string());
        }

        let (base, step) = match item.split_once('/') {
            Some((base, step)) => {
                let step = step
                    .parse::<usize>()
                    .map_err(|_| format!("星期步长无效: {step}"))?;
                if step == 0 {
                    return Err("星期步长不能为 0".to_string());
                }
                (base, Some(step))
            }
            None => (item, None),
        };

        if base == "*" || base == "?" || base.chars().any(|ch| ch.is_ascii_alphabetic()) {
            normalized.push(item.to_string());
            continue;
        }

        if let Some((start, end)) = base.split_once('-') {
            let start = start
                .parse::<u8>()
                .map_err(|_| format!("星期范围起点无效: {start}"))?;
            let end = end
                .parse::<u8>()
                .map_err(|_| format!("星期范围终点无效: {end}"))?;
            if start > end {
                return Err(format!("星期范围不支持跨周: {base}"));
            }
            let step = step.unwrap_or(1);
            for day in (start..=end).step_by(step) {
                normalized.push(map_day(day)?.to_string());
            }
            continue;
        }

        let day = base
            .parse::<u8>()
            .map_err(|_| format!("星期字段无效: {item}"))?;
        let mapped = map_day(day)?;
        normalized.push(match step {
            Some(step) => format!("{mapped}/{step}"),
            None => mapped.to_string(),
        });
    }

    Ok(normalized.join(","))
}

pub(crate) fn normalize_cron_expression(expression: &str) -> Result<String, String> {
    let fields = expression.split_whitespace().collect::<Vec<_>>();
    let normalized = match fields.len() {
        5 => format!(
            "0 {} {} {} {} {}",
            fields[0],
            fields[1],
            fields[2],
            fields[3],
            normalize_five_field_day_of_week(fields[4])?
        ),
        6 | 7 => fields.join(" "),
        count => {
            return Err(format!("cron 表达式应为 5、6 或 7 段，当前为 {count} 段"));
        }
    };

    Schedule::from_str(&normalized).map_err(|error| format!("cron 表达式解析失败: {error}"))?;
    Ok(normalized)
}

pub(crate) fn next_run_at_ms(expression: &str) -> Result<(String, i64), String> {
    let normalized = normalize_cron_expression(expression)?;
    let schedule =
        Schedule::from_str(&normalized).map_err(|error| format!("cron 表达式解析失败: {error}"))?;
    // 桌面端定时任务按用户本机时区解释，最终仍以 UTC epoch 毫秒持久化。
    let next = schedule
        .upcoming(Local)
        .next()
        .ok_or_else(|| "无法计算下次执行时间".to_string())?;
    Ok((normalized, next.timestamp_millis()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, TimeZone, Utc, Weekday};

    #[test]
    fn five_field_expression_is_normalized_with_seconds() {
        assert_eq!(
            normalize_cron_expression("0 9 * * *").unwrap(),
            "0 0 9 * * *"
        );
        assert_eq!(
            normalize_cron_expression("0 9 * * 1").unwrap(),
            "0 0 9 * * 2"
        );
        assert_eq!(
            normalize_cron_expression("0 10 * * 0").unwrap(),
            "0 0 10 * * 1"
        );
        assert_eq!(
            normalize_cron_expression("0 9 * * 1-5").unwrap(),
            "0 0 9 * * 2,3,4,5,6"
        );
    }

    #[test]
    fn six_field_expression_is_preserved() {
        assert_eq!(
            normalize_cron_expression("0 0 9 1 * *").unwrap(),
            "0 0 9 1 * *"
        );
    }

    #[test]
    fn invalid_field_count_is_rejected() {
        let error = normalize_cron_expression("0 9 * *").unwrap_err();
        assert!(error.contains("当前为 4 段"));
    }

    #[test]
    fn next_run_accepts_legacy_five_field_expression() {
        let (normalized, next_run) = next_run_at_ms("0 9 * * *").unwrap();
        assert_eq!(normalized, "0 0 9 * * *");
        assert!(next_run > Utc::now().timestamp_millis());
    }

    #[test]
    fn legacy_monday_stays_monday_after_normalization() {
        let (normalized, next_run) = next_run_at_ms("0 9 * * 1").unwrap();
        assert_eq!(normalized, "0 0 9 * * 2");
        assert_eq!(
            Local
                .timestamp_millis_opt(next_run)
                .single()
                .unwrap()
                .weekday(),
            Weekday::Mon
        );
    }
}
