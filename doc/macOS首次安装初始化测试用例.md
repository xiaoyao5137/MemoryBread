# macOS 首次安装初始化测试用例

更新日期：2026-07-19

## 测试目标

验证用户从 DMG 安装并首次打开记忆面包后，即使本机没有本地运行环境、文本分析模型或向量模型，也能获得明确且可继续操作的引导，并且只有在模型真正下载和启用后才能完成配置。

初始化完成的验收条件：

1. 内置 sidecar 冷启动较慢时，页面会自动重试，不要求用户立即手动刷新。
2. 未安装本地运行环境时，有 Homebrew 可自动安装并启动；没有 Homebrew 可打开官方 macOS 下载页。
3. macOS 低于本地运行环境当前最低要求时，明确提示升级系统，不执行不可能成功的自动安装。
4. 文本分析模型未安装时不能进入下一步；向量模型未安装时不能完成配置。
5. 下载或启用失败会结束进度状态、显示可理解的错误，并允许重试。
6. 文本模型与向量模型都已启用后才写入 `memory-bread_setup_done=true`。
7. 用户可以明确选择“跳过，稍后配置”，并写入独立的 `memory-bread_setup_skipped=true` 标记。

## 自动化覆盖

### 前端组件与首次启动

```bash
cd desktop-ui
npm test -- --run \
  src/__tests__/OnboardingWizard.test.tsx \
  src/__tests__/AppAuthEntry.test.tsx
npm run build
```

覆盖以下场景：

| 用例 | 自动化断言 |
| --- | --- |
| UI-INIT-001 | 没有完成或跳过标记时显示首次配置引导 |
| UI-INIT-002 | sidecar 首次连接失败后每 1.5 秒自动重试，最多 10 次 |
| UI-OLLAMA-001 | 无 Homebrew 时显示官方下载入口和返回后重新检测说明 |
| UI-OLLAMA-002 | 有 Homebrew 时依次调用安装、启动和重新检测 |
| UI-LLM-001 | 文本模型未安装时“下一步”禁用，下载完成后才启用 |
| UI-EMBED-001 | 向量模型未安装时“完成配置”禁用，下载完成后才启用 |
| UI-MODEL-ERR-001 | 下载失败时停止轮询、保留当前步骤并显示错误 |
| UI-MODEL-ERR-002 | 模型启用失败时不进入下一步 |
| UI-PERSIST-001 | 完成配置后保存完成标记 |
| UI-PERSIST-002 | 主动跳过后保存跳过标记 |

### sidecar 状态与模型下载

```bash
cd ai-sidecar
PYTHONPATH="../shared/ipc-protocol/python${PYTHONPATH:+:$PYTHONPATH}" \
  .venv/bin/python -m pytest -q \
  tests/test_model_setup.py \
  tests/test_startup_model_checks.py
```

覆盖以下场景：

| 用例 | 自动化断言 |
| --- | --- |
| API-OLLAMA-001 | macOS 14、无 Ollama、无 Homebrew 时返回官方安装页和手动安装阶段 |
| API-OLLAMA-002 | macOS 13 不满足当前最低版本，不允许自动安装 |
| API-OLLAMA-003 | CLI 不在 PATH 但 Ollama API 已运行时仍判断为就绪 |
| API-MODEL-001 | 文本模型下载使用服务端内部映射，不向前端暴露底层模型名 |
| API-MODEL-002 | 向量模型下载使用服务端内部映射 |
| API-MODEL-ERR-001 | 下载传输失败转换为终态 `error`，不再永久停留在下载中 |
| STARTUP-001 | Ollama 缺失时核心检查失败 |
| STARTUP-002 | 文本模型缺失时核心检查失败 |
| STARTUP-003 | 仅向量模型缺失时核心能力可降级启动，但初始化仍需用户完成配置 |
| STARTUP-004 | Ollama、文本模型和向量模型均可用时全部检查通过 |

## DMG 人工验收

人工验收应在干净 macOS 虚拟机、专用测试 Mac 或专用 macOS 用户中执行。不要为了模拟“未安装”而删除开发者日常使用的 Ollama、Homebrew 或模型。

