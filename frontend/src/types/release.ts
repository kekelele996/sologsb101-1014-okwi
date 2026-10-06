/**
 * 班组放行申请（ReleaseRequest）——班组侧留底
 * 班组领苗按批次报放行申请；苗圃没有合格结论或隔离期未满时申请挂起，
 * 等苗圃出结论 / 隔离期满后由系统重算。一个苗木批次只允许有一条申请。
 *
 * 状态由「申请时刻 + 当前检疫台账」派生：
 * - 已放行：终态，之后检疫结论再怎么改也不动（栽植记录写明依据的是哪一版）；
 * - 挂起-待检：苗圃还没出检疫结论；
 * - 挂起-不合格：检疫结论为不合格；
 * - 挂起-隔离期：结论合格但隔离期未满。
 */

/** 放行申请状态（挂起原因都以「挂起」开头，便于按前缀过滤） */
export type ReleaseState = '挂起-待检' | '挂起-不合格' | '挂起-隔离期' | '已放行';

export const RELEASE_STATE_OPTIONS: ReleaseState[] = ['挂起-待检', '挂起-不合格', '挂起-隔离期', '已放行'];

/** 放行申请是否处于挂起（未放行）状态 */
export function isHeldState(state: ReleaseState): boolean {
  return state !== '已放行';
}

export interface ReleaseRequest {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 申请领用的苗木批次（一批一条） */
  seedlingId: string;
  /** 申请株数（默认该批次进场数量） */
  requestCount: number;
  /** 班组提交申请日期 YYYY-MM-DD */
  applyDate: string;
  /** 申请班组 */
  operator: string;
  /** 当前派生状态 */
  state: ReleaseState;
  /** 挂起 / 放行说明（如「隔离期至 2024-04-21」） */
  reason: string;
  /** 放行日期 YYYY-MM-DD（未放行时为空） */
  releasedAt: string;
  /**
   * 放行时依据的检疫版本（已放行才有值）。
   * 之后苗圃改了结论，已放行的申请不动，靠它说明依据哪一版。
   */
  basisVersion: number | null;
  /** 放行时依据的检疫结论快照 */
  basisConclusion: string | null;
  /** 放行时依据的隔离期满日期快照 */
  basisIsolationUntil: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 班组报放行申请的表单草稿 */
export interface ReleaseDraft {
  plotId: string;
  seedlingId: string;
  requestCount: number;
  applyDate: string;
  operator: string;
}
