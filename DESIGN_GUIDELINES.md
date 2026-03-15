# WorkBuddy UI 设计规范

## 设计原则

### 核心理念
- **macOS 原生感**：遵循 Apple Human Interface Guidelines
- **简洁优雅**：少即是多，避免视觉噪音
- **功能清晰**：信息层级分明，操作直观
- **现代精致**：使用系统原生组件和图标

---

## 图标系统

### ❌ 禁止使用
- Emoji 图标（🤖 🔧 📊 等）
- 位图 icon（.png, .jpg）
- 第三方图标库的位图格式

### ✅ 推荐使用

#### 1. SF Symbols（首选）
macOS 原生图标库，完美适配系统风格

```swift
// 主要功能图标
机器人/AI:     "brain.head.profile"
知识库:        "books.vertical.fill"
设置:          "gearshape.fill"
调试:          "wrench.and.screwdriver.fill"
状态:          "circle.fill"

// 任务类型图标
OCR:           "doc.text.viewfinder"
Embedding:     "text.magnifyingglass"
LLM:           "bubble.left.and.bubble.right.fill"
VLM:           "eye.fill"
ASR:           "waveform.circle.fill"

// 操作图标
刷新:          "arrow.clockwise"
关闭:          "xmark"
保存:          "checkmark"
删除:          "trash.fill"
搜索:          "magnifyingglass"
```

#### 2. Lucide Icons（备选）
简洁现代的 SVG 图标库
- 官网：https://lucide.dev
- 格式：SVG
- 风格：线性、简洁

#### 3. Heroicons（备选）
Tailwind 出品的 SVG 图标
- 官网：https://heroicons.com
- 格式：SVG
- 风格：现代、清晰

---

## 颜色系统

### 主色调
```css
/* 系统蓝（主要操作） */
--primary: #007AFF;
--primary-hover: #0051D5;
--primary-active: #004FC4;

/* 系统绿（成功状态） */
--success: #34C759;
--success-light: rgba(52, 199, 89, 0.1);

/* 系统红（错误/警告） */
--error: #FF3B30;
--error-light: rgba(255, 59, 48, 0.1);

/* 系统橙（警告） */
--warning: #FF9500;
--warning-light: rgba(255, 149, 0, 0.1);

/* 系统紫（特殊状态） */
--purple: #AF52DE;
--purple-light: rgba(175, 82, 222, 0.1);
```

### 中性色
```css
/* 背景色 */
--bg-primary: #FFFFFF;
--bg-secondary: #F5F5F7;
--bg-tertiary: #E5E5EA;

/* 文字色 */
--text-primary: #000000;
--text-secondary: #6E6E73;
--text-tertiary: #AEAEB2;

/* 边框色 */
--border-light: rgba(0, 0, 0, 0.1);
--border-medium: rgba(0, 0, 0, 0.15);
```

### 深色模式
```css
/* 背景色 */
--bg-primary-dark: #1C1C1E;
--bg-secondary-dark: #2C2C2E;
--bg-tertiary-dark: #3A3A3C;

/* 文字色 */
--text-primary-dark: #FFFFFF;
--text-secondary-dark: #AEAEB2;
--text-tertiary-dark: #6E6E73;

/* 边框色 */
--border-light-dark: rgba(255, 255, 255, 0.1);
--border-medium-dark: rgba(255, 255, 255, 0.15);
```

### 语义化颜色（参考 Image3）
```css
/* 统计卡片背景色 */
--card-blue: rgba(0, 122, 255, 0.08);
--card-green: rgba(52, 199, 89, 0.08);
--card-purple: rgba(175, 82, 222, 0.08);
--card-orange: rgba(255, 149, 0, 0.08);
--card-pink: rgba(255, 45, 85, 0.08);
```

---

## 字体系统

### 字体家族
```css
/* 系统字体（首选） */
--font-system: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", sans-serif;

/* 等宽字体（代码/数据） */
--font-mono: "SF Mono", Monaco, "Cascadia Code", "Fira Code", monospace;

/* 中文字体 */
--font-chinese: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
```

### 字体大小
```css
/* 标题 */
--text-3xl: 28px;  /* 页面主标题 */
--text-2xl: 22px;  /* 区块标题 */
--text-xl: 18px;   /* 卡片标题 */
--text-lg: 16px;   /* 小标题 */

/* 正文 */
--text-base: 14px; /* 正文 */
--text-sm: 13px;   /* 辅助文字 */
--text-xs: 12px;   /* 说明文字 */
```

### 字重
```css
--font-regular: 400;
--font-medium: 500;
--font-semibold: 600;
--font-bold: 700;
```

---

## 间距系统

### 基础单位
```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
--space-12: 48px;
```

### 应用规则
- 组件内部间距：8px (space-2)
- 组件之间间距：16px (space-4)
- 区块之间间距：24px (space-6)
- 页面边距：24px (space-6)

---

## 圆角系统

```css
--radius-sm: 6px;   /* 按钮、输入框 */
--radius-md: 8px;   /* 小卡片 */
--radius-lg: 12px;  /* 大卡片、面板 */
--radius-xl: 16px;  /* 模态框 */
--radius-full: 9999px; /* 圆形按钮 */
```

---

## 阴影系统

