/**
 * 苗圃检疫台账状态管理（Zustand，苗圃侧）
 * 收口「出 / 改检疫结论」与「补登待检台账」两个写动作。
 *
 * 边界：这里的保存只落苗圃自己的 quarantines 表，失败只重试自己
 * （见 utils/quarantine.runWithRetry 与 db.saveQuarantineConclusion），
 * 班组栽植记录在另一本账上，不受苗圃保存重试影响。
 */
import { create } from 'zustand';
import type { Seedling } from '../types/seedling';
import type { Quarantine, QuarantineDraft } from '../types/quarantine';
import {
  db,
  ensurePendingQuarantine,
  getQuarantineBySeedling,
  saveQuarantineConclusion,
  type SaveQuarantineResult,
} from '../utils/db';

export interface QuarantineStoreState {
  /** 每次写操作后的版本号，页面可据此刷新提示 */
  revision: number;
  /** 最近一次保存结果提示（含连带重算条数 / 重算失败说明） */
  lastMessage: string;
  init: () => Promise<void>;
  /** 新批次登记后自动挂一本待检账（幂等，失败只重试自己） */
  attachPendingForSeedling: (seedling: Pick<Seedling, 'id' | 'plotId' | 'arrivalDate'>) => Promise<Quarantine>;
  /** 升级时缺到场日期被搁置的批次，由苗圃人工补登待检 */
  backfillPending: (seedling: Pick<Seedling, 'id' | 'plotId' | 'arrivalDate'>) => Promise<Quarantine>;
  /** 出 / 改检疫结论；返回是否改版本与连带重算结果 */
  saveConclusion: (seedlingId: string, draft: QuarantineDraft) => Promise<SaveQuarantineResult>;
  getBySeedling: (seedlingId: string) => Promise<Quarantine | undefined>;
  clearMessage: () => void;
}

export const useQuarantineStore = create<QuarantineStoreState>((set) => ({
  revision: 0,
  lastMessage: '',

  async init() {
    set({ revision: useQuarantineStore.getState().revision + 1 });
  },

  async attachPendingForSeedling(seedling) {
    const row = await ensurePendingQuarantine(seedling, 'arrival');
    set({ revision: useQuarantineStore.getState().revision + 1 });
    return row;
  },

  async backfillPending(seedling) {
    const existing = await getQuarantineBySeedling(seedling.id);
    if (existing) return existing;
    const row = await ensurePendingQuarantine(seedling, 'manual');
    set({ revision: useQuarantineStore.getState().revision + 1, lastMessage: '已为该批次补登「待检」台账，等苗圃出检疫结论' });
    return row;
  },

  async saveConclusion(seedlingId, draft) {
    // 被搁置（旧数据缺到场日期）又没点过「补登待检」的批次，保存时自动兜底补一本再出结论
    const existing = await getQuarantineBySeedling(seedlingId);
    if (!existing) {
      const seedling = await db.seedlings.get(seedlingId);
      if (seedling) {
        await ensurePendingQuarantine(
          { id: seedling.id, plotId: seedling.plotId, arrivalDate: seedling.arrivalDate },
          'manual',
        );
      }
    }
    const result = await saveQuarantineConclusion(seedlingId, draft);
    const message = result.changed
      ? `检疫结论已更新到第 ${result.row.version} 版，旧版本已留痕；班组挂起申请重算 ${result.recalcCount} 条`
      : '检疫台账已保存（结论未变，版本不递增）';
    set({
      revision: useQuarantineStore.getState().revision + 1,
      lastMessage: result.recalcError !== '' ? `${message}；${result.recalcError}` : message,
    });
    return result;
  },

  async getBySeedling(seedlingId) {
    return getQuarantineBySeedling(seedlingId);
  },

  clearMessage() {
    set({ lastMessage: '' });
  },
}));

/** 便捷引用：部分页面需要直接确认表是否可用 */
export { db as quarantineDb };
