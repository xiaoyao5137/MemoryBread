# 记忆面包 macOS 发布与 Mac App Store 上架指南

更新日期：2026-07-19

## 先分清两个产物

| 产物 | 用途 | 签名方式 | 是否上传 App Store Connect |
| --- | --- | --- | --- |
| `.dmg` | 官网、内测或其他站外渠道 | Developer ID Application + Apple 公证 | 否 |
| `.pkg` | Mac App Store | Apple Distribution/Mac App Distribution + Mac Installer Distribution | 是 |

DMG 不能直接上传到 Mac App Store。App Store 流程是先构建沙盒化 `.app`，再生成签名 `.pkg` 并上传。

本仓库已实现两条独立链路：

- `npm run macos:build:dmg`：生成站外分发的 `.app` 和 `.dmg`。
- `npm run macos:build:appstore`：生成启用 App Sandbox 的 `.app` 和 App Store `.pkg`。
- `npm run macos:verify -- /绝对路径/记忆面包.app appstore`：复验 bundle 结构、签名和沙盒 entitlement。
- `../scripts/upload-macos-appstore.sh /绝对路径/记忆面包.pkg`：验证并上传 `.pkg`。

## 包内结构与运行方式

发布包不再调用源码仓库的 `start.sh`，也不依赖用户电脑上的 Python 虚拟环境：

- Tauri 主程序位于 `Contents/MacOS/memory-bread-desktop`。
- Rust core 位于 `Contents/MacOS/memory-bread-core`。
- Python/AI 服务由 PyInstaller 冻结为 `Contents/Helpers/memory-bread-ai.app`。
- App 启动后拉起 sidecar、model API、creation 和 core 四个受管子进程，退出时只回收自己启动的进程。
- 发布版数据写入 App 自己的 Application Support/runtime 目录；App Store 版因此能在 App Sandbox 容器内工作。
- 首次安装默认不采集屏幕，用户主动开启后才请求系统“屏幕与系统音频录制”权限。
- App Store 版禁用了基于 LaunchAgent 的“登录时启动”；后续如要恢复，应改用 `SMAppService` 并重新送审。

当前脚本按构建机架构产出单架构包。本机是 Apple silicon，因此产物为 `arm64`，最低系统版本是 macOS 12。Intel 版应在 x86_64 Mac/Python 环境单独构建；不要用 arm64 Python 交叉冻结 x86_64 AI helper。

## 一、准备 Apple 开发者账号