### 准备测试包

```bash
cd desktop-ui
npm run macos:build:dmg
```

安装前记录：

- DMG 绝对路径、版本号、目标架构和签名方式。
- 测试机 macOS 版本、芯片、内存和可用磁盘。
- 是否安装 Homebrew、是否安装/运行 Ollama、两个模型是否已存在。

将 App 从 DMG 拖到 `/Applications`，从 Finder 的 Applications 中启动，不要从源码或 `npm run tauri:dev` 启动。

### 用例矩阵

| ID | 前置条件 | 操作 | 预期结果 |
| --- | --- | --- | --- |
| DMG-INIT-001 | 新测试用户，无初始化标记 | 首次打开 App | 显示“欢迎使用记忆面包”和硬件检测；默认不开始屏幕采集 |
| DMG-INIT-002 | 首次启动时内置服务尚未监听 7071 | 打开 App 后等待 15 秒 | 页面自动恢复本地运行环境状态；不需要重启 App |
| DMG-OS-001 | macOS 13 | 进入本地分析模型步骤 | 提示需要 macOS 14 或更高版本；不出现自动安装按钮 |
| DMG-OLLAMA-001 | macOS 14+，无 Ollama，无 Homebrew | 进入本地分析模型步骤，点击“打开官方下载页” | 默认浏览器打开 `https://ollama.com/download/mac`；页面提示安装并打开后返回重新检测 |
| DMG-OLLAMA-002 | macOS 14+，无 Ollama，有 Homebrew | 点击“自动安装并启动” | 安装过程结束后显示“本地运行环境已就绪”；失败时保留当前步骤和可重试提示 |
| DMG-OLLAMA-003 | 已安装 Ollama，但服务未运行 | 点击“启动本地运行环境” | 服务启动并通过重新检测；不重复下载 Ollama |
| DMG-LLM-001 | Ollama 正常，文本模型未安装 | 选择 MBEM v1.0 | “下一步”保持禁用，显示下载按钮和模型大小 |
| DMG-LLM-002 | 同上，网络正常 | 下载文本模型并等待完成 | 显示进度；完成并启用后“下一步”可点击 |
| DMG-EMBED-001 | 文本模型已启用，向量模型未安装 | 进入语义索引步骤并选择模型 | “完成配置”保持禁用，显示向量模型下载按钮 |
| DMG-EMBED-002 | 同上，网络正常 | 下载向量模型并等待完成 | 下载完成并启用后才能完成配置 |
| DMG-ERR-001 | 任一模型下载中 | 暂时断开网络或让模型服务返回错误 | 进度停止并显示错误；恢复网络后可重新下载，不出现无限轮询 |
| DMG-PERSIST-001 | 两个模型均启用 | 完成配置，退出并重新打开 App | 不再显示首次引导，主界面可使用本地问答/检索 |
| DMG-PERSIST-002 | 新测试用户 | 点击“跳过，稍后配置”，退出并重新打开 | 不重复强制弹出引导；可从“模型”页面继续安装本地运行环境和模型 |
| DMG-BUNDLE-001 | 使用生成的 `.app` | 退出源码和开发服务后启动 App | core、sidecar、model API 由包内 helper 启动；App 退出后其受管子进程退出 |

### 每个用例保留的证据

- 测试机环境与前置状态截图。
- 引导关键页面、下载进度、错误提示和完成状态截图。
- `~/Library/Application Support/com.memory-bread.app/runtime/.memory-bread/logs/` 下对应时段的日志。
- 实际结果、是否通过、缺陷编号和复测结果。

## 发布门禁

满足以下条件后，首次安装初始化链路才可判定通过：

- 上述前端和 sidecar 自动化测试全部通过。
- `npm run build` 通过。
- 目标发布 DMG 通过 `scripts/verify-macos-bundle.sh`。
- DMG 人工用例不存在阻断安装、无限等待、无下一步入口或错误完成初始化的问题。
- 至少在一台没有源码和项目虚拟环境的干净 Mac 上完成一次文本模型与向量模型的真实下载。
