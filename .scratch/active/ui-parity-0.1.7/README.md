# 0.1.7 UI 设计语言再基线（task:d3ec167b #15）

## 状态

- **状态**：A 类已交付（`9ba332a9`）；B 类由 Human 13:49 授权 Iris 自行决定，已全部落地待验收（2026-09-24）。
- **最后核对**：2026-09-24 13:33~13:50，harness checkout `/home/yu/projects/deepseek-harness`，`git describe` = `dsh-v0.1.7-rc.1`（对照基线 = `dsh-v0.1.5-rc.2`，即我们文档里那条 0.1.5 语言）。
- **当前前沿**：Human 13:49「你自己去决定优化」+ 报「composer 输入 @ 的 mention 栏背景看不清」。Iris 判定 B1/B2/B3/B4 落地（B5 记豁免），并新增两条同源漂移：mention 弹层毛玻璃配方、composer 卡 elevation 描边；`scripts/audit-ui-parity.mjs` 新增 §12 毛玻璃表面规则。C1 未开工。
- **完成条件**：`scripts/audit-ui-parity.mjs` 与 `docs/frontend-design/principles-and-language{,.zh}.md` 重新锚定到 0.1.7（不再引用已删除的 shipped 文件）；被选中的可见改动落地并通过 `audit-ui-parity` exit 0 + `npm run test:browser`（1440×960 / 390×844）。
- **正式文档出口**：`docs/frontend-design/principles-and-language.md`（+ `.zh.md`，设计语言表的唯一权威）、`scripts/audit-ui-parity.mjs`（表的可执行镜像）；若机会项落地再动 `docs/frontend-design/sidebar-browser.md` 与 `CHANGELOG.md`。

## 触发

Human 13:32（thread:381599ed）：「本次升级到0.1.7后ui也变化了不少，我们这里也有需要改进的，你可以先去看看ui变化吧」。上一 Task #21 只处理了两个升级故障（插件 tab、资料丢失），没做设计语言面。

## 为什么必须先再基线

`node scripts/audit-ui-parity.mjs` 在 master（`9ae81c68`）上 **exit 1**，2 error + 2 warn 全部来自 0.1.7 把 shipped 参考搬走/改名，而不是我们的代码回归：

- `[error] TeamComposer.tsx: attach button does not use IconPaperclipOutline16` —— 我们已在 `72c53ad2`（同侪的 rc.1 认证提交）把图标迁到新命名 `IconPaperclipOutlineRegular size={14}`，是**审计的 needle 过期**。
- `[error] shipped mode-chip label cut: shipped reference file missing: …/skeleton/PermissionSelect.module.css` —— 该文件在 0.1.7 被删除（同目录 `.tsx` 也删了）。
- `[warn] shipped composer icons: shipped reference no longer contains 'IconPaperclipOutline16' / 'IconPlusOutline16'` —— 0.1.7 的 shipped composer 已无回形针控件。

结论：审计脚本现在既误报我们、又无法再证明 shipped 侧的语言，任何同侪跑门禁都会看到 red。这是 A 类必须修的原因。

## 对照表（shipped 0.1.5-rc.2 → 0.1.7-rc.1 × 我们现状）

