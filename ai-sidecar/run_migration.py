#!/usr/bin/env python3

from __future__ import annotations

"""
执行数据库迁移脚本
"""

import sqlite3
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def run_migration():
    """执行 004 迁移"""
    db_path = Path.home() / ".memory-bread" / "memory-bread.db"
    migration_file = Path(__file__).parent / "migrations" / "004_add_overview_details.sql"

    if not db_path.exists():
        logger.error(f"数据库不存在: {db_path}")
        return False

    if not migration_file.exists():
        logger.error(f"迁移文件不存在: {migration_file}")
        return False

    logger.info(f"开始执行迁移: {migration_file.name}")
    logger.info(f"数据库: {db_path}")

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        # 读取迁移 SQL
        with open(migration_file, 'r', encoding='utf-8') as f:
            migration_sql = f.read()

        # 执行迁移
        cursor.executescript(migration_sql)
        conn.commit()

        logger.info("✅ 迁移执行成功")

        # 验证新字段
        cursor.execute("PRAGMA table_info(knowledge_entries)")
        columns = [row[1] for row in cursor.fetchall()]
        logger.info(f"当前字段: {columns}")

        if 'overview' in columns and 'details' in columns:
            logger.info("✅ 新字段已添加")
        else:
            logger.warning("⚠️ 新字段未找到")

        conn.close()
        return True

    except Exception as e:
        logger.error(f"❌ 迁移失败: {e}")
        return False


if __name__ == '__main__':
    success = run_migration()
    exit(0 if success else 1)
