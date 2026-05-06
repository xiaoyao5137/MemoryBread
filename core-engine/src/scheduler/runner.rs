//! 定时任务调度运行器
//!
//! 每 30 秒轮询一次数据库，找出到期任务，通过 HTTP 调用 Python TaskExecutor。

use std::str::FromStr;
use std::sync::Arc;

use chrono::Utc;
use cron::Schedule;
use tokio::time::{interval, Duration};
use tracing::{error, info, warn};

use super::repo::TaskRepo;
use crate::storage::StorageManager;

const POLL_INTERVAL_SECS: u64 = 30;
const PYTHON_EXECUTOR_URL: &str = "http://127.0.0.1:7071/tasks/execute";

pub struct Scheduler {
    storage: StorageManager,
    client: reqwest::Client,
}

impl Scheduler {
    pub fn new(storage: StorageManager) -> Self {
        Self {
            storage,
            client: reqwest::Client::new(),
        }
    }

    /// 启动调度循环（在独立 tokio task 中运行）
    pub async fn run(self: Arc<Self>) {
        info!("定时任务调度器启动，轮询间隔 {}s", POLL_INTERVAL_SECS);
        let mut ticker = interval(Duration::from_secs(POLL_INTERVAL_SECS));

        loop {
            ticker.tick().await;
            if let Err(e) = self.tick().await {
                error!("调度器轮询异常: {e}");
            }
        }
    }

    async fn tick(&self) -> anyhow::Result<()> {
        let now_ms = Utc::now().timestamp_millis();
        let tasks = TaskRepo::list_enabled(&self.storage)?;

        for task in tasks {
            // 计算下次执行时间（如果 next_run_at 未设置则立即计算）
            let next_run = match task.next_run_at {
                Some(t) => t,
                None => {
                    let next = self.calc_next_run(&task.cron_expression)?;
                    TaskRepo::set_next_run(&self.storage, task.id, next)?;
                    next
                }
            };

            if now_ms >= next_run {
                info!("触发任务: id={}, name={}", task.id, task.name);

                // 异步触发，不阻塞调度循环
                let client = self.client.clone();
                let task_id = task.id;
                let cron_expr = task.cron_expression.clone();
                let storage = self.storage.clone();

                tokio::spawn(async move {
                    if let Err(e) = Self::trigger_task(&client, task_id).await {
                        error!("任务触发失败: id={task_id}, error={e}");
                    }
                    // 计算并更新下次执行时间
                    if let Ok(next) = Self::calc_next_run_static(&cron_expr) {
                        let _ = TaskRepo::set_next_run(&storage, task_id, next);
                        info!("任务 {task_id} 下次执行: {next}");
                    }
                });
            }
        }

        Ok(())
    }

    async fn trigger_task(client: &reqwest::Client, task_id: i64) -> anyhow::Result<()> {
        let resp = client
            .post(PYTHON_EXECUTOR_URL)
            .json(&serde_json::json!({ "task_id": task_id }))
            .timeout(std::time::Duration::from_secs(300)) // 最长等待5分钟
            .send()
            .await?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Python executor 返回错误: {body}");
        }
        Ok(())
    }

    fn calc_next_run(&self, cron_expr: &str) -> anyhow::Result<i64> {
        Self::calc_next_run_static(cron_expr)
    }

    fn calc_next_run_static(cron_expr: &str) -> anyhow::Result<i64> {
        let schedule = Schedule::from_str(cron_expr)
            .map_err(|e| anyhow::anyhow!("cron 表达式解析失败: {e}"))?;
        let next = schedule
            .upcoming(Utc)
            .next()
            .ok_or_else(|| anyhow::anyhow!("无法计算下次执行时间"))?;
        Ok(next.timestamp_millis())
    }
}
