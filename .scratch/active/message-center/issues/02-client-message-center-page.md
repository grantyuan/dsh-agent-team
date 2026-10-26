# 02 — Client 消息中心页面

**What to build:** 侧栏有一个可进入的「消息中心」入口，打开后右侧工作区是一个双 tab 页面：「所有讨论」与「我的消息」，共用一条搜索栏（文本 + 时间范围 + Channel 过滤）。页面跨可见 Workspace 聚合，按 Workspace → Channel 分组，具备加载、空、错误三态，键盘可达，窄屏可用。刷新、返回、切换 Workspace 后不串面。
**Blocked by:** 01
**Status:** done

- [x] 新导航面 `messages` 与 `inbox`/`tasks` 同级：快照读写、每个 setter 的互斥清理、`leaveThread` 分流同时更新，任意两个面不会同真
- [x] 侧栏入口可进入与退出该页面；浏览器刷新后从持久化快照恢复同一页面
- [x] 两个 tab 共用同一搜索状态；切换 tab 不丢失输入；清空可回到完整列表
- [x] 「所有讨论」行展示 Channel、主题、最后活动时间、参与者、我参与标记、未读与 claim 徽标，点击进入该 Thread
- [x] 「我的消息」行展示方向徽标、发送者、时间、摘要、回复上下文、处理痕迹胶囊
- [x] 跨 Workspace 合并遵循单一排序口径（时间降序，同刻按稳定键），分页可继续加载，不会因合并而打乱
- [x] 空结果、加载中、Remote 失败三态各有明确文案与重试；失败不影响另一 tab
- [x] 键盘可达（tab 可切换、行可聚焦、Enter 进入）、焦点可见、390×844 无横向溢出
- [x] 组件测试覆盖导航面互斥、搜索状态共享、分组与排序、三态渲染

> 落地备注：跨 Workspace 合并的排序由 Host 序号重排（sequence 降序），分组按 Workspace → Channel，私信行单独成组。`npm run test:browser` 证据见 issue 04。
