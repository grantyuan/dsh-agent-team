# 设计原则与设计语言

[English](principles-and-language.md) | 中文

## 设计原则
1. **优先复用 Harness 公共原语**（`@deepseek-ai/dsh-client-ui-primitives`）：`MarkdownText`、`Button`、`Pill`、`Modal`、`Tooltip`、`Input`、`StateDot`、图标，以及 `useDismissOnOutsidePointer`、`useAnchoredMaxHeight` 等 hook。Team 不重写这些能力；composer textarea 是唯一例外（`Input` 原语明确只做单行）。`MessageText` 已不在集合内——该原语在 0.1.5 被移除，`TeamMessage` 自行渲染纯文本正文、Markdown 委托给 `MarkdownText`。
2. **只用 DSH alias token 取色**，且只允许主题实际定义的名字（`@deepseek-ai/dsh-client-ui-theme` 的 `design-platform.css` 与 `gradient-shadow-text.css` 是唯一定义处）：文字 `--dsw-alias-label-*`、边框 `--dsw-alias-border-l1..l4`（+`l2-darkmode-thin`/`inverted*`）、背景 `--dsw-alias-bg-*` 与 `--dsw-alias-interactive-bg-*`、状态 `--dsw-alias-state-*`、阴影 `--dsw-shadow-lv1..lv3`、具体值 `--dsw-specific-*`。禁止凭印象引用主题不存在的 token——`var()` 对未定义变量会静默回退 initial，边框/背景直接隐形（2026-08 教训：`border-subtle`/`border-default`/`text-*`/`fill-tertiary`/`surface-primary` 曾整批不存在，时间线全部发丝线与 loading 点从未渲染过）。Team 自有变量只允许派生值（见头像色相）。
3. **聊天密度优先于 assistant 排版密度**：正文统一 14px 档；markdown 原语自带的标题/列表间距在本包内收紧。
4. **渐进披露**：默认状态安静（细边框、无底色），hover/focus 才提升反馈；次要信息用 tertiary 文字色。
5. **durable mutation 不做乐观更新**：提交失败保留输入并以 Host 报错为准；成功后从 Host 投影刷新（`mergeChannelView` 合并而非整体替换）。
6. **键盘与读屏基线不妥协**：所有自定义复合控件都有 role、aria 状态和完整键盘路径。

## 设计语言对齐（DSH 0.1.7）
Team Client 渲染在 shipped DSH 外壳内部，必须讲基础 UI 的设计语言。本节是**耐久合同**；可重复执行的机械审计是 `node scripts/audit-ui-parity.mjs`（任何可见 UI 改动后、每次 DSH 升级后都跑一次——其中的 shipped 参考 tripwire 会在 harness checkout 不再定义本对齐所依赖的原语时报警，提示重新核对基线）。

