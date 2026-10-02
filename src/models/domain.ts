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

export interface MigrationConfirmation {
  id: string
  dependencyId: string
  version: string
  status: 'pending' | 'confirmed' | 'rejected'
  reviewer: string
  note: string
  confirmedAt?: string
  /** 基于旧契约修订作出的确认，在候选失效后立即作废 */
  invalid?: boolean
  invalidatedAt?: string
  invalidatedReason?: ReleaseInvalidReason
}

export interface ReleaseApproval {
  id: string
  role: 'data' | 'product' | 'client' | 'qa'
  actor: string
  status: 'pending' | 'approved' | 'rejected'
  comment: string
  createdAt?: string
  /** 基于旧契约修订作出的审批，在候选失效后立即作废 */
  invalid?: boolean
  invalidatedAt?: string
  invalidatedReason?: ReleaseInvalidReason
}

/** 候选失效原因：事件契约修订、废弃计划推进或废弃计划取消 */
export type ReleaseInvalidReason =
  | 'contract_revised'
  | 'deprecation_advanced'
  | 'deprecation_cancelled'

/** 候选创建时冻结的单事件契约：属性与平台规则不再随后续编辑漂移 */
export interface FrozenEventContract {
  eventId: string
  eventKey: string
  version: string
  status: EventStatus
  trigger: string
  properties: EventProperty[]
  platformRules: PlatformRule[]
  frozenAt: string
}

/** 候选创建时冻结的废弃计划阶段 */
export interface DeprecationStage {
  planId: string
  eventId: string
  status: DeprecationPlan['status']
  reason: string
  owner: string
  stopCollectAt: string
  retireAt: string
  replacementEventId?: string
  migrationNote: string
  updatedAt?: string
}

export interface ReleaseCandidate {
  id: string
  version: string
  title: string
  status: ReleaseStatus
  eventIds: string[]
  affectedDependencyIds: string[]
  differences: ContractDifference[]
  migrationConfirmations: MigrationConfirmation[]
  approvals: ReleaseApproval[]
  createdAt: string
  publishedAt?: string
  /** 创建时冻结的契约与废弃阶段，后续比较、发布均以此为准 */
  frozenContracts?: FrozenEventContract[]
  deprecationStages?: DeprecationStage[]
  /** 冻结时对应的契约修订标识 */
  revision?: string
  /** 冻结后事件被修订或废弃计划被推进/取消，候选需要按新修订重算 */
  stale?: boolean
  invalidatedAt?: string
  invalidatedReason?: ReleaseInvalidReason
  /** 幂等键：同版本同事件范围的重复创建/重试只接受先到版本 */
  idempotencyKey?: string
}

export interface DeprecationPlan {
  id: string
  eventId: string
  replacementEventId?: string
  reason: string
  owner: string
  stopCollectAt: string
  retireAt: string
  status: 'planned' | 'announced' | 'stopped' | 'retired' | 'cancelled'
  migrationNote: string
  /** 乐观并发版本，每次推进/取消递增，并发窗口只接受先到版本 */
  revision?: number
  updatedAt?: string
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
  /** 持久化层乐观并发版本号，每次成功写入递增 */
  stateVersion?: number
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
