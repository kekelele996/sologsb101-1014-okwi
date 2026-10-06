/**
 * 放行申请（ReleaseRequest）——班组上下文
 * 班组领苗下滩前按批次向苗圃报放行申请：没检疫或还在隔离期内的先挂起，
 * 等苗圃出结论。只有已放行的批次才能进入栽植，挂起批次不计栽植总株数、不出补植计划。
 * 检疫结论改动时，尚未放行的申请跟着重算；已放行/已栽植的照旧留着并写明依据的结论版本。
 */

/** 放行申请状态：挂起 / 已放行 / 已驳回 */
export type ReleaseState = '挂起' | '已放行' | '已驳回';

export const RELEASE_STATE_OPTIONS: ReleaseState[] = ['挂起', '已放行', '已驳回'];

/** 状态 → 徽标配色 */
export const RELEASE_STATE_COLOR: Record<ReleaseState, string> = {
  挂起: 'orange',
  已放行: 'green',
  已驳回: 'red',
};

/** 挂起原因：没检疫（待检/无档案） / 还在隔离期内 / 检疫不合格 */
export type ReleaseHoldReason = '无检疫结论' | '隔离期内' | '检疫不合格';

export const RELEASE_HOLD_REASON_LABEL: Record<ReleaseHoldReason, string> = {
  无检疫结论: '尚无检疫结论，待苗圃出结论',
  隔离期内: '隔离期未满，暂缓放行',
  检疫不合格: '检疫不合格，不予放行',
};

export interface ReleaseRequest {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 申请放行的苗木批次 */
  seedlingId: string;
  /** 申请领苗数量（株） */
  quantity: number;
  /** 领苗班组 */
  operator: string;
  /** 申请日期 YYYY-MM-DD */
  requestDate: string;
  /** 放行状态 */
  state: ReleaseState;
  /** 挂起时的原因；非挂起状态为空串 */
  holdReason: ReleaseHoldReason | '';
  /** 重算依据的检疫结论版本；尚未放行时随结论改动刷新 */
  quarantineVersion: number;
  /**
   * 放行快照：放行那一刻的检疫结论留底。
   * 之后苗圃再改结论也不动它——「栽下去的照旧留着并写明依据哪一版」。
   */
  releasedConclusion: string;
  /** 放行日期 YYYY-MM-DD；未放行时为空串 */
  releasedAt: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建放行申请的表单草稿 */
export interface ReleaseDraft {
  plotId: string;
  seedlingId: string;
  quantity: number;
  operator: string;
  requestDate: string;
}

/** 纯函数算出的放行判定结果（不写库，供页面与重算共用同一口径） */
export interface ReleaseDecision {
  state: ReleaseState;
  holdReason: ReleaseHoldReason | '';
  /** 隔离截止日期 YYYY-MM-DD（isolatedFrom + isolationDays） */
  isolationUntil: string;
  /** 申请当日是否仍在隔离期内 */
  inIsolation: boolean;
}
