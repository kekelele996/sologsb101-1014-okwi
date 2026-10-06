/**
 * 班组放行申请状态管理（Zustand，班组侧）
 * 收口「按批次报放行申请」「重算挂起申请」「撤回申请」三个动作。
 *
 * 规则：
 * - 没检疫 / 还在隔离期内的申请自动挂起，挂起批不计栽植总株数、不出补植；
 * - 检疫结论改动后由苗圃保存链路触发 refreshHeldReleases，只动未放行的申请；
 * - 已放行是终态，不重算；栽植记录写明依据版本。
 */
import { create } from 'zustand';
import type { ReleaseRequest, ReleaseDraft } from '../types/release';
import {
  applyRelease,
  getQuarantineBySeedling,
  refreshHeldReleases,
  removeRelease,
} from '../utils/db';

export interface ReleaseStoreState {
  revision: number;
  lastMessage: string;
  init: () => Promise<void>;
  /** 班组按批次报放行申请；自动给出放行 / 挂起结论 */
  apply: (draft: ReleaseDraft) => Promise<ReleaseRequest>;
  /** 重算挂起申请（结论改动已由苗圃侧触发；这里用于隔离期跨天的手动刷新） */
  refreshHeld: () => Promise<number>;
  withdraw: (releaseId: string) => Promise<void>;
  clearMessage: () => void;
}

export const useReleaseStore = create<ReleaseStoreState>((set) => ({
  revision: 0,
  lastMessage: '',

  async init() {
    set({ revision: useReleaseStore.getState().revision + 1 });
  },

  async apply(draft) {
    const quarantine = await getQuarantineBySeedling(draft.seedlingId);
    const row = await applyRelease(draft, quarantine);
    set({
      revision: useReleaseStore.getState().revision + 1,
      lastMessage:
        row.state === '已放行'
          ? `批次已放行（依据检疫第 ${row.basisVersion ?? '-'} 版），可以下滩栽植`
          : `申请已挂起：${row.reason}；挂起批不计栽植总株数，也不出补植计划`,
    });
    return row;
  },

  async refreshHeld() {
    const count = await refreshHeldReleases();
    set({
      revision: useReleaseStore.getState().revision + 1,
      lastMessage: count > 0 ? `已重算挂起申请，${count} 条状态更新` : '挂起申请重算完成，状态暂无变化',
    });
    return count;
  },

  async withdraw(releaseId) {
    await removeRelease(releaseId);
    set({ revision: useReleaseStore.getState().revision + 1, lastMessage: '已撤回放行申请（栽植记录属班组另一本账，未受影响）' });
  },

  clearMessage() {
    set({ lastMessage: '' });
  },
}));
