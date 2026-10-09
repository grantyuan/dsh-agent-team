# Validation — member prompt profile 浏览器验收里程碑

复跑命令（仓库根）：

```sh
CHROME_PATH=/usr/local/bin/chromium npm run test:browser
```

产出 run：2026-10-10 02:37（本地时区）第二次执行，commit `fa73a46`（master，工作区 clean），5/5 journey 测试全绿。第一次执行（02:30）主 journey 因宿主机 inotify watch 耗尽（chokidar `ENOSPC`）在首张截图前 120s 超时，属环境资源问题，与代码无关；同环境重跑即恢复。逐张审查由验收 sweep 完成（桌面 + 390×844，无横向溢出——journey 内亦有 `scrollWidth <= 390` 的机械断言）。

以下 6 张为该工作项的里程碑集（Human 终审确认后随工作项归档）：

| 文件 | 证明的验收点 |
| --- | --- |
| `agent-editor-context-desktop.png` | 编辑 Agent 对话框（桌面）：任务启动上下文块——continue/fresh 策略选择器 + 上下文窗口覆盖输入（含 8192 下限提示）——与自定义提示词入口同场渲染。 |
| `agent-create-context-390.png` | 创建 Agent 表单（390×844）：上下文块（策略选择器、窗口覆盖占位「跟随模型路由窗口」）与段落暂存入口按窄断点堆叠，无横向溢出。 |
| `agent-prompt-dialog-sections-desktop.png` | Prompt 对话框（桌面）：section 清单逐行带字节数、窗口内映射调用数与徽标——受保护行勾选禁用（`deployment:persona-prefix`）、纯散文行「无自动信号」、零调用工具映射行「长期未用」。 |
| `agent-prompt-prune-confirm-panel.png` | auto-prune 确认面板：带边框的「建议移除的段落」候选清单 + 两个动作（确认移除 / 移除并不再确认），受保护行不入候选；下方为使用 LLM 策划输入。 |
| `agent-prompt-curation-backfilled.png` | LLM 策划 propose-only 回填：「建议启用的技能」提案面板（还原可操作）、保存按钮转为可用——提案只回填表单，提交仍走同一次合并保存。 |
| `agent-prompt-dialog-390.png` | Prompt 对话框（390×844）：对话框收窄至视口内，section 行徽标换行排列，无横向溢出，取消/保存可达。 |
