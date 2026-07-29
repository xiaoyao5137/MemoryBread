import json
import sqlite3
import urllib.error

from scheduled_task_executor import NotificationDeliveryRejected, TaskExecutor


def _create_notification_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE notification_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            channel_type TEXT NOT NULL,
            webhook_url TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE task_notification_deliveries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            execution_id INTEGER NOT NULL,
            channel_id INTEGER NOT NULL,
            status TEXT NOT NULL,
            error_message TEXT,
            delivered_at INTEGER,
            created_at INTEGER NOT NULL,
            UNIQUE (execution_id, channel_id)
        );
        """
    )


def test_notification_payload_uses_channel_native_shape() -> None:
    task = {"id": 7, "name": "昨日工作日记"}

    feishu = TaskExecutor._notification_payload(
        channel_type="feishu",
        task=task,
        execution_id=21,
        result_text="完成两项交付",
        completed_at=1000,
    )
    wecom = TaskExecutor._notification_payload(
        channel_type="wecom",
        task=task,
        execution_id=21,
        result_text="完成两项交付",
        completed_at=1000,
    )
    generic = TaskExecutor._notification_payload(
        channel_type="webhook",
        task=task,
        execution_id=21,
        result_text="完成两项交付",
        completed_at=1000,
    )

    assert feishu["msg_type"] == "text"
    assert "昨日工作日记" in feishu["content"]["text"]
    assert wecom["msgtype"] == "text"
    assert generic["event"] == "memorybread.task.completed"
    assert generic["task"] == task
    assert (
        TaskExecutor._safe_delivery_error(NotificationDeliveryRejected())
        == "provider_rejected"
    )


def test_deliver_task_result_records_success_without_exposing_webhook(
    tmp_path,
) -> None:
    db_path = tmp_path / "notifications.db"
    conn = sqlite3.connect(db_path)
    _create_notification_tables(conn)
    conn.execute(
        """INSERT INTO notification_channels
             (name, channel_type, webhook_url, enabled, created_at, updated_at)
           VALUES ('项目群', 'feishu', 'https://secret.example/hook/token', 1, 1, 1)"""
    )
    conn.commit()

    executor = TaskExecutor(str(db_path))
    posted = []
    executor._post_notification = lambda url, payload, channel_type: posted.append(
        (url, payload, channel_type)
    )
    deliveries = executor._deliver_task_result(
        conn,
        {
            "id": 3,
            "name": "周记",
            "notification_channel_ids": [1],
        },
        execution_id=9,
        result_text="本周完成发布",
        completed_at=2000,
    )

    assert deliveries == [
        {"channel_id": 1, "channel_name": "项目群", "status": "success"}
    ]
    assert posted[0][0] == "https://secret.example/hook/token"
    assert posted[0][1]["msg_type"] == "text"
    assert posted[0][2] == "feishu"
    row = conn.execute(
        """SELECT status, error_message, delivered_at
           FROM task_notification_deliveries"""
    ).fetchone()
    assert row[0] == "success"
    assert row[1] is None
    assert row[2] is not None


def test_delivery_failure_does_not_persist_webhook_url(tmp_path) -> None:
    db_path = tmp_path / "notifications.db"
    conn = sqlite3.connect(db_path)
    _create_notification_tables(conn)
    webhook_url = "https://secret.example/hook/token"
    conn.execute(
        """INSERT INTO notification_channels
             (name, channel_type, webhook_url, enabled, created_at, updated_at)
           VALUES ('告警群', 'webhook', ?, 1, 1, 1)""",
        (webhook_url,),
    )
    conn.commit()

    executor = TaskExecutor(str(db_path))

    def fail_delivery(_url, _payload, _channel_type):
        raise urllib.error.URLError("secret.example")

    executor._post_notification = fail_delivery
    deliveries = executor._deliver_task_result(
        conn,
        {
            "id": 4,
            "name": "日报",
            "notification_channel_ids": [1],
        },
        execution_id=10,
        result_text="日报内容",
        completed_at=3000,
    )

    assert deliveries[0]["status"] == "failed"
    assert deliveries[0]["error_message"] == "connection_error"
    stored_error = conn.execute(
        "SELECT error_message FROM task_notification_deliveries"
    ).fetchone()[0]
    assert stored_error == "connection_error"
    assert webhook_url not in json.dumps(deliveries, ensure_ascii=False)


def test_get_task_remains_compatible_with_old_schema(tmp_path) -> None:
    db_path = tmp_path / "old.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """CREATE TABLE scheduled_tasks (
             id INTEGER PRIMARY KEY,
             name TEXT NOT NULL,
             user_instruction TEXT NOT NULL,
             cron_expression TEXT NOT NULL,
             template_id TEXT
           )"""
    )
    conn.execute(
        """INSERT INTO scheduled_tasks
             (id, name, user_instruction, cron_expression, template_id)
           VALUES (1, '旧任务', '生成摘要', '0 9 * * *', NULL)"""
    )

    task = TaskExecutor(str(db_path))._get_task(conn, 1)

    assert task is not None
    assert task["notification_channel_ids"] == []
