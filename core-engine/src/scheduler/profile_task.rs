//! 用户画像分析定时任务
//!
//! 每日凌晨 2 点自动分析前一天的时间线数据，生成/更新用户画像。

use chrono::{Datelike, Duration, Utc, Weekday};
use memory_bread_ipc::{
    IpcRequest, IpcResponse, ProfileAnalysisRequest, ResultPayload, TaskRequest,
};
use tracing::{error, info};

use crate::storage::{models::NewUserProfile, StorageManager};

/// 画像分析任务执行器
pub struct ProfileAnalyzer {
    storage: StorageManager,
}

impl ProfileAnalyzer {
    pub fn new(storage: StorageManager) -> Self {
        Self { storage }
    }

    /// 执行每日画像分析
    ///
    /// 1. 查询前一天的时间线数据
    /// 2. 通过 IPC 调用 ai-sidecar 进行分析
    /// 3. 合并到现有画像（如果存在）
    /// 4. 保存到数据库
    pub async fn run_daily_analysis(&self) -> anyhow::Result<()> {
        info!("开始执行每日用户画像分析");

        let yesterday = Utc::now() - Duration::days(1);
        let start_date = yesterday.format("%Y-%m-%d").to_string();
        let end_date = start_date.clone();

        // 获取现有的最新画像（用于增量合并）
        let existing_profile = self
            .storage
            .get_latest_profile("daily")
            .ok()
            .flatten()
            .map(|p| p.content);

        // 构造 IPC 请求
        let request = IpcRequest::new(TaskRequest::ProfileAnalysis(ProfileAnalysisRequest {
            start_date: start_date.clone(),
            end_date: end_date.clone(),
            existing_profile,
        }));

        // 通过 IPC 调用 ai-sidecar
        let response = self.send_ipc_request(request).await?;

        // 解析结果
        if let Some(ResultPayload::ProfileAnalysis(result)) = response.result {
            // 保存到数据库
            let new_profile = NewUserProfile {
                snapshot_type: "daily".to_string(),
                snapshot_date: start_date,
                content: result.profile,
                is_system_generated: true,
            };

            let profile_id = self.storage.create_user_profile(&new_profile)?;
            info!("用户画像分析完成，已保存: id={}", profile_id);

            // 每周日生成周快照
            if yesterday.weekday() == Weekday::Sun {
                self.generate_weekly_snapshot().await?;
            }

            // 每月最后一天生成月快照
            let tomorrow = yesterday + Duration::days(1);
            if tomorrow.day() == 1 {
                self.generate_monthly_snapshot().await?;
            }

            Ok(())
        } else {
            anyhow::bail!("IPC 响应格式错误或分析失败");
        }
    }

    /// 生成周快照（汇总最近 7 天的 daily 画像）
    async fn generate_weekly_snapshot(&self) -> anyhow::Result<()> {
        info!("生成周快照");

        let end_date = Utc::now().format("%Y-%m-%d").to_string();
        let start_date = (Utc::now() - Duration::days(7))
            .format("%Y-%m-%d")
            .to_string();

        let request = IpcRequest::new(TaskRequest::ProfileAnalysis(ProfileAnalysisRequest {
            start_date: start_date.clone(),
            end_date: end_date.clone(),
            existing_profile: None,
        }));

        let response = self.send_ipc_request(request).await?;

        if let Some(ResultPayload::ProfileAnalysis(result)) = response.result {
            let new_profile = NewUserProfile {
                snapshot_type: "weekly".to_string(),
                snapshot_date: end_date,
                content: result.profile,
                is_system_generated: true,
            };
            self.storage.create_user_profile(&new_profile)?;
            info!("周快照生成完成");
        }

        Ok(())
    }

    /// 生成月快照（汇总最近 30 天的数据）
    async fn generate_monthly_snapshot(&self) -> anyhow::Result<()> {
        info!("生成月快照");

        let end_date = Utc::now().format("%Y-%m-%d").to_string();
        let start_date = (Utc::now() - Duration::days(30))
            .format("%Y-%m-%d")
            .to_string();

        let request = IpcRequest::new(TaskRequest::ProfileAnalysis(ProfileAnalysisRequest {
            start_date: start_date.clone(),
            end_date: end_date.clone(),
            existing_profile: None,
        }));

        let response = self.send_ipc_request(request).await?;

        if let Some(ResultPayload::ProfileAnalysis(result)) = response.result {
            let new_profile = NewUserProfile {
                snapshot_type: "monthly".to_string(),
                snapshot_date: end_date,
                content: result.profile,
                is_system_generated: true,
            };
            self.storage.create_user_profile(&new_profile)?;
            info!("月快照生成完成");
        }

        Ok(())
    }

    /// 发送 IPC 请求到 ai-sidecar
    async fn send_ipc_request(&self, request: IpcRequest) -> anyhow::Result<IpcResponse> {
        // TODO: 实现真实的 IPC 通信
        // 这里需要通过 Unix Domain Socket 或 TCP 与 ai-sidecar 通信
        // 暂时返回模拟响应
        error!("IPC 通信尚未实现，需要集成 memory_bread_ipc::Transport");
        anyhow::bail!("IPC 通信未实现")
    }
}
