# EventRail 多端埋点事件治理与发布评审平台

基于 Vue 3、TDesign、Pinia、Vue Router、TanStack Query、Axios、Vite 与 TypeScript 的独立前端工程。项目使用 Axios 自定义本地适配器模拟契约 API，查询缓存由 TanStack Query 管理，业务编辑状态由 Pinia 持久化到浏览器 `localStorage`。

## 功能

- 按业务域维护事件树、多端触发规则、属性和负责人
- 属性类型、枚举、必填条件、同义字段和跨事件血缘
- 重复事件、同义属性、命名越界、类型变化与删除字段引用检查
- JSON 示例的类型、枚举和必填规则校验
- 发布候选契约比较、受影响下游依赖和迁移确认
- 数据、产品、客户端和测试四角色批量审批与发布门禁
- 事件废弃计划、替代事件和迁移说明
- 发布回滚记录与结果验证
- JSON 契约和 Markdown 契约文档导出

## 运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18474`。

## 构建

```bash
npm run build
```

## 数据层

- `src/services/api.ts`：Axios 实例与本地 API 适配器
- `src/composables/useGovernanceQueries.ts`：TanStack Query 查询组合
- `src/stores/governance.ts`：Pinia 编辑、审批、废弃和回滚状态
- `src/services/selectors.ts`：契约比较、影响分析和校验规则
- `src/services/repository.ts`：带全局修订号的持久化信封、乐观锁提交与跨窗口同步

## 候选冻结与一致性

- 创建发布候选时冻结当时的契约修订（事件、属性、平台规则整体快照）与废弃阶段，记录所基于的存储修订号 `baseRevision`
- 冻结后若事件/属性/平台规则被修改，或废弃计划被推进、取消，受影响的迁移确认与四角色审批立即标记为 `invalidated`，旧确认/旧审批一律不得放行，发布门禁同时拦截任何冻结漂移
- 候选页可“按新修订重算”：以已发布基线重新比较差异与受影响依赖、重新冻结契约与废弃阶段；未受漂移影响的确认沿用，受影响确认回到待处理（确认轮次 `epoch` 递增），失效审批回到待处理
- 全局修订号 + 计划/候选自身 `rev` 构成乐观锁：两个窗口同时推进同一废弃计划、重建或发布同一候选时只接受先到版本，冲突方从最新检查点恢复
- 所有写操作带幂等键，候选、审批、迁移确认使用确定性 ID；持久化失败自动从检查点重读并重试，重试不会重复生成确认或审计记录
- 可运行 `npm run test:selftest` 验证上述行为（内存 localStorage 端到端自检）
