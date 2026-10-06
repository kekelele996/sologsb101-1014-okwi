/**
 * 苗圃检疫台账（Quarantine）——苗圃侧留底
 * 每个苗木批次一条，登记检疫结论与隔离期；与批次进场账（seedlings）分开保管。
 * 结论 / 结论日期 / 隔离期有改动时 version +1，旧版本留在 history 里可追溯。
 */

/** 检疫结论：待检（还没出结论）/ 合格 / 不合格 / 复检合格 */
export type QuarantineConclusion = '待检' | '合格' | '不合格' | '复检合格';

export const QUARANTINE_CONCLUSION_OPTIONS: QuarantineConclusion[] = ['待检', '合格', '不合格', '复检合格'];

/** 「可放行」口径下的结论：合格 / 复检合格 */
export const RELEASABLE_CONCLUSIONS: QuarantineConclusion[] = ['合格', '复检合格'];

/** 默认隔离期（天），新建台账时预填 */
export const DEFAULT_ISOLATION_DAYS = 7;

/** 一条检疫结论的历史版本（栽下去的苗要能回溯到当时依据的是哪一版） */
export interface QuarantineHistoryEntry {
  version: number;
  conclusion: QuarantineConclusion;
  /** 该版结论签发日期 YYYY-MM-DD */
  conclusionDate: string;
  /** 该版要求的隔离期（天） */
  isolationDays: number;
  note: string;
  /** 该版写入时间 ISO */
  changedAt: string;
}

export interface Quarantine {
  id: string;
  /** 所属地块（冗余自苗木批次，便于按地块查苗圃账） */
  plotId: string;
  /** 对应的苗木批次（一批一条） */
  seedlingId: string;
  /** 当前检疫结论 */
  conclusion: QuarantineConclusion;
  /** 当前结论签发日期 YYYY-MM-DD（待检时可为空） */
  conclusionDate: string;
  /** 隔离期（天），从结论签发日期次日起算 */
  isolationDays: number;
  /** 隔离期满日期（派生展示用）：conclusionDate + isolationDays */
  isolationUntil: string;
  /** 备注（复检说明等） */
  note: string;
  /** 当前版本号，从 1 起；结论改动时 +1 */
  version: number;
  /** 历版结论留痕（含当前版） */
  history: QuarantineHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 苗圃出 / 改检疫结论的表单草稿 */
export interface QuarantineDraft {
  conclusion: QuarantineConclusion;
  conclusionDate: string;
  isolationDays: number;
  note: string;
}

/**
 * 判定结论是否可以放行（合格 / 复检合格才算过检疫关）。
 * 待检、不合格都视为还没过检疫。
 */
export function isReleasableConclusion(conclusion: QuarantineConclusion): boolean {
  return RELEASABLE_CONCLUSIONS.includes(conclusion);
}
