"""
启动前置检查 - 确保必要的模型已安装
"""

import logging
import sqlite3
import sys
from pathlib import Path

from model_manager import ModelManager

logger = logging.getLogger(__name__)
_model_manager = ModelManager()


def get_ollama_setup_detail() -> dict:
    try:
        return _model_manager.get_ollama_setup_status()
    except Exception as exc:
        logger.error(f"获取 Ollama 安装状态失败: {exc}")
        return {
            'ollama_installed': False,
            'ollama_running': False,
            'message': f'获取 Ollama 状态失败: {exc}',
            'recommended_install_method': 'brew install ollama',
        }


def check_ollama_installed() -> bool:
    """检查 Ollama 是否已安装"""
    detail = get_ollama_setup_detail()
    return bool(detail.get('ollama_installed'))


def check_ollama_running() -> bool:
    """检查 Ollama 服务是否运行"""
    detail = get_ollama_setup_detail()
    return bool(detail.get('ollama_running'))


def check_model_available(model_name: str = "qwen2.5:3b") -> bool:
    """检查指定模型是否已下载"""
    try:
        from ollama import Client
        client = Client()
        models = client.list()

        # 检查模型列表
        for model in models.get('models', []):
            # ollama 客户端返回的是对象，直接访问 model 属性
            if hasattr(model, 'model') and model.model == model_name:
                return True
        return False
    except Exception:
        return False


def check_embedding_model() -> bool:
    """检查向量模型是否可用"""
    try:
        from embedding.model import EmbeddingModel
        model = EmbeddingModel.create_default()
        # 测试编码
        model.encode(["测试"])
        return True
    except Exception as e:
        logger.error(f"向量模型检查失败: {e}")
        return False


def check_knowledge_fts() -> bool:
    """检查 knowledge_fts 表是否存在"""
    try:
        db_path = Path.home() / ".memory-bread" / "memory-bread.db"
        if not db_path.exists():
            return False
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'")
        exists = cursor.fetchone() is not None
        conn.close()
        return exists
    except Exception as e:
        logger.error(f"检查 knowledge_fts 失败: {e}")
        return False


def init_knowledge_fts() -> bool:
    """初始化 knowledge_fts 表"""
    try:
        db_path = Path.home() / ".memory-bread" / "memory-bread.db"
        conn = sqlite3.connect(str(db_path))
        cursor = conn.cursor()
        cursor.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
                summary, entities, content='timelines', content_rowid='id'
            )
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON timelines BEGIN
                INSERT INTO knowledge_fts(rowid, summary, entities) VALUES (new.id, new.summary, new.entities);
            END
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON timelines BEGIN
                UPDATE knowledge_fts SET summary = new.summary, entities = new.entities WHERE rowid = new.id;
            END
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON timelines BEGIN
                DELETE FROM knowledge_fts WHERE rowid = old.id;
            END
        """)
        cursor.execute("INSERT INTO knowledge_fts(rowid, summary, entities) SELECT id, summary, entities FROM timelines")
        conn.commit()
        conn.close()
        return True
    except Exception as e:
        logger.error(f"初始化 knowledge_fts 失败: {e}")
        return False


def run_startup_checks() -> bool:
    """
    运行启动前置检查

    Returns:
        True 如果所有检查通过，False 否则
    """
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("🔍 记忆面包启动前置检查")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print()

    all_passed = True

    ollama_detail = get_ollama_setup_detail()

    # 1. 检查 Ollama 安装
    print("1️⃣  检查 Ollama 安装...")
    if check_ollama_installed():
        print("   ✅ Ollama 已安装")
        if ollama_detail.get('ollama_path'):
            print(f"   ℹ️  路径: {ollama_detail.get('ollama_path')}")
    else:
        print("   ❌ Ollama 未安装")
        print(f"   📝 {ollama_detail.get('message', '请安装 Ollama')}")
        print(f"   📝 安装方法：{ollama_detail.get('recommended_install_method', 'brew install ollama')}")
        all_passed = False

    print()

    # 2. 检查 Ollama 服务
    print("2️⃣  检查 Ollama 服务...")
    if check_ollama_running():
        print("   ✅ Ollama 服务运行中")
    else:
        print("   ❌ Ollama 服务未运行")
        print("   📝 启动方法：ollama serve")
        all_passed = False

    print()

    # 3. 检查推理模型
    print("3️⃣  检查推理模型 (qwen2.5:3b)...")
    if check_model_available("qwen2.5:3b"):
        print("   ✅ 推理模型已下载")
    else:
        print("   ❌ 推理模型未下载")
        print("   📝 下载方法：ollama pull qwen2.5:3b")
        all_passed = False

    print()

    # 4. 检查向量模型
    print("4️⃣  检查向量模型 (BGE-M3)...")
    if check_embedding_model():
        print("   ✅ 向量模型已加载")
    else:
        print("   ❌ 向量模型未加载")
        print("   📝 模型会自动下载，请检查网络连接")
        all_passed = False

    print()

    # 5. 检查 knowledge_fts 表
    print("5️⃣  检查知识库全文索引...")
    if check_knowledge_fts():
        print("   ✅ knowledge_fts 表已创建")
    else:
        print("   ⚠️  knowledge_fts 表不存在，正在初始化...")
        if init_knowledge_fts():
            print("   ✅ knowledge_fts 表初始化成功")
        else:
            print("   ❌ knowledge_fts 表初始化失败")
            all_passed = False

    print()
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

    if all_passed:
        print("✅ 所有检查通过，可以启动记忆面包")
    else:
        print("❌ 部分检查未通过，请先完成上述配置")
        print()
        print("📚 快速配置指南：")
        print(f"   1. 安装 Ollama: {ollama_detail.get('recommended_install_method', 'brew install ollama')}")
        print("   2. 启动 Ollama: ollama serve &")
        print("   3. 下载模型: ollama pull qwen2.5:3b")
        print("   4. 或在安装引导/模型页面点击“检测并安装 Ollama”")
        print("   5. 重新启动记忆面包")

    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print()

    return all_passed


if __name__ == "__main__":
    if not run_startup_checks():
        sys.exit(1)
