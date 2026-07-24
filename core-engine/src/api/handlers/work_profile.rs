//! GET /api/work-profile - 返回个人工作画像所需的本地聚合统计。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::api::{error::ApiError, state::AppState};
use crate::storage::models::{CaptureActivityAggregate, WorkImExpression};

const DAY_MS: i64 = 86_400_000;
const MAX_RANGE_DAYS: i64 = 400;
const IDLE_GAP_CAP_MS: i64 = 5 * 60 * 1000;
const LAST_CAPTURE_TAIL_MS: i64 = 60 * 1000;
const OVERNIGHT_END_HOUR: i64 = 6;
const MAX_IM_EXPRESSIONS: usize = 200;

#[derive(Debug, Deserialize)]
pub struct WorkProfileQuery {
    pub from: i64,
    pub to: i64,
    #[serde(default)]
    pub timezone_offset_minutes: i32,
    #[serde(default)]
    pub include_achievement_metrics: bool,
}

#[derive(Debug, Serialize)]
pub struct WorkProfileResponse {
    pub range_start: i64,
    pub range_end: i64,
    pub idle_gap_cap_minutes: i64,
    pub total_minutes: i64,
    pub active_days: usize,
    pub current_streak: usize,
    pub longest_streak: usize,
    pub longest_day_minutes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub achievement_metrics: Option<AchievementMetrics>,
    pub today: TodayWorkSummary,
    pub days: Vec<WorkDaySummary>,
}

/// 标签卡片只消费本地计算后的时长峰值，不包含任何工作内容。
#[derive(Debug, Serialize)]
pub struct AchievementMetrics {
    pub longest_work_session_minutes: i64,
    pub max_overnight_work_minutes: i64,
    pub interruption_gap_minutes: i64,
    pub overnight_start_hour: i64,
    pub overnight_end_hour: i64,
}