```css
/* 轻微阴影（悬浮卡片） */
--shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.08);

/* 中等阴影（弹出菜单） */
--shadow-md: 0 4px 12px rgba(0, 0, 0, 0.12);

/* 强烈阴影（模态框） */
--shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.16);

/* 内阴影（输入框） */
--shadow-inner: inset 0 1px 2px rgba(0, 0, 0, 0.06);
```

---

## 组件规范

### 1. 按钮

#### 主要按钮（Primary）
```css
background: var(--primary);
color: white;
padding: 8px 16px;
border-radius: var(--radius-sm);
font-size: var(--text-base);
font-weight: var(--font-medium);
box-shadow: var(--shadow-sm);

/* Hover */
background: var(--primary-hover);
transform: translateY(-1px);
box-shadow: var(--shadow-md);

/* Active */
background: var(--primary-active);
transform: translateY(0);
```

#### 次要按钮（Secondary）
```css
background: var(--bg-secondary);
color: var(--text-primary);
border: 1px solid var(--border-light);
```

#### 图标按钮
```css
width: 32px;
height: 32px;
border-radius: var(--radius-full);
background: transparent;

/* Hover */
background: var(--bg-secondary);
```

### 2. 卡片（参考 Image3）

```css
background: white;
border-radius: var(--radius-lg);
padding: var(--space-4);
box-shadow: var(--shadow-sm);
border: 1px solid var(--border-light);

/* Hover */
box-shadow: var(--shadow-md);
transform: translateY(-2px);
transition: all 0.2s ease;
```

### 3. 统计卡片（参考 Image3 的彩色方块）

```css
/* 结构 */
.stat-card {
  background: var(--card-blue); /* 根据类型变化 */
  border-radius: var(--radius-md);
  padding: var(--space-4);
  min-height: 100px;
}

.stat-label {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  margin-bottom: var(--space-2);
}

.stat-value {
  font-size: var(--text-3xl);
  font-weight: var(--font-semibold);
  color: var(--primary); /* 根据类型变化 */
}
```

### 4. 输入框

```css
background: var(--bg-primary);
border: 1px solid var(--border-medium);
border-radius: var(--radius-sm);
padding: 8px 12px;
font-size: var(--text-base);
box-shadow: var(--shadow-inner);

/* Focus */
border-color: var(--primary);
box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.1);
```

### 5. 表格

```css
/* 表头 */
.table-header {
  background: var(--bg-secondary);
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
  color: var(--text-secondary);
  padding: var(--space-3) var(--space-4);
}

/* 表格行 */
.table-row {
  border-bottom: 1px solid var(--border-light);
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-base);
}

/* Hover */
.table-row:hover {
  background: var(--bg-secondary);
}
```

---

## 动画规范

### 过渡时间
```css
--transition-fast: 150ms;
--transition-base: 200ms;
--transition-slow: 300ms;
```

### 缓动函数
```css
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
```

### 常用动画
```css
/* 淡入淡出 */
transition: opacity var(--transition-base) var(--ease-out);

/* 滑动 */
transition: transform var(--transition-base) var(--ease-out);

/* 缩放 */
transition: scale var(--transition-fast) var(--ease-out);
```

---

## 布局规范

### 1. 页面布局
```
┌─────────────────────────────────────┐
│  Header (固定高度 60px)              │
├─────────────────────────────────────┤
│                                     │
│  Content (自适应高度)                │
│  - 左右边距: 24px                    │
│  - 上下边距: 24px                    │
│                                     │
└─────────────────────────────────────┘
```

### 2. 网格系统
- 12 列网格
- 列间距：16px
- 响应式断点：
  - sm: 640px
  - md: 768px
  - lg: 1024px
  - xl: 1280px

### 3. 卡片网格（参考 Image3）
```css
display: grid;
grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
gap: var(--space-4);
```

---

## 具体问题修复

### ❌ Image1 问题
1. **Emoji 图标太丑**
   - 替换为 SF Symbols
   - 使用单色线性图标

2. **Hover 所有图标都放大**
   - 只放大当前 hover 的图标
   - 添加 `pointer-events: none` 到非交互元素

### ❌ Image2 问题
1. **文字堆叠，无美感**
   - 使用卡片分组
   - 添加图标和标签
   - 使用表单布局

2. **配置项展示混乱**
   - 分类展示（API 服务、个性化偏好、版本信息）
   - 使用折叠面板
   - 添加说明文字

### ✅ Image3 优点
1. **多色方块展示**
   - 保留彩色背景
   - 替换 emoji 为 SF Symbols

2. **组件原生化**
   - 继续使用原生风格
   - 统一圆角和阴影

---

## 实施计划

### Phase 1: 图标替换（优先级最高）
- [ ] 替换所有 emoji 为 SF Symbols
- [ ] 统一图标大小和颜色
- [ ] 修复 hover 交互问题

### Phase 2: 设置页面重构
- [ ] 使用卡片布局
- [ ] 添加分组和标签
- [ ] 优化表单样式

### Phase 3: 全局优化
- [ ] 统一颜色和间距
- [ ] 添加过渡动画
- [ ] 优化深色模式

---

## 参考资源

### 官方文档
- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
- [SF Symbols](https://developer.apple.com/sf-symbols/)

### 图标库
- [Lucide Icons](https://lucide.dev)
- [Heroicons](https://heroicons.com)
- [Phosphor Icons](https://phosphoricons.com)

### 设计工具
- Figma
- Sketch
- macOS 系统取色器

---

## 版本历史

- v1.0 (2026-03-14): 初始版本，基于用户反馈创建
