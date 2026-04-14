"""
闲时检测器 v2.0

检测逻辑：
1. CPU 使用率 < 20%（持续 1 分钟）
2. 内存使用率 < 70%（持续 1 分钟）
3. 笔记本需在充电
4. 距离上次执行 > 1 小时（可配置）
"""

import time
import psutil
import logging
from datetime import datetime, timedelta
from typing import Optional

logger = logging.getLogger(__name__)


class IdleDetector:
    """系统资源闲时检测器（不依赖用户行为）"""

    def __init__(
        self,
        cpu_threshold: float = 20.0,      # CPU 阈值 20%
        memory_threshold: float = 70.0,   # 内存阈值 70%
        stable_duration: int = 60,        # 稳定持续时间 60 秒
        min_interval: int = 3600,         # 最小执行间隔 1 小时
        require_power: bool = True,       # 是否要求充电
    ):
        self.cpu_threshold = cpu_threshold
        self.memory_threshold = memory_threshold
        self.stable_duration = stable_duration
        self.min_interval = min_interval
        self.require_power = require_power

        # 状态追踪
        self._last_execution_time: Optional[datetime] = None
        self._stable_start_time: Optional[float] = None

    # ── 公共接口 ──────────────────────────────────────────────────────

    def is_idle(self) -> bool:
        """
        判断系统是否处于闲时。

        Returns:
            True: 可以执行闲时任务
            False: 不满足条件
        """
        # 1. 检查执行间隔（1 小时内已执行过）
        if not self._check_execution_interval():
            return False

        # 2. 检查系统资源状态
        if not self._check_resource_state():
            # 资源不满足，重置稳定计时器
            self._reset_stable_timer()
            return False

        # 3. 检查稳定持续时间（1 分钟）
        if not self._check_stable_duration():
            return False

        logger.info("系统进入闲时状态，可执行闲时任务")
        return True

    def mark_execution(self) -> None:
        """标记闲时任务已执行（更新最后执行时间）"""
        self._last_execution_time = datetime.now()
        self._reset_stable_timer()
        logger.info(
            "闲时任务执行完成，下次执行时间: %s",
            self._last_execution_time + timedelta(seconds=self.min_interval)
        )

    def get_time_until_next_execution(self) -> int:
        """获取距离下次执行的秒数"""
        if self._last_execution_time is None:
            return 0  # 从未执行过，立即可执行

        next_time = self._last_execution_time + timedelta(seconds=self.min_interval)
        delta = (next_time - datetime.now()).total_seconds()
        return max(0, int(delta))

    # ── 内部检查方法 ──────────────────────────────────────────────────

    def _check_execution_interval(self) -> bool:
        """检查距离上次执行是否超过最小间隔"""
        if self._last_execution_time is None:
            return True  # 从未执行过

        elapsed = (datetime.now() - self._last_execution_time).total_seconds()
        if elapsed < self.min_interval:
            logger.debug(
                "距离上次执行仅 %.0f 秒，需等待 %.0f 秒",
                elapsed,
                self.min_interval - elapsed
            )
            return False

        return True

    def _check_resource_state(self) -> bool:
        """检查系统资源状态（CPU + 内存 + 充电）"""
        # 1. 检查 CPU 使用率（非阻塞采样，避免每次检测都卡 1 秒）
        cpu_usage = psutil.cpu_percent(interval=None)
        if cpu_usage > self.cpu_threshold:
            logger.debug("CPU 使用率过高: %.1f%% > %.1f%%",
                        cpu_usage, self.cpu_threshold)
            return False

        # 2. 检查内存使用率
        memory = psutil.virtual_memory()
        if memory.percent > self.memory_threshold:
            logger.debug("内存使用率过高: %.1f%% > %.1f%%",
                        memory.percent, self.memory_threshold)
            return False

        # 3. 检查是否在充电（笔记本）
        if self.require_power and not self._is_on_power():
            logger.debug("笔记本未充电，跳过闲时任务")
            return False

        logger.debug(
            "资源状态良好: CPU %.1f%%, 内存 %.1f%%",
            cpu_usage,
            memory.percent
        )
        return True

    def _check_stable_duration(self) -> bool:
        """检查资源状态是否稳定持续 1 分钟"""
        current_time = time.monotonic()

        # 首次进入稳定状态
        if self._stable_start_time is None:
            self._stable_start_time = current_time
            logger.debug("资源状态开始稳定，计时开始")
            return False

        # 计算已稳定时长
        stable_elapsed = current_time - self._stable_start_time

        if stable_elapsed < self.stable_duration:
            logger.debug(
                "资源状态稳定中: %.0f/%.0f 秒",
                stable_elapsed,
                self.stable_duration
            )
            return False

        # 已稳定超过 1 分钟
        logger.info("资源状态已稳定 %.0f 秒，满足闲时条件", stable_elapsed)
        return True

    def _reset_stable_timer(self) -> None:
        """重置稳定计时器"""
        self._stable_start_time = None

    def _is_on_power(self) -> bool:
        """检查是否在充电（笔记本）"""
        try:
            battery = psutil.sensors_battery()
            if battery is None:
                # 台式机，无电池
                return True
            return battery.power_plugged
        except Exception as e:
            logger.warning("无法检测充电状态: %s", e)
            return True  # 检测失败，默认允许执行

    # ── 状态查询 ──────────────────────────────────────────────────────

    def get_status(self) -> dict:
        """获取当前状态（用于调试和监控）"""
        cpu_usage = psutil.cpu_percent(interval=0)
        memory = psutil.virtual_memory()
        battery = psutil.sensors_battery()

        stable_elapsed = 0
        if self._stable_start_time is not None:
            stable_elapsed = time.monotonic() - self._stable_start_time

        return {
            "cpu_usage": cpu_usage,
            "cpu_ok": cpu_usage < self.cpu_threshold,
            "memory_usage": memory.percent,
            "memory_ok": memory.percent < self.memory_threshold,
            "on_power": battery.power_plugged if battery else True,
            "stable_elapsed": stable_elapsed,
            "stable_required": self.stable_duration,
            "time_until_next": self.get_time_until_next_execution(),
            "can_execute": self.is_idle(),
        }