#[derive(Debug, Serialize)]
pub struct TodayWorkSummary {
    pub date: String,
    pub total_minutes: i64,
    pub capture_count: i64,
    pub first_capture_at: Option<i64>,
    pub last_capture_at: Option<i64>,
    pub apps: Vec<WorkAppSummary>,
    pub mood: TodayMoodSummary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkMood {
    Energized,
    Focused,
    Steady,
    Tired,
    Overloaded,
}

#[derive(Debug, Serialize)]
pub struct TodayMoodSummary {
    pub inferred: bool,
    pub mood: Option<WorkMood>,
    pub expression_count: usize,
    pub source_apps: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct WorkAppSummary {
    pub name: String,
    pub minutes: i64,
    pub capture_count: i64,
}

#[derive(Debug, Serialize)]
pub struct WorkDaySummary {
    pub date: String,
    pub minutes: i64,
    pub capture_count: i64,
}

#[derive(Debug, Default)]
struct DayAccumulator {
    duration_ms: i64,
    capture_count: i64,
    first_ts: Option<i64>,
    last_ts: Option<i64>,
    apps: Vec<WorkAppSummary>,
}

pub async fn get_work_profile(
    State(state): State<Arc<AppState>>,
    Query(params): Query<WorkProfileQuery>,
) -> Result<Json<WorkProfileResponse>, ApiError> {
    validate_query(&params)?;

    let timezone_offset_ms = i64::from(params.timezone_offset_minutes) * 60_000;
    let range_start = params.from;
    let range_end = params.to;
    let include_achievement_metrics = params.include_achievement_metrics;
    let (today_start, today_end) = current_local_day_range(timezone_offset_ms)?;
    let mood_start = range_start.max(today_start);
    let mood_end = range_end.min(today_end);
    let activity_start = range_start.saturating_sub(IDLE_GAP_CAP_MS);
    let activity_end = range_end.saturating_add(IDLE_GAP_CAP_MS);
    let storage = state.storage.clone();
    let (rows, expressions, timestamps) = tokio::task::spawn_blocking(move || {
        let rows = storage.summarize_capture_activity(
            range_start,
            range_end,
            timezone_offset_ms,
            IDLE_GAP_CAP_MS,
        )?;
        let expressions = if mood_start < mood_end {
            storage.list_work_im_expressions(mood_start, mood_end, MAX_IM_EXPRESSIONS)?
        } else {
            Vec::new()
        };
        let timestamps = if include_achievement_metrics {
            Some(storage.list_capture_activity_timestamps(activity_start, activity_end)?)
        } else {
            None
        };
        Ok::<_, crate::storage::error::StorageError>((rows, expressions, timestamps))
    })
    .await
    .map_err(|error| ApiError::Internal(error.to_string()))??;

    let mood = infer_work_mood(&expressions);
    let response = build_response(
        rows,
        mood,
        timestamps,
        range_start,
        range_end,
        timezone_offset_ms,
    )?;
    Ok(Json(response))
}

fn validate_query(params: &WorkProfileQuery) -> Result<(), ApiError> {
    let range_ms = params
        .to
        .checked_sub(params.from)
        .filter(|range| *range > 0)
        .ok_or_else(|| ApiError::BadRequest("to must be greater than from".to_string()))?;
    if range_ms > MAX_RANGE_DAYS * DAY_MS {
        return Err(ApiError::BadRequest(format!(
            "work profile range must not exceed {MAX_RANGE_DAYS} days"
        )));
    }
    if !(-720..=840).contains(&params.timezone_offset_minutes) {
        return Err(ApiError::BadRequest(
            "timezone_offset_minutes is out of range".to_string(),
        ));
    }
    Ok(())
}

fn build_response(
    rows: Vec<CaptureActivityAggregate>,
    mood: TodayMoodSummary,
    timestamps: Option<Vec<i64>>,
    range_start: i64,
    range_end: i64,
    timezone_offset_ms: i64,
) -> Result<WorkProfileResponse, ApiError> {
    let mut days: BTreeMap<i64, DayAccumulator> = BTreeMap::new();
    for row in rows {
        let day = days.entry(row.day_index).or_default();
        day.duration_ms += row.duration_ms;
        day.capture_count += row.capture_count;
        day.first_ts = Some(
            day.first_ts
                .map_or(row.first_ts, |value| value.min(row.first_ts)),
        );
        day.last_ts = Some(
            day.last_ts
                .map_or(row.last_ts, |value| value.max(row.last_ts)),
        );
        day.apps.push(WorkAppSummary {
            name: row.app_name,
            minutes: round_minutes(row.duration_ms),
            capture_count: row.capture_count,
        });
    }

    let now_day_index = (Utc::now().timestamp_millis() + timezone_offset_ms) / DAY_MS;
    let today_date = day_index_to_date(now_day_index)?;
    let today_accumulator = days.get(&now_day_index);
    let today = TodayWorkSummary {
        date: today_date,
        total_minutes: today_accumulator
            .map(|day| round_minutes(day.duration_ms))
            .unwrap_or_default(),
        capture_count: today_accumulator
            .map(|day| day.capture_count)
            .unwrap_or_default(),
        first_capture_at: today_accumulator.and_then(|day| day.first_ts),
        last_capture_at: today_accumulator.and_then(|day| day.last_ts),
        apps: compact_apps(
            today_accumulator
                .map(|day| day.apps.as_slice())
                .unwrap_or_default(),
        ),
        mood,
    };

    let active_day_indexes = days.keys().copied().collect::<Vec<_>>();
    let (current_streak, longest_streak) = streaks(&active_day_indexes, now_day_index);
    let day_summaries = days
        .iter()
        .map(|(day_index, day)| {
            Ok(WorkDaySummary {
                date: day_index_to_date(*day_index)?,
                minutes: round_minutes(day.duration_ms),
                capture_count: day.capture_count,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let total_minutes = days.values().map(|day| day.duration_ms).sum::<i64>();
    let longest_day_minutes = days
        .values()
        .map(|day| round_minutes(day.duration_ms))
        .max()
        .unwrap_or_default();
    let achievement_metrics = timestamps.map(|timestamps| {
        build_achievement_metrics(&timestamps, range_start, range_end, timezone_offset_ms)
    });

    Ok(WorkProfileResponse {
        range_start,
        range_end,
        idle_gap_cap_minutes: IDLE_GAP_CAP_MS / 60_000,
        total_minutes: round_minutes(total_minutes),
        active_days: days.len(),
        current_streak,
        longest_streak,
        longest_day_minutes,
        achievement_metrics,
        today,
        days: day_summaries,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ActiveSession {
    start: i64,
    end: i64,
}

fn build_achievement_metrics(
    timestamps: &[i64],
    range_start: i64,
    range_end: i64,
    timezone_offset_ms: i64,
) -> AchievementMetrics {
    let sessions = build_active_sessions(timestamps, range_start, range_end);
    let longest_work_session_ms = sessions
        .iter()
        .map(|session| session.end.saturating_sub(session.start))
        .max()
        .unwrap_or_default();
    let max_overnight_work_ms = sessions
        .iter()
        .map(|session| overnight_overlap_ms(*session, timezone_offset_ms))
        .max()
        .unwrap_or_default();

    AchievementMetrics {
        longest_work_session_minutes: floor_minutes(longest_work_session_ms),
        max_overnight_work_minutes: floor_minutes(max_overnight_work_ms),
        interruption_gap_minutes: IDLE_GAP_CAP_MS / 60_000,
        overnight_start_hour: 0,
        overnight_end_hour: OVERNIGHT_END_HOUR,
    }
}

fn build_active_sessions(
    timestamps: &[i64],
    range_start: i64,
    range_end: i64,
) -> Vec<ActiveSession> {
    if range_start >= range_end {
        return Vec::new();
    }

    let mut ordered = timestamps.to_vec();
    ordered.sort_unstable();
    ordered.dedup();
    let Some(&first) = ordered.first() else {
        return Vec::new();
    };

    let mut sessions = Vec::new();
    let mut session_start = first;
    let mut previous = first;
    for &timestamp in ordered.iter().skip(1) {
        if timestamp.saturating_sub(previous) > IDLE_GAP_CAP_MS {
            push_clamped_session(
                &mut sessions,
                session_start,
                previous.saturating_add(IDLE_GAP_CAP_MS),
                range_start,
                range_end,
            );
            session_start = timestamp;
        }
        previous = timestamp;
    }
    push_clamped_session(
        &mut sessions,
        session_start,
        previous.saturating_add(LAST_CAPTURE_TAIL_MS),
        range_start,
        range_end,
    );
    sessions
}

fn push_clamped_session(
    sessions: &mut Vec<ActiveSession>,
    start: i64,
    end: i64,
    range_start: i64,
    range_end: i64,
) {
    let clamped = ActiveSession {
        start: start.max(range_start),
        end: end.min(range_end),
    };
    if clamped.start < clamped.end {
        sessions.push(clamped);
    }
}

fn overnight_overlap_ms(session: ActiveSession, timezone_offset_ms: i64) -> i64 {
    if session.start >= session.end {
        return 0;
    }
    let first_day = session
        .start
        .saturating_add(timezone_offset_ms)
        .div_euclid(DAY_MS);
    let last_day = session
        .end
        .saturating_sub(1)
        .saturating_add(timezone_offset_ms)
        .div_euclid(DAY_MS);
    let mut maximum = 0;
    for day_index in first_day..=last_day {
        let window_start = day_index
            .saturating_mul(DAY_MS)
            .saturating_sub(timezone_offset_ms);
        let window_end = window_start.saturating_add(OVERNIGHT_END_HOUR * 60 * 60 * 1000);
        let overlap_start = session.start.max(window_start);
        let overlap_end = session.end.min(window_end);
        maximum = maximum.max(overlap_end.saturating_sub(overlap_start));
    }
    maximum
}

fn floor_minutes(duration_ms: i64) -> i64 {
    duration_ms.max(0) / 60_000
}

fn compact_apps(apps: &[WorkAppSummary]) -> Vec<WorkAppSummary> {
    let mut sorted = apps
        .iter()
        .map(|app| WorkAppSummary {
            name: app.name.clone(),
            minutes: app.minutes,
            capture_count: app.capture_count,
        })
        .collect::<Vec<_>>();
    sorted.sort_by(|left, right| {
        right
            .minutes
            .cmp(&left.minutes)
            .then_with(|| left.name.cmp(&right.name))
    });
    if sorted.len() <= 5 {
        return sorted;
    }

    let remainder = sorted.split_off(5);
    sorted.push(WorkAppSummary {
        name: "其他".to_string(),
        minutes: remainder.iter().map(|app| app.minutes).sum(),
        capture_count: remainder.iter().map(|app| app.capture_count).sum(),
    });
    sorted
}

fn streaks(active_days: &[i64], today_day_index: i64) -> (usize, usize) {
    let mut longest = 0;
    let mut running = 0;
    let mut previous: Option<i64> = None;

    for day in active_days {
        running = if previous.is_some_and(|value| *day == value + 1) {
            running + 1
        } else {
            1
        };
        longest = longest.max(running);
        previous = Some(*day);
    }

    let current = if active_days.last().copied() == Some(today_day_index) {
        running
    } else {
        0
    };
    (current, longest)
}

fn round_minutes(duration_ms: i64) -> i64 {
    (duration_ms.max(0) + 30_000) / 60_000
}

fn current_local_day_range(timezone_offset_ms: i64) -> Result<(i64, i64), ApiError> {
    let now = Utc::now().timestamp_millis();
    let local_day_index = now
        .checked_add(timezone_offset_ms)
        .ok_or_else(|| ApiError::Internal("invalid local time".to_string()))?
        .div_euclid(DAY_MS);
    let start = local_day_index
        .checked_mul(DAY_MS)
        .and_then(|value| value.checked_sub(timezone_offset_ms))
        .ok_or_else(|| ApiError::Internal("invalid local day range".to_string()))?;
    let end = start
        .checked_add(DAY_MS)
        .ok_or_else(|| ApiError::Internal("invalid local day range".to_string()))?;
    Ok((start, end))
}

fn infer_work_mood(expressions: &[WorkImExpression]) -> TodayMoodSummary {
    let source_apps = expressions
        .iter()
        .map(|expression| expression.app_name.trim())
        .filter(|app_name| !app_name.is_empty())
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(4)
        .collect::<Vec<_>>();

    if expressions.is_empty() {
        return TodayMoodSummary {
            inferred: false,
            mood: None,
            expression_count: 0,
            source_apps,
        };
    }

    const OVERLOADED: &[&str] = &[
        "来不及",
        "赶不及",
        "忙不过来",
        "排不过来",
        "事情太多",
        "任务太多",
        "压力很大",
        "压力好大",
        "要崩",
        "崩溃",
        "焦虑",
        "超负荷",
        "非常紧急",
        "严重延期",
        "完全卡住",
        "顶不住",
        "扛不住",
        "overwhelmed",
        "too much",
        "urgent",
        "blocked",
    ];
    const TIRED: &[&str] = &[
        "有点累",
        "好累",
        "太累",
        "累了",
        "很困",
        "太困",
        "疲惫",
        "没精神",
        "头疼",
        "休息一下",
        "熬夜",
        "加班到",
        "撑不住",
    ];
    const ENERGIZED: &[&str] = &[
        "搞定了",
        "完成了",
        "顺利完成",
        "太好了",
        "好耶",
        "很开心",
        "很期待",
        "进展不错",
        "效果不错",
        "没问题",
        "可以的",
        "冲一把",
        "感谢",
        "谢谢",
        "辛苦了",
        "great",
        "awesome",
        "nice",
        "done",
    ];
    const FOCUSED: &[&str] = &[
        "我来处理",
        "我来跟进",
        "正在处理",
        "正在排查",
        "正在推进",
        "我先确认",
        "我会确认",
        "马上处理",
        "稍后同步",
        "今天完成",
        "今天提交",
        "计划完成",
        "继续推进",
        "安排一下",
        "跟进一下",
        "排查一下",
        "整理一下",
        "review",
        "debug",
        "fix",
    ];

    let mut overloaded_score = 0;
    let mut tired_score = 0;
    let mut energized_score = 0;
    let mut focused_score = 0;
    for expression in expressions {
        let text = expression.input_text.to_lowercase();
        overloaded_score += keyword_matches(&text, OVERLOADED) * 4;
        tired_score += keyword_matches(&text, TIRED) * 4;
        energized_score += keyword_matches(&text, ENERGIZED) * 2;
        focused_score += keyword_matches(&text, FOCUSED);
    }

    let highest = overloaded_score
        .max(tired_score)
        .max(energized_score)
        .max(focused_score);
    let mood = if highest == 0 {
        WorkMood::Steady
    } else if overloaded_score == highest {
        WorkMood::Overloaded
    } else if tired_score == highest {
        WorkMood::Tired
    } else if energized_score == highest {
        WorkMood::Energized
    } else {
        WorkMood::Focused
    };

    TodayMoodSummary {
        inferred: true,
        mood: Some(mood),
        expression_count: expressions.len(),
        source_apps,
    }
}

fn keyword_matches(text: &str, keywords: &[&str]) -> i32 {
    keywords
        .iter()
        .filter(|keyword| text.contains(**keyword))
        .count() as i32
}

fn day_index_to_date(day_index: i64) -> Result<String, ApiError> {
    DateTime::<Utc>::from_timestamp_millis(day_index * DAY_MS)
        .map(|date| date.format("%Y-%m-%d").to_string())
        .ok_or_else(|| ApiError::Internal("invalid work profile date".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn activity(day_index: i64, app_name: &str, minutes: i64) -> CaptureActivityAggregate {
        let first_ts = day_index * DAY_MS + 9 * 60 * 60 * 1000;
        CaptureActivityAggregate {
            day_index,
            app_name: app_name.to_string(),
            duration_ms: minutes * 60_000,
            capture_count: 2,
            first_ts,
            last_ts: first_ts + minutes * 60_000,
        }
    }

    fn expression(app_name: &str, input_text: &str) -> WorkImExpression {
        WorkImExpression {
            app_name: app_name.to_string(),
            input_text: input_text.to_string(),
        }
    }

    #[test]
    fn builds_today_totals_and_app_distribution() {
        let today = Utc::now().timestamp_millis() / DAY_MS;
        let response = build_response(
            vec![activity(today, "Code", 7), activity(today, "Browser", 1)],
            infer_work_mood(&[]),
            None,
            (today - 1) * DAY_MS,
            (today + 1) * DAY_MS,
            0,
        )
        .unwrap();

        assert_eq!(response.total_minutes, 8);
        assert_eq!(response.active_days, 1);
        assert_eq!(response.today.total_minutes, 8);
        assert_eq!(response.today.capture_count, 4);
        assert_eq!(response.today.apps[0].name, "Code");
        assert_eq!(response.today.apps[0].minutes, 7);
        assert_eq!(response.current_streak, 1);
        assert!(!response.today.mood.inferred);
    }

    #[test]
    fn measures_full_overnight_session_in_local_time() {
        let timezone_offset_ms = 8 * 60 * 60 * 1000;
        let local_midnight = 20_000 * DAY_MS - timezone_offset_ms;
        let timestamps = (0..=73)
            .map(|index| local_midnight - 60_000 + index * 5 * 60_000)
            .collect::<Vec<_>>();

        let metrics = build_achievement_metrics(
            &timestamps,
            local_midnight,
            local_midnight + DAY_MS,
            timezone_offset_ms,
        );

        assert_eq!(metrics.max_overnight_work_minutes, 360);
        assert!(metrics.longest_work_session_minutes >= 360);
    }

    #[test]
    fn five_minute_gap_is_continuous_but_larger_gap_interrupts_session() {
        let start = 20_000 * DAY_MS + 9 * 60 * 60 * 1000;
        let continuous = (0..=48)
            .map(|index| start + index * 5 * 60_000)
            .collect::<Vec<_>>();
        let continuous_metrics = build_achievement_metrics(&continuous, start, start + DAY_MS, 0);
        assert!(continuous_metrics.longest_work_session_minutes >= 240);

        let interrupted = continuous
            .into_iter()
            .map(|timestamp| {
                if timestamp > start + 60 * 60 * 1000 {
                    timestamp + 60_000
                } else {
                    timestamp
                }
            })
            .collect::<Vec<_>>();
        let interrupted_metrics = build_achievement_metrics(&interrupted, start, start + DAY_MS, 0);
        assert!(interrupted_metrics.longest_work_session_minutes < 240);
    }

    #[test]
    fn calculates_current_and_longest_streaks() {
        assert_eq!(streaks(&[10, 11, 13, 14, 15], 15), (3, 3));
        assert_eq!(streaks(&[10, 11, 13, 14, 15], 16), (0, 3));
        assert_eq!(streaks(&[], 16), (0, 0));
    }

    #[test]
    fn infers_focused_mood_from_user_im_expressions() {
        let mood = infer_work_mood(&[
            expression("飞书", "我正在排查这个问题，稍后同步结果"),
            expression("Slack", "我来跟进发布计划"),
        ]);

        assert!(mood.inferred);
        assert_eq!(mood.mood, Some(WorkMood::Focused));
        assert_eq!(mood.expression_count, 2);
        assert_eq!(mood.source_apps, vec!["Slack", "飞书"]);
    }

    #[test]
    fn strong_overload_expression_takes_priority() {
        let mood = infer_work_mood(&[
            expression("飞书", "我正在处理，也会继续推进"),
            expression("飞书", "任务太多，已经忙不过来了"),
        ]);

        assert_eq!(mood.mood, Some(WorkMood::Overloaded));
    }
}
