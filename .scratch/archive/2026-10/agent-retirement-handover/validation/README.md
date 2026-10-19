# Validation — agent retirement handover 浏览器验收里程碑

复跑命令（仓库根）：

```sh
CHROME_PATH=/usr/local/bin/chromium npm run test:browser
```

产出 run：2026-10-18 15:41（本地时区），基线 `d4543bf`（master）加本工作项全部未提交改动，`__external-agent-team.e2e.ts` 6/6 journey 全绿。第六个 journey `retires a supervised Member into a successor in real Web` 以测试侧注入驱动真实 supervision 退役换代链（pass0 异常 → pass1 reset 后仍异常 → handover），逐张审查由验收 sweep 完成（桌面 1440×960 与 390×844）。journey 内另有机械断言兜底：公示正文尾行存在且该消息无折叠控件、successor/predecessor 八字段 JSON 深比较、编辑器回显继承的上下文窗口 `96000`。

以下 5 张为该工作项的里程碑集（Human 终审确认后随工作项归档）：

| 文件 | 证明的验收点 |
| --- | --- |
| `retirement-history.png` | 继任者 `builder-2` 的「历史会话」页（桌面）：世代清单列出当前会话与多条「继承自 builder」世代，右侧展示所选世代的可读 transcript——证明退役前代历史经继任入口可列可开、无断档。 |
| `retirement-history-narrow.png` | 同上（390×844）：世代清单与 transcript 在窄断点堆叠，无横向溢出。 |
| `retirement-notice.png` | `# engineering` 频道的退役公示（桌面）：纯文本结构化正文——退役原因（`Cause:`，context-oversize 触发）、`Completed work in service:`（已完成方向、已完成任务数、参与 Thread 数）、`Released work now unclaimed:`（释放的 Task #2）、定向 `@reviewer please reassign the items above to builder-2.` 与 `Succession:` 行；human 口吻正文按 literal 渲染，正文短于 600 字符折叠阈，整块一次可见。 |
| `retirement-notice-narrow.png` | 同上（390×844）：正文以 `pre-wrap` 保留换行、逐行完整显示，无 markdown 标记泄漏。 |
| `retirement-parity.png` | 继任者编辑对话框：`上下文窗口覆盖` 回显继承值 `96000`、`设为团队负责人` 未勾选——证明配置逐字段继承（编辑器侧证据，与 journey 内八字段 JSON 深比较互为印证）。 |