| 维度 | 规则 | shipped 参考 |
| --- | --- | --- |
| 纯图标控件 | 28×28 圆形，`border-radius: 999px`，`corner-shape: round`，透明底色，hover 用 `--dsw-alias-interactive-bg-hover-solid`（composer）/ `--dsw-alias-interactive-bg-hover`（侧栏） | `InputBar.module.css .add`、`SidebarRoot.module.css .iconButton` |
| 主圆形动作（发送/停止） | 34×34 圆形，`--dsw-alias-button-info-fill`，静态 `#fff` 图形，hover info-hover，disabled `opacity .4` + `cursor: default`，`translateY(-2px)` 座位补偿 | `InputBar.module.css .primary` |
| 列表行 | 8px 圆角；`aria-current="page"` 叶子行底色；hover `--dsw-alias-interactive-bg-hover` | `SidebarRoot.module.css .panelRow` |
| 队列/结果行（双行） | 整宽按钮，8px 圆角、左右 8px 内缩，每条事实独占一行、各自省略，hover `--dsw-alias-interactive-bg-hover`，焦点环内缩。字号分级两行：主体 14px/22px primary；来源/元信息 12px/18px tertiary，其中显著片段（频道名）提到 secondary 600；行内 `Task #N` 是 6px、11px/15px 的小胶囊。哪一行承载哪条事实，由该面自己的信息顺序决定。 | `ui-workspace/src/client/rows/Rows.module.css .searchResultRow`（8px 圆角、8px 内缩、整宽按钮、hover 底色、14px 标题 + 12px 元信息） |
| 胶囊与圆形 | 任何**实质无上限**的圆角——`border-radius: 50%`、`999px`，或等于盒子一半高度的 pill 圆角——都必须在同一条规则内配 `corner-shape: round`。平台把所有圆角面按 `superellipse(1.5)` 弯曲，会把正圆压成方圆、把胶囊两端切平；shipped 的全圆角块 100% 配对，审计对未配对者直接报错。 | `ui-theme/src/styles/corner-shape.css`；`Tag.module.css`、`StateDot.module.css`、`SidebarRoot.module.css .iconButton` |
| 计数徽标 | 读者看到的每一处计数共用一枚胶囊，声明只有一份，在 `countBadge.module.css .badge`：18px 高、`min-width: 18px`，`border-radius: 999px` 配 `box-sizing: border-box`（单字符保持正圆，不被 padding 撑成椭圆），底色 `--dsw-alias-state-business-primary`、文字 `--dsw-alias-label-primary-foreground`，为 0 隐藏、超过 99 显示 `99+`，数字挂在控件的可访问名（`aria-label`）上，不能只存在于视觉徽标里。 | `Tag.module.css`（只读胶囊语言）；`countBadge.module.css .badge` |
| 小胶囊 | 6px 圆角，`--dsw-alias-interactive-bg-hover` 底色 | `composer-editor.module.css .reference`（6px 行内引用；shipped 保持透明、hover 才叠 business 色） |
| 控件间距 | composer/侧栏工具组内兄弟控件间距 12px | `InputBar.module.css .tools/.trailing` |
| 键盘焦点 | 可见焦点环：`outline: 2px solid var(--dsw-alias-label-primary)`；列表行 `outline-offset: -2px`，图标级控件 `1px`。`outline: none` 仅当同一条规则内有**环级替代**时才允许——outline、`box-shadow` 扩散、有边框控件的 `border-color`、文本控件的 `text-decoration`；只有底色/颜色属于 hover 反馈，不构成焦点指示（shipped 对小控件干脆保留 UA 默认环）。环色随控件含义：行与图标控件用 `label-primary`，composer/Thread 等输入邻接控件用 `business-primary`（shipped 把 business 锚定在输入、链接与表格滚动上）。豁免：`aria-activedescendant` listbox 行（mention 弹层）——焦点留在文本输入框，选中态由 `[aria-selected]` 呈现 | `SidebarRoot.module.css .panelRow:focus-visible`；`InputBar.module.css .add`（保留 UA 环，不写 `outline: none`） |
| 图标语义 | 图形沿用基础 UI 的含义：`+` = 命令菜单、回形针 = 附件、铅笔 = 编辑。**禁止**把 shipped 图形挪作他用。0.1.7 改名了整套图标——尺寸从名字里移出、字重进入名字（`Icon*OutlineRegular`、`Icon*OutlineMedium`、`Icon*OutlineArtwork`），尺寸走 `size` prop——并删掉了 shipped composer 自带的附件控件，所以 Team composer 的回形针是本仓自己的约定 | `InputBar.tsx`（`+` 经 `aria-haspopup="listbox"` 打开命令菜单） |
| 模式控件（composer） | 改变主操作**语义**的控件（「作为任务」）是**模式**而不是动作：它保留可见文字标签，与附件控件同处左侧分组，形态为 28px 高的 pill（24px 圆角、13/20px 字重 500、透明底色、hover `--dsw-alias-interactive-bg-hover`、`aria-pressed` 打开时 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`）。文字**只允许**在窄容器分支（`@container (max-width: 460px)`）里隐藏、绝不删除——该分支下 `aria-label`、`title`、`aria-pressed` 仍保证读屏与键盘可用 | `InputBar.module.css .row`（size container）；模式控件现在是 `.select`（28px、8px 圆角、13/20 medium），composer 在 `@container (max-width: 560px)` 下缩控件间距 |

> TODO：DSH 0.1.7 挪动了本表镜像的四处参考，Team 尚未对齐，每处都待决定：
> - 列表行：shipped `.panelRow` 现在是 12px 圆角，Team 的行仍声明 8px；
> - 模式控件：带字 chip 与它的 460px 收起标签已被删除，因此 composer 在任何宽度都保留文字、窄于 560px 时把控件间距缩到 8px，而我们的 `asTaskPill` 仍是 24px pill；
> - composer 卡体：shipped 底部内距是 4px，Team 卡的内距是自己的；
> - 图标字重：14~16px 的控件与菜单用 `Icon*OutlineMedium`，Team 的 14px composer 图标仍是 `Icon*OutlineRegular`。

一致性裁决按面记录在本文档（见下文各组件合同）：裁决为「接受偏差」时必须在对应小节写明原因——审计脚本报告机械偏差，文档拥有判断。
