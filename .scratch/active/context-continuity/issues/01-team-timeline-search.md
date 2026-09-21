# 01 — Team 用引擎的谱系检索接管 timeline，并接上 search 工具

**What to build:** Member 的 `context_timeline` 由引擎的谱系读取实现，`context_search` / `context_read` 作为新的模型面工具可用；Team 只提供授权范围与该 Member 的 Session 归属，自己那份 timeline candidates 折叠与 threadsEnteringContext 派生退役，`context_timeline` 的模型面行为保持不变。
**Blocked by:** None — can start immediately
**Status:** complete — commit A landed ①②④ (ledger-derived Session lineage, the `dsh-session-query` peer, the engine's search/read factory mounted with Team's scope); commit B landed ③⑤ and re-verified ⑥ on the real Host tests, with the recorded divergences reported in the Thread.

- [x] Team 提供「该主体拥有哪些 Session」：由 ledger + replay 派生 `sessionIdsByMember` 索引，替代今天 timeline 侧的 Session 归属推断
- [x] `ctx.sessionQuery` 进入依赖（发布版四方法 searchSessions / searchEvents / filterEvents / readSession，结构上可直接赋值，host 零 glue）
- [x] `context_timeline` 改走引擎的 `readContextTimeline`；checkpoint / handoff / claim 锚点仍由 Team 的 host hook 归属到 ledger 上的 Thread
- [x] `context_search` / `context_read` 由引擎的工具工厂挂载，scope 由 Team 定义（默认 = 该 Member 自己的 owned Sessions）
- [x] Team 侧 `timelineCandidates` 与 `threadsEnteringContext` 及其重复折叠删除
- [x] 现有 context 测试全绿；三条 `context_*` 工具的模型面文案与错误与今天一致，或差异被明确记录并接受
