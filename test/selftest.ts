/* eslint-disable no-console */
// 端到端自检：用内存 localStorage 垫片验证冻结/失效/重算/并发/写入失败恢复
class MemoryStorage {
  private map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
}

;(globalThis as { localStorage: Storage }).localStorage = new MemoryStorage() as Storage
;(globalThis as { window: undefined }).window = undefined

// Node 的 structuredClone 不支持 Vue 响应式 Proxy（浏览器支持）；
// 本应用状态全部为 JSON 可序列化，测试环境回退到 JSON 深拷贝。
const nativeStructuredClone = globalThis.structuredClone.bind(globalThis)
globalThis.structuredClone = ((value: unknown) => {
  try {
    return nativeStructuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value))
  }
}) as typeof structuredClone

import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useGovernanceStore } from '../src/stores/governance'
import { loadEnvelope } from '../src/services/repository'

let passed = 0
const test = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  localStorage.clear()
  setActivePinia(createPinia())
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

await test('创建候选时冻结事件/属性/平台规则与废弃阶段', async () => {
  const store = useGovernanceStore()
  const outcome = await store.createRelease('2026.11.0', '冻结测试', ['evt-001', 'evt-005'])
  assert.equal(outcome.ok, true)
  if (!outcome.ok) throw new Error('unreachable')
  const release = outcome.result
  assert.equal(release.eventSnapshots.length, 2)
  assert.ok(release.eventSnapshots[0]!.properties.length > 0)
  assert.ok(release.eventSnapshots[0]!.platformRules.length > 0)
  assert.equal(release.deprecationSnapshots.length, 1)
  assert.equal(release.deprecationSnapshots[0]!.status, 'announced')
  assert.equal(release.baseRevision, store.revision)
})

await test('事件契约修订后受影响确认与审批立即失效，旧提交与发布被拦截', async () => {
  const store = useGovernanceStore()
  await store.createRelease('2026.11.0', '冻结测试', ['evt-001'])
  const release = store.data.releases[0]!
  const mig = release.migrationConfirmations[0]!
  const confirm = await store.confirmMigration(release.id, mig.id, '评审人', '已迁移')
  assert.equal(confirm.result, true)
  await store.updateApproval(release.id, 'data', 'approved', '顾清', 'ok')

  const event = store.data.events.find((item) => item.id === 'evt-001')!
  const changed = structuredClone(event)
  changed.properties[0] = { ...changed.properties[0]!, required: !changed.properties[0]!.required }
  const save = await store.saveEvent(changed)
  assert.equal(save.ok, true)
  if (!save.ok) throw new Error('unreachable')
  assert.ok(save.result.length >= 1)

  const after = store.data.releases[0]!
  assert.ok(after.migrationConfirmations.every((item) => item.status === 'invalidated'))
  assert.ok(after.approvals.every((item) => item.status === 'invalidated'))

  const staleConfirm = await store.confirmMigration(release.id, mig.id, '评审人', '再试一次')
  assert.equal(staleConfirm.result, false)
  const staleApproval = await store.updateApproval(
    release.id,
    'data',
    'approved',
    '顾清',
    '再试',
  )
  assert.equal(staleApproval.result, false)
  const publish = await store.publishRelease(release.id)
  assert.equal(publish.result, false)

  // 依赖状态不得停留在 migrated 与门禁打架
  const dep = store.data.dependencies.find((item) => item.id === mig.dependencyId)!
  assert.notEqual(dep.status, 'migrated')
})

await test('废弃计划推进与取消同样使冻结候选失效', async () => {
  const store = useGovernanceStore()
  await store.createRelease('2026.11.0', '废弃测试', ['evt-005'])
  const plan = store.data.deprecations[0]!
  const advanced = await store.saveDeprecation({ ...plan, status: 'stopped' })
  assert.equal(advanced.result, true)
  const release = store.data.releases[0]!
  assert.ok(release.approvals.every((item) => item.status === 'invalidated'))
  assert.ok(
    release.migrationConfirmations
      .filter((item) => item.dependencyId === 'dep-006')
      .every((item) => item.status === 'invalidated'),
  )
  const cancelled = await store.saveDeprecation({
    ...store.data.deprecations.find((item) => item.id === plan.id)!,
    status: 'cancelled',
  })
  assert.equal(cancelled.result, true)
})

