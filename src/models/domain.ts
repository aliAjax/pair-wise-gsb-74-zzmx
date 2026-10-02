export type Platform = 'web' | 'ios' | 'android' | 'server' | 'miniprogram'
export type EventStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'deprecated' | 'retired'
export type PropertyType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'
export type ReleaseStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'rolled_back'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface EventProperty {
  id: string
  eventId: string
  name: string
  displayName: string
  type: PropertyType
  required: boolean
  description: string
  enumValues: string[]
  owner: string
  synonyms: string[]
  platforms: Platform[]
  lineageSourceId?: string
  deletedAt?: string
}

export interface PlatformRule {
  id: string
  eventId: string
  platform: Platform
  enabled: boolean
  trigger: string
  owner: string
  requiredPropertyIds: string[]
  note: string
}

export interface EventDefinition {
  id: string
  key: string
  displayName: string
  category: string
  description: string
  trigger: string
  status: EventStatus
  version: string
  owner: string
  properties: EventProperty[]
  platformRules: PlatformRule[]
  scenarioIds: string[]
  downstreamDependencyIds: string[]
  updatedAt: string
}

export interface BusinessScenario {
  id: string
  name: string
  domain: string
  owner: string
  platform: Platform
  eventIds: string[]
  status: 'active' | 'migrating' | 'retired'
}

export interface DownstreamDependency {
  id: string
  name: string
  type: 'dashboard' | 'alert' | 'model' | 'dataset' | 'experiment'
  owner: string
  environment: 'production' | 'staging' | 'analysis'
  eventIds: string[]
  propertyRefs: Array<{ eventId: string; propertyId: string }>
  status: 'active' | 'migration_required' | 'migrated' | 'disabled'
}

export interface EventVersionSnapshot {
  id: string
  eventId: string
  version: string
  properties: EventProperty[]
  createdAt: string
  status: 'published' | 'superseded'
}

export interface ContractDifference {
  eventId: string
  eventKey: string
  addedProperties: string[]
  removedProperties: string[]
  requiredChanges: string[]
  typeChanges: string[]
  enumChanges: string[]
}

export type MigrationConfirmationStatus = 'pending' | 'confirmed' | 'rejected' | 'invalidated'
export type ReleaseApprovalStatus = 'pending' | 'approved' | 'rejected' | 'invalidated'

export interface MigrationConfirmation {
  id: string
  dependencyId: string
  version: string
  status: MigrationConfirmationStatus
  reviewer: string
  note: string
  confirmedAt?: string
  /** 确认轮次：候选按新修订重算后递增，保证重试幂等键不会命中已作废的旧确认 */
  epoch: number
  /** 候选契约修订或废弃阶段变化后，旧确认立即失效的原因 */
  invalidatedReason?: string
}

export interface ReleaseApproval {
  id: string
  role: 'data' | 'product' | 'client' | 'qa'
  actor: string
  status: ReleaseApprovalStatus
  comment: string
  createdAt?: string
  invalidatedReason?: string
}

/** 候选创建时冻结的单事件契约修订（事件、属性、平台规则一并固化） */
export interface CandidateEventSnapshot {
  eventId: string
  key: string
  displayName: string
  category: string
  description: string
  trigger: string
  status: EventStatus
  version: string
  owner: string
  properties: EventProperty[]
  platformRules: PlatformRule[]
  frozenAt: string
}

/** 候选创建时冻结的废弃阶段 */
export interface CandidateDeprecationSnapshot {
  planId: string
  eventId: string
  replacementEventId?: string
  status: DeprecationPlan['status']
  stopCollectAt: string
  retireAt: string
  migrationNote: string
  frozenAt: string
}

export interface ReleaseCandidate {
  id: string
  /** 候选自身的乐观锁修订号，重建只接受先到版本 */
  rev: number
  /** 创建时冻结所基于的全局存储修订号（契约修订） */
  baseRevision: number
  version: string
  title: string
  status: ReleaseStatus
  eventIds: string[]
  affectedDependencyIds: string[]
  differences: ContractDifference[]
  migrationConfirmations: MigrationConfirmation[]
  approvals: ReleaseApproval[]
  eventSnapshots: CandidateEventSnapshot[]
  deprecationSnapshots: CandidateDeprecationSnapshot[]
  createdAt: string
  rebuiltAt?: string
  publishedAt?: string
}

export interface DeprecationPlan {
  id: string
  /** 计划自身的乐观锁修订号，推进/取消只接受先到版本 */
  rev: number
  eventId: string
  replacementEventId?: string
  reason: string
  owner: string
  stopCollectAt: string
  retireAt: string
  status: 'planned' | 'announced' | 'stopped' | 'retired' | 'cancelled'
  migrationNote: string
  updatedAt: string
}

export interface RollbackRecord {
  id: string
  releaseId: string
  version: string
  reason: string
  operator: string
  scope: string
  createdAt: string
  status: 'executed' | 'verified'
  evidence: string
}

export interface AuditEvent {
  id: string
  entityType: string
  entityId: string
  action: string
  actor: string
  detail: string
  createdAt: string
}

export interface GovernanceState {
  events: EventDefinition[]
  scenarios: BusinessScenario[]
  dependencies: DownstreamDependency[]
  baselines: EventVersionSnapshot[]
  releases: ReleaseCandidate[]
  deprecations: DeprecationPlan[]
  rollbacks: RollbackRecord[]
  audit: AuditEvent[]
  currentVersion: string
}

/** 持久化信封：全局修订号 + 已落库的幂等写键，用于跨窗口乐观锁与重试去重 */
export interface GovernanceEnvelope {
  revision: number
  state: GovernanceState
  appliedWrites: Array<{ key: string; at: string }>
}

export interface ValidationIssue {
  id: string
  kind:
    | 'duplicate_event'
    | 'synonym_property'
    | 'naming_violation'
    | 'type_change'
    | 'deleted_property_referenced'
    | 'required_mismatch'
  severity: Severity
  title: string
  detail: string
  entityId: string
  suggestion: string
}

export interface SampleValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}