| 维度 | shipped 0.1.5-rc.2 | shipped 0.1.7-rc.1 | 我们现状 | 判定 |
| --- | --- | --- | --- | --- |
| 图标命名 | `Icon*Outline16`（尺寸入名） | 重量变体：`*Outline` / `*OutlineRegular` / `*OutlineMedium` / `*OutlineArtwork`，尺寸走 `size` prop（186 个导出；Artwork 223 / Outline 150 / Regular 78 / Medium 78 处引用） | 已在 `72c53ad2` 迁到 `…OutlineRegular`（25 处引用，全部存在性通过） | A：审计 needle 要改；B：重量选择待定 |
| 图标重量语义 | 无（只有 16px 一档） | 14~16px 的**控件/菜单**用 `Medium`（composer `+` = `IconPlusOutlineMedium size={14}`；AccountMenu 16；窄栏 New chat 14）；16~18px 的**栏/列表**用 `Regular`；`Artwork` 是装饰大图 | 我们清一色 `…OutlineRegular`，composer 三枚 14px 图标（attach/as-task/send）都是 Regular | B：值得跟 Medium |
| 回形针 | composer 有独立 attach 按钮（`IconPaperclipOutline16`） | **shipped client 里已无任何回形针用法**（attach 折进命令菜单/拖放；`+` = 命令菜单，`aria-haspopup="listbox"`） | 我们 Team composer 仍有自己的 attach 按钮（回形针） | A：语义规则改为 Team 自有约定（glyph 含义仍成立，但不再有 shipped 先例可引） |
| 列表行 | `.panelRow` 8px 圆角、`margin: 0 2px 8px`、`font-weight: 500` | `.panelRow` **12px 圆角**、`margin: 0 2px 12px`、去掉 500；`.collapsed .iconButton` 36px/12px；栏头新增 40px/52px 两档 | `channelRow`/`agentRow`/`workspaceTrigger`/`inboxCard`/`inbox .row` 全 8px（审计按 8px 钉住） | **B：真实漂移，最显眼的一条** |
| 行高 | `.panelRow` `min-height: 36px`、`padding: 7px 8px` | 同 36px（未变） | 我们 30/34/38px 三档 | 既有偏差（升级前就有），**不动**，只在文档里说明 |
| 控件间距 | `.tools/.trailing` 12px | 桌面仍 12px，但新增 `@container (max-width: 560px){ .tools,.modes,.trailing{gap:8px} }` | 我们 12px（审计绿），窄栏另有 460px 分支 | B：断点语义变了 |
| 模式控件 | `PermissionSelect.module.css`：带词标签的胶囊（24px 圆角）+ 460px 隐藏标签；另有 `.select`（Plan/Read-only/model，28px/8px 圆角/13-20 500/secondary/12px chevron） | `PermissionSelect` 删除；模式语言只剩 `.select`（8px 圆角、透明底、hover `interactive-bg-hover`），窄栏改为**缩 gap 而不是藏标签** | `asTaskPill` 28px 高、**24px 圆角**、13/20 500；窄栏 460px 隐藏词标签，注释写明「沿用 shipped permission chip 的 460px cut」 | B：引用的先例已死，要么改 8px 芯片语言，要么改注释+文档留豁免 |
| 发送键 | `.primary` 34×34、`button-info-fill`、静态 `#fff`、disabled .4 | 完全未变 | 一致（审计绿） | 保持 |
| 图标控件 | `.add` 28×28、999px、`corner-shape: round`、hover `interactive-bg-hover-solid` | 完全未变（底部 padding 8px→4px，旧虚线焦点环 mask 删除） | 一致（审计绿） | 保持 |
| 焦点环 | `.panelRow:focus-visible` 2px `label-primary` + offset -2px | 完全未变（needle 实测命中） | 一致 | 保持 |
| 队列/结果行 | `Rows.module.css .searchResultRow` 8px 圆角、4px 8px 内距、min-height 48px | 完全未变 | 一致 | 保持 |
| chip | `ReferenceChip.module.css .chip` 6px 圆角 + `interactive-bg-hover` 填充 | `.chip` 变成行内 business 文字（无圆角/填充）；6px 透明 `.reference` 移到 `composer-editor.module.css`，hover `business-tertiary`；`Tag.module.css .tag` 是 999px 胶囊 | 我们 fileChip/attachmentChip/mention/rowTask 都 6px，填充用 `interactive-bg-hover` | B：半径仍对，**填充的引用失效**，要在文档里说清我们为什么还是有底 |

## 三类清单

### A. 机械再基线（不改视觉，建议先做）

1. `scripts/audit-ui-parity.mjs` §6 的 shipped needle：
   - `shipped mode-chip label cut` → 改为 `skeleton/InputBar.module.css` + needle `@container (max-width: 560px)`（并可在同一处核对 `.tools/.modes/.trailing` 的 `gap: 8px`）。
   - `shipped composer icons` → 0.1.7 事实是 `IconPlusOutlineMedium`（`size={14}`，`t('input.commands')`、`aria-haspopup="listbox"`），needle 换成它；删掉已不存在的 `IconPaperclipOutline16`。