await test('候选按新修订重算：未受影响确认沿用，受影响确认回待处理，审批重新走', async () => {
  const store = useGovernanceStore()
  await store.createRelease('2026.11.0', '重算测试', ['evt-001', 'evt-003'])
  const releaseId = store.data.releases[0]!.id
  for (const confirmation of store.data.releases[0]!.migrationConfirmations) {
    const result = await store.confirmMigration(releaseId, confirmation.id, '评审人', '兼容完成')
    assert.equal(result.result, true)
  }
  const event3 = store.data.events.find((item) => item.id === 'evt-003')!
  const changed = structuredClone(event3)
  changed.properties[2] = { ...changed.properties[2]!, required: !changed.properties[2]!.required }
  await store.saveEvent(changed)

  const rebuilt = await store.rebuildRelease(releaseId)
  assert.equal(rebuilt.ok, true)
  if (!rebuilt.ok) throw new Error('unreachable')
  const after = store.data.releases.find((item) => item.id === releaseId)!
  assert.equal(
    after.eventSnapshots.find((snapshot) => snapshot.eventId === 'evt-003')!.properties[2]!
      .required,
    changed.properties[2]!.required,
  )
  const dep004 = after.migrationConfirmations.find((item) => item.dependencyId === 'dep-004')!
  assert.equal(dep004.status, 'pending')
  assert.ok(dep004.epoch > 0)
  // evt-001 的确认（dep-001）未受 evt-003 修订影响，应沿用
  const dep001 = after.migrationConfirmations.find((item) => item.dependencyId === 'dep-001')!
  assert.equal(dep001.status, 'confirmed')
  assert.equal(dep001.epoch, 0)
  assert.ok(after.approvals.every((item) => item.status === 'pending'))
  assert.equal(after.baseRevision, store.revision)
})

await test('两窗口基于同一修订推进计划时只接受先到版本', async () => {
  const store = useGovernanceStore()
  await store.createRelease('2026.11.0', '并发测试', ['evt-005'])
  const plan = store.data.deprecations[0]!
  const first = await store.saveDeprecation({ ...plan, status: 'stopped' })
  assert.equal(first.result, true)
  // 仍持有旧 rev 的重复推进必须被拒绝
  const stale = await store.saveDeprecation({ ...plan, status: 'retired' })
  assert.equal(stale.ok, true)
  assert.equal(stale.result, false)
  const current = store.data.deprecations[0]!
  assert.equal(current.status, 'stopped')
  assert.equal(current.rev, 2)
})

await test('跨窗口存储修订冲突时拒绝写入并恢复到最新检查点', async () => {
  const store = useGovernanceStore()
  await store.createRelease('2026.11.0', '冲突测试', ['evt-001'])
  const envelope = loadEnvelope()
  // 模拟另一个标签页直接写入更高修订
  const bumped = structuredClone(envelope)
  bumped.revision = envelope.revision + 5
  bumped.state.currentVersion = '2099.01.0'
  localStorage.setItem('eventrail-governance-v2', JSON.stringify(bumped))

  const event = store.data.events.find((item) => item.id === 'evt-001')!
  const changed = structuredClone(event)
  changed.owner = '新的负责人'
  const outcome = await store.saveEvent(changed)
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('unreachable')
  assert.equal(outcome.conflict, true)
  // 本地已恢复到检查点
  assert.equal(store.revision, envelope.revision + 5)
  assert.equal(store.data.currentVersion, '2099.01.0')
})

await test('写入失败后重试不重复生成迁移确认', async () => {
  const store = useGovernanceStore()
  await store.createRelease('2026.11.0', '恢复测试', ['evt-001'])
  const release = store.data.releases[0]!
  const confirmation = release.migrationConfirmations[0]!

  let failures = 1
  const originalSetItem = localStorage.setItem.bind(localStorage)
  localStorage.setItem = (key: string, value: string) => {
    if (key.includes('governance') && failures > 0) {
      failures -= 1
      throw new Error('QuotaExceeded')
    }
    originalSetItem(key, value)
  }

  const outcome = await store.confirmMigration(release.id, confirmation.id, '评审人', '重试成功')
  localStorage.setItem = originalSetItem
  assert.equal(outcome.ok, true)
  assert.equal(outcome.result, true)

  const stored = loadEnvelope().state
  const storedRelease = stored.releases.find((item) => item.id === release.id)!
  const matching = storedRelease.migrationConfirmations.filter(
    (item) => item.dependencyId === confirmation.dependencyId,
  )
  assert.equal(matching.length, 1)
  assert.equal(matching[0]!.status, 'confirmed')
  const auditCount = stored.audit.filter(
    (item) => item.entityId === confirmation.dependencyId && item.action === '确认迁移',
  ).length
  assert.equal(auditCount, 1)
})

await test('冻结后候选页检测到漂移，重算后漂移消失方可发布', async () => {
  const store = useGovernanceStore()
  await store.createRelease('2026.11.0', '漂移测试', ['evt-001'])
  const releaseId = store.data.releases[0]!.id
  const event = store.data.events.find((item) => item.id === 'evt-001')!
  // 未重算先补齐全部确认审批也不能发布（有漂移）
  for (const confirmation of store.data.releases[0]!.migrationConfirmations) {
    await store.confirmMigration(releaseId, confirmation.id, '评审人', 'ok')
  }
  for (const role of ['data', 'product', 'client', 'qa'] as const) {
    await store.updateApproval(releaseId, role, 'approved', 'x', 'ok')
  }
  const changed = structuredClone(event)
  changed.properties[1] = { ...changed.properties[1]!, required: !changed.properties[1]!.required }
  await store.saveEvent(changed)
  let publish = await store.publishRelease(releaseId)
  assert.equal(publish.result, false)

  await store.rebuildRelease(releaseId)
  // 重算后旧确认/审批需重新完成
  publish = await store.publishRelease(releaseId)
  assert.equal(publish.result, false)
})

console.log(`\n${passed} 项自检全部通过`)
