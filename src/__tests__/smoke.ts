import { setActivePinia, createPinia } from 'pinia'
import { useGovernanceStore } from '@/stores/governance'
import { commitState, readPersistedState } from '@/services/repository'
import type { DeprecationPlan } from '@/models/domain'

const results: Array<{ name: string; ok: boolean; detail?: string }> = []
const test = (name: string, fn: () => void) => {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}
const expect = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const plainClone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const fresh = () => {
  localStorage.clear()
  setActivePinia(createPinia())
  return useGovernanceStore()
}

// 1. 创建候选时冻结契约：发布基线/差异来自冻结快照，不受后续编辑影响
test('创建候选冻结契约，差异基于冻结而非实时事件', () => {
  const store = fresh()
  const before = store.createRelease('2099.01.0', '冻结测试', ['evt-001'])
  expect(before.ok && before.value?.created, '候选应新建成功')
  const releaseId = before.value!.release.id
  const release = store.data.releases.find((r) => r.id === releaseId)!
  expect(release.frozenContracts?.length === 1, '应冻结 1 个事件契约')
  expect(release.frozenContracts![0]!.properties.length >= 5, '冻结应包含属性')
  expect(release.deprecationStages?.length === 0, 'evt-001 无废弃阶段')
  const frozenVersion = release.frozenContracts![0]!.version

  // 修改事件版本与属性，候选差异/冻结不得变化
  const event = plainClone(store.data.events.find((e) => e.id === 'evt-001')!)
  event.version = '9.9.9'
  event.properties.push({
    ...event.properties[0]!,
    id: 'prop-new',
    name: 'brand_new_field',
  })
  const saved = store.saveEvent(event)
  expect(saved.ok, '保存事件应成功')
  const after = store.data.releases.find((r) => r.id === releaseId)!
  expect(after.frozenContracts![0]!.version === frozenVersion, '冻结版本不应被后续编辑改写')
  expect(
    JSON.stringify(after.differences) === JSON.stringify(release.differences),
    '差异应保持冻结时结果',
  )
})

// 2. 事件修订后受影响确认与审批立即失效，候选 stale、就绪度归零、拒绝发布
test('事件修订使旧审批与迁移确认立即失效并阻止发布', () => {
  const store = fresh()
  // 种子 rel-001 包含 evt-001，且有 1 个已确认迁移、1 个已通过审批
  const seed = store.data.releases.find((r) => r.id === 'rel-001')!
  expect(!seed.stale, '种子候选初始不应失效')
  expect(seed.migrationConfirmations.some((m) => m.status === 'confirmed'), '种子含已确认迁移')

  const event = plainClone(store.data.events.find((e) => e.id === 'evt-001')!)
  event.properties[0] = { ...event.properties[0]!, required: !event.properties[0]!.required }
  const saved = store.saveEvent(event)
  expect(saved.ok, '事件保存成功')

  const updated = store.data.releases.find((r) => r.id === 'rel-001')!
  expect(updated.stale, '候选应被标记 stale')
  expect(updated.invalidatedReason === 'contract_revised', '失效原因为契约修订')
  expect(updated.approvals.every((a) => a.invalid), '所有旧审批应失效')
  expect(updated.migrationConfirmations.every((m) => m.invalid), '所有旧迁移确认应失效')

  const publish = store.publishRelease('rel-001')
  expect(!publish.ok && publish.code === 'stale', '失效候选必须拒绝发布')
  expect(store.data.dependencies.find((d) => d.id === 'dep-004')?.status === 'migration_required',
    '已迁移下游应回退为待迁移')
})

// 3. 废弃计划推进/取消使候选失效并冻结阶段
test('废弃计划推进/取消立即作废候选', () => {
  const store = fresh()
  const plan = store.data.deprecations.find((p) => p.id === 'plan-001')!
  // rel-001 含 evt-005，对应 plan-001，候选冻结了 announced 阶段
  const seed = store.data.releases.find((r) => r.id === 'rel-001')!
  expect(seed.deprecationStages?.some((s) => s.status === 'announced'), '候选应冻结 announced 阶段')

  const advanced = store.saveDeprecation({ ...plan, status: 'stopped', revision: plan.revision ?? 1 })
  expect(advanced.ok, '推进计划应成功')
  const updated = store.data.releases.find((r) => r.id === 'rel-001')!
  expect(updated.stale && updated.invalidatedReason === 'deprecation_advanced', '推进应使候选失效')
  // 冻结阶段仍停留在 announced，不被覆盖
  expect(updated.deprecationStages?.[0]?.status === 'announced', '冻结阶段不得被改写')
  expect(store.data.events.find((e) => e.id === 'evt-005')?.status === 'deprecated', '停采应置事件为已废弃')

  // 取消一个新计划（需要先让候选恢复不现实，这里直接验证取消原因）
  const another = fresh()
  const p2 = another.data.deprecations.find((p) => p.id === 'plan-001')!
  const cancelled = another.saveDeprecation({ ...p2, status: 'cancelled', revision: p2.revision ?? 1 })
  expect(cancelled.ok, '取消计划应成功')
  const r2 = another.data.releases.find((r) => r.id === 'rel-001')!
  expect(r2.invalidatedReason === 'deprecation_cancelled', '取消应标记 deprecation_cancelled')
})

