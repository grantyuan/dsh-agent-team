# 在成员提示词中要求及时更新对话页「任务」清单（todo_write）

## Context（背景）

用户截图确认：成员会话对话页底部的「任务」卡（如「任务 1 进行中 · 7 待处理」）来自 Harness `tool-todo` 的 `todo_write` 工具。问题：agent 开头一次性拆分步骤写入清单后很少再刷新，状态长期滞后。

用户决策：**采用最小改动——只在提示词层面要求 agent 及时更新**，不新增注入行、不做状态镜像。

落点：本仓库唯一自有且常驻的模型提示词接缝是 [member-context.ts](file:///home/yus/work/dsh-agent-team/packages/agent-team/src/member-context.ts) 的每步注入块（Team identity + 私有记忆 + Workspace 参与，经 `alreadyVisible` 去重后常驻上下文）。在其身份行后追加一行常驻的清单纪律文字即可。`todo_write` 的工具描述归 Harness 所有，不改 Harness。

如实说明取舍：纯提示词是最弱的杠杆（工具描述里已有类似要求但 agent 仍会忘）；此改动一行落地，先日驱动观察效果，若仍频繁遗忘再升级为状态镜像（镜像方案已探索完毕，可随时启用）。

## 实现

### 1. `packages/agent-team/src/member-context.ts`

- 新增导出纯函数 `renderTodoDiscipline(): string`（与 `renderMemberIdentity` 同风格，便于单测），返回一行英文纪律（模型面文字与本仓库其他注入一致为英文），要点：
  - 用 `todo_write` 拆分多步工作后，**保持清单与工作同步**：开始一步前标 `in_progress`，完成那一刻标 `completed`，工作揭示新步骤就补写；
  - 发布进展汇报或收尾（任务结束）前先刷新清单——**对话页的「任务」卡渲染的就是这份清单**，人正盯着它。
- 在 `apply` 的注入文本拼接处，把该行接在 `renderMemberIdentity(member)` 之后（`${identity}\n${todoDiscipline}\n\n${memory}…`），使其随身份块常驻。
- 行文保持一行、短句，不加多余标题。

### 2. 测试 `packages/agent-team/tests/member-context.spec.ts`

- 新增 `renderTodoDiscipline` 断言：包含 `todo_write`、三种状态要求（in_progress / completed）、以及「汇报前先刷新」要点；确认拼接后身份行在前（可在现有 identity describe 内补一条组合断言）。

### 3. 文档与变更记录

- `docs/team-collaboration/memory-and-context.md` + `.zh.md`：成员注入段落补一句「身份块携带 todo 清单纪律行」。
- `CHANGELOG.md` 新增一条用户可见行为条目。

## 明确不做

- 不修改 `../deepseek-harness`；不改 `cordis.patch.yml`、不新增导出、不动 `scripts/sync-paths.mjs`。
- 不做状态镜像 / per-step 注入行（作为后续升级项备选，不在本次范围）。

## 验证

1. `npm run typecheck`
2. `npx vitest run packages/agent-team/tests/member-context.spec.ts` 后跑全量 `npm run test`
3. `npm run check:docs`
4. 人工验收（dev profile `dsh web --profile web-dev`）：给成员安排一个多步骤任务，观察对话页任务卡状态是否随步骤推进刷新；若仍频繁停滞，再启用镜像方案。
