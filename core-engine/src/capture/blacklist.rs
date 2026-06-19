/// 应用黑名单检测模块
///
/// 提供快速的应用黑名单检测，支持内存缓存和定期刷新
use std::collections::HashSet;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tracing::{debug, info};

use crate::storage::repo::privacy;
use crate::storage::StorageManager;

/// 黑名单缓存刷新间隔（30 秒）
const CACHE_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

/// 应用黑名单检测器
#[derive(Clone)]
pub struct BlacklistChecker {
    storage: StorageManager,
    cache: Arc<RwLock<BlacklistCache>>,
}

struct BlacklistCache {
    bundle_ids: HashSet<String>,
    last_refresh: Instant,
}

impl BlacklistChecker {
    /// 创建新的黑名单检测器
    pub fn new(storage: StorageManager) -> Self {
        let checker = Self {
            storage,
            cache: Arc::new(RwLock::new(BlacklistCache {
                bundle_ids: HashSet::new(),
                last_refresh: Instant::now() - CACHE_REFRESH_INTERVAL, // 强制首次加载
            })),
        };

        // 立即加载一次
        if let Err(e) = checker.refresh_cache() {
            tracing::warn!("初始化黑名单缓存失败: {}", e);
        }

        checker
    }

    /// 检查指定 Bundle ID 是否在黑名单中
    pub fn is_blacklisted(&self, bundle_id: &str) -> bool {
        // 检查是否需要刷新缓存
        {
            let cache = self.cache.read().unwrap();
            if cache.last_refresh.elapsed() > CACHE_REFRESH_INTERVAL {
                drop(cache); // 释放读锁
                if let Err(e) = self.refresh_cache() {
                    tracing::warn!("刷新黑名单缓存失败: {}", e);
                }
            }
        }

        // 查询缓存
        let cache = self.cache.read().unwrap();
        cache.bundle_ids.contains(bundle_id)
    }

    /// 从数据库刷新缓存
    fn refresh_cache(&self) -> Result<(), Box<dyn std::error::Error>> {
        let bundle_ids = self
            .storage
            .with_conn(|conn| privacy::get_enabled_blacklist_bundle_ids(conn))?;

        let mut cache = self.cache.write().unwrap();
        cache.bundle_ids = bundle_ids;
        cache.last_refresh = Instant::now();

        debug!("黑名单缓存已刷新，共 {} 个应用", cache.bundle_ids.len());
        Ok(())
    }

    /// 手动刷新缓存（用于配置更新后立即生效）
    pub fn force_refresh(&self) -> Result<(), Box<dyn std::error::Error>> {
        self.refresh_cache()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::StorageManager;

    #[test]
    fn test_blacklist_checker() {
        let storage = StorageManager::open_in_memory().unwrap();

        let checker = BlacklistChecker::new(storage);

        // 测试预置黑名单
        assert!(checker.is_blacklisted("com.tencent.xinWeChat"));
        assert!(checker.is_blacklisted("com.tencent.qq"));
        assert!(!checker.is_blacklisted("com.google.Chrome"));
    }
}