2. §5 图标语义：保留「attach 用回形针、`+` 是命令菜单」的 Team 约定，但注释与文档不再声称「shipped composer 也这么做」——shipped 现在根本没有 attach 按钮。
3. §7 原语存在性、§9 token 存在性在 0.1.7 下实测**已经全绿**（无需改）。
4. `docs/frontend-design/principles-and-language{,.zh}.md`：标题 `(DSH 0.1.5)` → `(DSH 0.1.7)`，并修掉表中已失效的 shipped 引用（表头 `Shipped reference` 列逐行核对）。
5. 审计脚本自身标签「vs DSH 0.1.5 design language」→ 0.1.7。
6. 按 skill 的铁律做**双向验证**：干净树 exit 0 + 临时注入违规必须被精确报出后还原。

### B. 可见改动（等 Human 拍）

1. **列表行 8px → 12px**：`sidebar.module.css` `.channelRow`/`.agentRow`/`.workspaceTrigger`/`.inboxCard` + `inbox.module.css` `.row`；同步 `audit-ui-parity.mjs` 的 `GEOMETRY` 与文档。行高 30/34/38 不动（既有偏差，另有理由）。
2. **as-task 模式控件**：24px 胶囊 → 8px 圆角的 chip 语言（跟 `.select`），或维持胶囊但在文档里明确记为 Team 自有豁免。倾向跟随 shipped。
3. **窄栏行为**：460px 隐藏标签 → 560px 缩 gap（shipped 现在就是缩 gap，标签始终可见）；若保留隐藏标签，需在文档写清豁免理由。
4. **14px 图标换 Medium**：composer 的 attach/as-task/send 等 14px 控件图标（shipped 同尺寸控件用 Medium）。
5. chip 填充：跟随 shipped 改透明 business？还是保留我们的 `interactive-bg-hover` 底（在白底卡片上更像可点的 chip）——这条是判断题，需要 Human 或我给出对比证据。

**B 落地结果（2026-09-24，Human 13:49 授权自行决定）**

- B1 列表行 12px：**落地**——`sidebar.module.css` 7 处（workspaceTrigger / inboxCard / channelRow / channelSelect / agentRow / agentSelect / agentSelect[aria-current]）。**`inbox.module.css .row` 特意不动**：它是「队列/结果行」维度，shipped `.searchResultRow` 在 0.1.7 仍是 8px，只有 `.panelRow` 挪到了 12px。
- B2 as-task：**落地**为 8px chip（跟 `.select`），并按 B3 保留文字。
- B3 窄栏：**落地**——460px 隐藏标签 → `@container (max-width: 560px)` 缩工具组间距，模式文字任何宽度都保留。审计 §10 从「必须有 460px 标签 cut」改成「任何宽度都不得隐藏文字 + 必须有 560px 缩 gap 分支」。
- B4 图标重量：**落地**——composer 的 attach 与 as-task 换 `Icon*OutlineMedium size={14}`。核对后收窄了口径：shipped 14px 图标里 `Regular` 仍是多数（84 处），`Medium` 用在领起控件（composer `+`、侧栏 New chat、关闭钮）；所以我们跟着 **composer 内部**的约定走，而非「14~16px 一律 Medium」。send 键未动（它本来就是 `Regular`，且 shipped 未改）。
- B5 chip 填充：**记豁免**——保留 `interactive-bg-hover` 底，理由写进 `docs/frontend-design/principles-and-language{,.zh}.md` 的「刻意不跟齐」两条之一。
- **同源两条新增漂移（Human 报的 bug 顺藤摸出来的）**：① mention 弹层把 0.1.7 的半透明 `--dsw-specific-menu` 当实底用 → 抄 shipped 毛玻璃配方（`--dsw-menu-backdrop-filter` + elevation 描边/阴影），**这就是 Human 看到的「看不清」**；② composer 卡用 1px `border-l2-darkmode-thin` + `shadow-lv2` → 改 shipped 的 `border: 0` + l2 elevation 发丝线 + `--dsw-elevation-soft`（深色下原来的 1px 只有应有 alpha 的一半）。审计新增 §12「毛玻璃表面」规则把 ① 这类「token 还在、值变半透明」变成可机械检测的维度（`SURFACE_TOKENS` 白名单 + alpha 判定，交互态/骨架/分隔线不在内）。composer 卡的**内距**保留我们自己的 10px/8px，同 B5 记豁免。
- **改窄栏分支时踩到的坑（审计新增 §14 就是它）**：`container-type: inline-size` 原先声明在 `.toolbar` 自己身上，而 `@container (max-width: 560px) { .toolbar { gap: 8px } }` 要改的正是这个容器元素——**元素永远不回答关于自己的容器查询**，所以这条分支是死代码，任何宽度都不会生效，而它读起来完全像一条能用的窄栏分支。已把容器移到 `.card`（shipped 也是把容器放在行、查它内部的组），并在审计里加 §14：某类声明了 `container-type` 又出现在同文件 `@container` 块的目标选择器里 → error。双向验证过（把它移回 `.toolbar` → 精确报出，还原字节一致）。
- **e2e 同步**（`scripts/team-ui.e2e.ts`）：旧的「390 下 `asTaskLabel` 必须 `display: none`」断言按新合同改成「两个宽度文字都在 + 窄栏 toolbar gap = 8px / 宽栏 12px」；另加两条：mention 弹层的 `backdrop-filter` 含 `blur` 且底色是 `rgba(...)`（把 Human 报的那条钉进浏览器门禁），以及 composer 卡 `borderColor + boxShadow` 在 focus 前后不变（描边从 border 换成 elevation 发丝线后，这条断言改比 boxShadow 才有意义）。
- **本轮门禁结果**：`audit-ui-parity` exit 0（0 error / 0 warn）、client vitest 205/205、typecheck 0、lint 0 error、check:docs OK、`npm run test:browser` 4/4（1440×960 + 390×844，含上述新断言），截图人工看过两个宽度。