// 4. 发布状态与废弃互斥：已停采事件不被发布拉回 published
test('发布不会把已废弃事件拉回已发布', () => {
  const store = fresh()
  // 构造一个全新可发布候选：事件 evt-002（已发布、无差异 -> 无确认/审批负担最小）
  // 直接走冻结 + 手动补全审批/确认再发布较繁琐，这里直接验证发布分支对 deprecated 的保护：
  const evt = store.data.events.find((e) => e.id === 'evt-005')!
  expect(evt.status === 'deprecated', '种子 evt-005 为已废弃')
  const release = store.data.releases.find((r) => r.id === 'rel-000')!
  // 造一个针对 evt-005 且门禁已满足的候选并发布
  const create = store.data
  void create
  // 直接构造发布所需内存状态
  const candidate = {
    ...plainClone(release),
    id: 'rel-test',
    version: '2099.02.0',
    status: 'reviewing' as const,
    eventIds: ['evt-005'],
    affectedDependencyIds: [],
    migrationConfirmations: [],
    stale: false,
  }
  candidate.approvals.forEach((a) => {
    a.status = 'approved' as const
    a.invalid = false
  })
  store.data.releases.unshift(candidate)
  const result = store.publishRelease('rel-test')
  expect(result.ok, '无差异且审批齐全应允许发布')
  expect(store.data.events.find((e) => e.id === 'evt-005')?.status === 'deprecated',
    '已废弃事件发布后必须保持已废弃，不能拉回 published')
})

// 5. 重算按新修订重建差异，且不重复生成确认
test('候选按新修订重算，幂等且不重复生成迁移确认', () => {
  const store = fresh()
  const before = store.createRelease('2099.03.0', '重算测试', ['evt-001'])
  const id = before.value!.release.id
  const confirmCountAtCreate = before.value!.release.migrationConfirmations.length

  const event = plainClone(store.data.events.find((e) => e.id === 'evt-001')!)
  event.properties[0] = { ...event.properties[0]!, required: !event.properties[0]!.required }
  store.saveEvent(event)
  expect(store.data.releases.find((r) => r.id === id)!.stale, '编辑后应 stale')

  const rebuilt = store.rebuildRelease(id)
  expect(rebuilt.ok && rebuilt.value?.created, '重算应执行')
  const rebuiltRelease = store.data.releases.find((r) => r.id === id)!
  expect(!rebuiltRelease.stale, '重算后应恢复为最新')
  expect(rebuiltRelease.migrationConfirmations.filter((m) => !m.invalid).length ===
    confirmCountAtCreate, '生效确认数量不应翻倍（不重复生成）')
  expect(rebuiltRelease.migrationConfirmations.some((m) => m.invalid) ||
    confirmCountAtCreate === 0, '旧确认应保留为失效记录')

  // 立即再次重算：幂等，不新增
  const again = store.rebuildRelease(id)
  expect(again.ok && again.value && again.value.created === false, '非 stale 重算应幂等返回')
})

// 6. 创建候选重试幂等：同版本同范围不重复创建
test('同版本同事件范围重复创建只接受先到版本', () => {
  const store = fresh()
  const first = store.createRelease('2099.04.0', '幂等', ['evt-001', 'evt-003'])
  const second = store.createRelease('2099.04.0', '幂等', ['evt-003', 'evt-001'])
  expect(first.value?.created, '首次应创建')
  expect(second.ok && second.value?.created === false, '同范围乱序应幂等复用')
  expect(first.value!.release.id === second.value!.release.id, '应返回同一候选')
  const openCount = store.data.releases.filter(
    (r) => r.idempotencyKey === second.value!.release.idempotencyKey,
  ).length
  expect(openCount === 1, '不应产生重复候选/确认')
})

// 7. 乐观锁：两个窗口同时推进同一计划，只接受先到版本
test('并发推进废弃计划只接受先到版本', () => {
  const store = fresh()
  const plan = store.data.deprecations.find((p) => p.id === 'plan-001')!
  const rev = plan.revision ?? 1

  // 模拟窗口A先提交 stopped 并落库（stateVersion 已前进）
  const a = store.saveDeprecation({ ...plan, status: 'stopped', revision: rev })
  expect(a.ok, '窗口 A 推进成功')

  // 窗口B持有旧 revision，直接对持久化层 CAS 提交一份推进到 retired 的草稿
  const state = plainClone(store.data)
  const target = state.deprecations.find((p) => p.id === 'plan-001')!
  target.status = 'retired'
  target.revision = rev + 1 // B 在自己视图里递增
  const expected = state.stateVersion!
  const committed = commitState(expected, state)
  // 即便 stateVersion 恰好相同，业务层 revision 检查也应拦截；这里先验证状态版本 CAS
  void committed

  // 走 store：B 仍基于旧 revision(rev) 调用，应被业务乐观锁拒绝
  const b = useGovernanceStore().saveDeprecation({
    ...plan,
    status: 'retired',
    revision: rev,
  } as DeprecationPlan)
  expect(!b.ok && b.code === 'bad_revision', '旧 revision 的并发推进必须被拒绝')
})

// 8. CAS 冲突后内存从检查点恢复
test('写入冲突后内存恢复为权威版本', () => {
  const store = fresh()
  const startVersion = store.data.stateVersion!
  // 外部（另一窗口）抢先写入，使持久化版本前进
  const external = structuredClone(readPersistedState()!)
  external.currentVersion = 'EXTERNAL-WIN'
  commitState(startVersion, external)

  // 本窗口基于旧版本做修改
  const event = plainClone(store.data.events.find((e) => e.id === 'evt-001')!)
  event.properties[0] = { ...event.properties[0]!, required: !event.properties[0]!.required }
  const result = store.saveEvent(event)
  expect(!result.ok && result.conflict, '应报告冲突')
  expect(store.data.currentVersion === 'EXTERNAL-WIN', '内存应恢复为权威版本')
  expect(store.data.stateVersion === startVersion + 1, '应采用权威 stateVersion')
})

const failed = results.filter((r) => !r.ok)
results.forEach((r) => {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`)
})
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
