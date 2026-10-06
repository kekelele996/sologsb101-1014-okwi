/**
 * 班组侧放行状态管理（Zustand）——只管领苗放行申请。
 * 班组按批次报放行申请：没检疫或还在隔离期内的先挂起，等苗圃出结论；
 * 挂起批次不计栽植总株数、不出补植计划。
 * 放行那一刻固化「依据第 N 版结论」快照，之后苗圃改结论也不动已放行/已栽植的。
 */
import { create } from 'zustand';
import type { ReleaseDraft, ReleaseRequest } from '../types/release';
import {
  initDatabase,
  putReleaseRequest,
  recalcOpenReleaseRequests,
  removeReleaseRequest,
} from '../utils/db';
import type { Quarantine } from '../types/quarantine';
import { evaluateRelease, releaseSnapshotText } from '../utils/quarantine';
import { nowIso, today, uuid } from '../utils/id';

interface ReleaseStoreState {
  /** 每次写操作后的版本号，页面据此重新派生 */
  revision: number;
  init: () => Promise<void>;
  /**
   * 班组按批次报放行申请：按当日检疫结论判定挂起 / 放行 / 驳回。
   * 合格且隔离期满的直接放行并固化结论版本；其余先挂起等苗圃结论。
   */
  applyRelease: (draft: ReleaseDraft, quarantine: Quarantine | undefined) => Promise<ReleaseRequest>;
  /** 删除一条放行申请（不影响已栽植记录的删除入口在栽植页） */
  discard: (releaseId: string) => Promise<void>;
  /** 重新拉取苗圃最新结论，重算所有未放行申请（检疫结论改动后班组侧入口） */
  refreshFromQuarantine: () => Promise<number>;
}

export const useReleaseStore = create<ReleaseStoreState>((set, get) => ({
  revision: 0,

  async init() {
    await initDatabase();
    set({ revision: get().revision + 1 });
  },

  async applyRelease(draft, quarantine) {
    await initDatabase();
    const asOf = draft.requestDate || today();
    const decision = evaluateRelease(quarantine, asOf);
    const stamp = nowIso();
    const eligible = decision.state === '已放行';
    const row: ReleaseRequest = {
      id: uuid('release'),
      plotId: draft.plotId,
      seedlingId: draft.seedlingId,
      quantity: draft.quantity,
      operator: draft.operator.trim(),
      requestDate: asOf,
      state: decision.state,
      holdReason: decision.holdReason,
      quarantineVersion: quarantine?.version ?? 1,
      releasedConclusion: eligible && quarantine ? releaseSnapshotText(quarantine) : '',
      releasedAt: eligible ? asOf : '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putReleaseRequest(row);
    set({ revision: get().revision + 1 });
    return row;
  },

  async discard(releaseId) {
    await removeReleaseRequest(releaseId);
    set({ revision: get().revision + 1 });
  },

  async refreshFromQuarantine() {
    await initDatabase();
    const changed = await recalcOpenReleaseRequests();
    set({ revision: get().revision + 1 });
    return changed;
  },
}));

/** 派生：当前已放行的批次 id 集合（栽植总株数 / 补植计划只认这些批次） */
export function selectReleasedSeedlingIds(releases: ReleaseRequest[]): Set<string> {
  return new Set(releases.filter((row) => row.state === '已放行').map((row) => row.seedlingId));
}

/** 供页面取某批次最新一条放行申请（表格展示用） */
export function selectReleaseBySeedling(releases: ReleaseRequest[], seedlingId: string): ReleaseRequest | undefined {
  return releases
    .filter((row) => row.seedlingId === seedlingId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