1. 给 Apple Account 开启双重认证，加入 [Apple Developer Program](https://developer.apple.com/programs/enroll/)。年费目前为 99 美元或当地等值金额。
2. 个人账号上架时显示个人法定姓名。公司主体应选择 Organization；Apple 会核验法定实体、D‑U‑N‑S Number、工作邮箱、官网和签约权限。
3. 在 App Store Connect 的 Business 中接受最新协议。若应用收费或使用 IAP，还要完成税务和收款账户。
4. 安装完整 Xcode，不能只有 Command Line Tools：

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
xcodebuild -version
```

## 二、创建 Identifier、证书和 profile

在 [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/) 中完成：

1. 创建 macOS App ID，Bundle ID 必须与仓库一致：`com.memory-bread.app`。创建 App Store Connect 记录后不要再改这个 ID。
2. 创建或下载 App 签名证书。现代账号可使用 `Apple Distribution`；已有老式证书也可使用 `Mac App Distribution` / `3rd Party Mac Developer Application`。
3. 创建 `Mac Installer Distribution` 证书，用于给最终 `.pkg` 签名。
4. 为 `com.memory-bread.app` 创建类型为 `Mac App Store Connect` 的 Distribution provisioning profile，下载到本机。
5. 双击证书安装到登录钥匙串，并确认本机同时拥有证书和私钥：

```bash
security find-identity -v -p codesigning
security find-identity -v
```

脚本会解码 profile，核对 Team ID 和 `TEAM_ID.com.memory-bread.app`，不匹配时会在构建前失败。证书、profile、`.p8` 私钥均不得提交到 Git。

## 三、先构建站外 DMG

### 本机功能测试包

```bash
cd desktop-ui
npm run macos:build:dmg
```

未配置 Developer ID 时脚本会使用 ad-hoc 签名。这种 DMG 只适合本机验证，不能直接公开分发。Apple silicon 默认输出：

```text
desktop-ui/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/记忆面包_0.1.0_aarch64.dmg
```

### 可公开下载的签名与公证 DMG

先创建 `Developer ID Application` 证书，再创建 App Store Connect API Key。Tauri 会在构建中完成签名、公证和 staple：

```bash
export APPLE_SIGNING_IDENTITY='Developer ID Application: 你的公司名 (TEAMID)'
export APPLE_API_ISSUER='App Store Connect API Issuer ID'
export APPLE_API_KEY='API Key ID'
export APPLE_API_KEY_PATH='/绝对路径/AuthKey_APIKEYID.p8'

cd desktop-ui
npm run macos:build:dmg
```

发布前再执行：

```bash
codesign --verify --deep --strict --verbose=2 '/路径/记忆面包.app'
spctl --assess --type execute --verbose=4 '/路径/记忆面包.app'
xcrun stapler validate '/路径/记忆面包.app'
xcrun stapler validate '/路径/记忆面包.dmg'
```

## 四、构建 Mac App Store PKG

从上面的 `security find-identity` 输出复制完整证书名称，然后执行：

```bash
export APPLE_TEAM_ID='10位TEAMID'
export APPLE_PROVISIONING_PROFILE='/绝对路径/MemoryBread_Mac_App_Store.provisionprofile'
export APPLE_APP_SIGNING_IDENTITY='Apple Distribution: 你的公司名 (TEAMID)'
export APPLE_INSTALLER_SIGNING_IDENTITY='Mac Installer Distribution: 你的公司名 (TEAMID)'

cd desktop-ui
npm run macos:build:appstore
```

如果钥匙串显示的是旧式证书名，直接把实际完整名称填入对应变量即可。脚本将：

1. 冻结 Python helper 并构建 Rust core。
2. 使用 App Store 专用 Tauri feature，禁用 LaunchAgent 自动启动。
3. 嵌入 provisioning profile。
4. 为主 App 启用 App Sandbox、network client/server entitlement。
5. 为 core 和嵌套 AI helper 添加 sandbox inherit entitlement，并按由内到外的顺序签名。
6. 复验签名和 entitlement。
7. 用 `productbuild` 生成并验证签名 `.pkg`。

默认输出目录：

```text
desktop-ui/src-tauri/target/macos-package/appstore/
```

每次正式发布前更新：

- `desktop-ui/src-tauri/tauri.conf.json` 的 `version`，当前同时用于营销版本和构建号。
- Apple 已成功处理过某个 build 后，替换它必须使用更高的构建号。当前配置未拆分两个版本字段，因此请把项目版本整体递增后重建；上传本身失败时，Apple 允许修复后复用同一构建号。

## 五、创建 App Store Connect 记录

必须先创建记录，再上传二进制：

1. 登录 [App Store Connect](https://appstoreconnect.apple.com/)，进入 Apps，点击 `+` → New App。
2. 平台选择 macOS；填写名称、主语言、Bundle ID `com.memory-bread.app` 和内部 SKU。
3. Primary Category 选择 Productivity，与包内 category 保持一致。
4. 填写描述、关键词、Support URL、Privacy Policy URL、版权、价格和销售区域。
5. 上传 macOS 截图。Apple 当前接受 16:10 的 1280×800、1440×900、2560×1600 或 2880×1800，Mac App 必须有截图。
6. 完成年龄分级、内容版权、App Privacy、出口合规、欧盟 DSA trader 等适用项目。

隐私标签必须按真实网络行为填写，而不能只按“本地优先”的产品定位填写。需要逐项确认登录标识、诊断/使用数据、用户内容、截图/OCR 文本以及发送给云端模型的提示词是否离开设备、是否关联用户、是否用于追踪。

## 六、上传 PKG

在 App Store Connect 的 Users and Access → Integrations 创建 API Key，记下 Key ID 和 Issuer ID。把私钥放到 `altool` 识别的位置：

```bash
cd /你的路径/MemoryBread
mkdir -p "$HOME/.appstoreconnect/private_keys"
cp '/下载位置/AuthKey_ABC123XYZ.p8' \
  "$HOME/.appstoreconnect/private_keys/AuthKey_ABC123XYZ.p8"

export APPLE_API_KEY_ID='ABC123XYZ'
export APPLE_API_ISSUER='xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'

./scripts/upload-macos-appstore.sh \
  '/绝对路径/记忆面包_0.1.0_aarch64.pkg'
```

也可以使用 Apple Transporter 上传。上传完成后需要等待 Apple 处理，随后才能在 TestFlight 或版本页面选择该 build。

## 七、TestFlight 与送审

1. 在 TestFlight 建内部测试组，至少在一台没有源码、没有项目虚拟环境的干净 Mac 上安装。
2. 验证首次启动、退出重启、屏幕录制拒绝/允许、睡眠唤醒、数据库迁移、云端不可用、无 Ollama 等路径。
   首次安装、本地运行环境以及文本/向量模型的完整矩阵见
   [`macOS首次安装初始化测试用例.md`](macOS首次安装初始化测试用例.md)。
3. 在版本页选择处理完成的 build，补齐所有 metadata。
4. App Review Information 中提供可长期使用的审核账号或完整 demo mode、联系人和测试步骤；审核期间后端必须可访问。
5. Review Notes 建议明确说明：
   - 应用默认不截屏，用户从设置主动开启后才请求系统权限。
   - 截图、OCR 和本地记忆的保存位置、删除入口以及何时会发送到云端。
   - 菜单栏入口、主窗口打开方式和主要功能测试路径。
   - 本地服务只监听 `127.0.0.1`，均随 App 启停。
   - 审核账号已具备可用云端额度；若本地模型不是审核前置条件，要明确给出云端测试路径。
6. 点击 Add for Review，再在提交页点击 Submit for Review。可选择人工发布、审核通过自动发布或定时发布。

## 本项目送审前必须做的三个产品决定

### 1. Ollama 不是当前安装包的一部分

包中已经包含 Rust core 和 Python AI 运行时，但没有捆绑 Ollama 服务及大模型。Mac App Sandbox 下也不能把 Homebrew 自动安装当作可靠审核路径。因此首版送审应满足以下至少一项：

- 提供无需 Ollama 的完整云端/demo 审核路径，并在审核备注中写清楚；或
- 把兼容 App Sandbox 的本地推理 runtime 作为已签名 helper 一起发布，再重新验证下载模型、GPU、沙盒和许可证；或
- 将依赖本地模型的能力明确标记为可选，不让首次体验停在“请安装外部组件”。

### 2. Credit/订阅是否能在站外购买

当前客户端会展示云端订阅和 Credit，并消费 Credit 使用数字 AI 能力。如果用户能在网页充值、购买 Credit 或订阅，然后在 App 中消费，通常会触及 App Review Guideline 3.1.1/3.1.3(b)：数字功能解锁一般需要提供 IAP。送审前应选择并实现一种模式：

- 在 Mac App 内接入 StoreKit/IAP；或
- 首版完全免费，不在 App 内外销售用于解锁 App 数字能力的 Credit；或
- 作为符合条件的免费独立 companion，不在 App 中提供购买、外链购买或购买号召，并让法务/Apple Review 预先确认业务模式。

只隐藏“充值”按钮但继续让站外购买的 Credit 解锁 App 功能，仍有较高拒审风险。

### 3. 出口合规不能猜

项目包含 HTTPS 和自有 AES-GCM 数据加密。仓库当前将 `ITSAppUsesNonExemptEncryption` 设为 `YES`，避免未经判断就宣称豁免；这会要求在 App Store Connect 回答加密问卷，必要时上传文档并把 Apple 返回的 compliance code 写入 Info.plist。

如果合规律师或 Apple 问卷确认所有用法均属于豁免，可以改为 `NO`。不要只因为使用的是标准算法就自行断言豁免，尤其要确认加密是否由 App 自己实现、是否在法国上架，以及美国年度 self-classification 是否适用。

## 官方资料

- [Tauri：Mac App Store 分发](https://v2.tauri.app/distribute/app-store/)
- [Tauri：macOS 签名与公证](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri：DMG](https://v2.tauri.app/distribute/dmg/)
- [Apple：配置 App Sandbox](https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox)
- [Apple：在沙盒 App 中嵌入 helper](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)
- [Apple：创建 App 记录](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/)
- [Apple：上传 build](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds)
- [Apple：提交审核](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app)
- [Apple：App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Apple：出口合规](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance)