### C. 机会项（新能力，非漂移）

1. **`sidebar.toggle.badge`**（0.1.7 新槽：`kind: 'single'`、`scope: 'root'`、「折叠态展开按钮里的非交互提示」）：可以把 Team Inbox 未读数挂到**折叠栏**上——现在折叠态看不到任何 Team 未读。候选做法：Team Client 往这个槽注入一个纯展示标记，由既有 Inbox projection 驱动。需要先确认该槽的 owner/scope 语义与折叠态是否真渲染。
2. 0.1.7 会话侧重构（`ConversationHeader/Content/MainPanel/DefaultConversationViews`、可拖拽宽度 `ConversationWidthControls`（localStorage `dsh.conversation.contentWidth`，下限 640）、`TodoPanel`、`ContextMeter` 改动、新增 group registry/store、`contract/queue.ts` 删除、`context-provenance.ts`→`context-producer.ts`）：Team 模式下我们把主面板换成自己的 Thread/Channel 页，暂**不跟进**；等哪天真要在 Team 里用 shipped 会话组件再评估。

**C 状态（2026-09-24）**：C1 `sidebar.toggle.badge` 仍未开工（本轮先把 Human 点名的可读性问题与 B 类清完）；C2 维持不跟进。

**D 类观察（量过、本轮刻意不做）**：我们客户端 CSS 里还有 6 处 `border: 1px solid var(--dsw-alias-border-*)`，而 shipped 0.1.7 画描边一律走 `0.5px` 或 elevation 发丝线（`border: 0.5px solid var(--dsw-alias-border-l2)` 见 `AccountSection.module.css`、`AttachmentRail.module.css` 等），我们包内 0.5px 用法为 0 处。composer 卡已随本轮改成发丝线；其余 5 处（含 `.workspaceTrigger`、`thread .newUpdates`）属于「同一类但会一次动到多个面」的改动，且 0.5px 在非 retina 上的渲染还要实测，留给下一轮单独做。

## 验证命令

```bash
node scripts/audit-ui-parity.mjs                 # A 完成后必须 exit 0
node scripts/harness-dir.mjs                     # 确认 harness 指针（本机 = /home/yu/projects/deepseek-harness）
git -C /home/yu/projects/deepseek-harness describe --tags   # dsh-v0.1.7-rc.1
npm run test:browser                             # 动了可见 UI 才需要（1440×960 + 390×844）
npm run check:docs                               # 动了 docs/ 才需要
```
