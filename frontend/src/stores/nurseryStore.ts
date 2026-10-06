/**
 * 苗圃侧状态管理（Zustand）——只管每批苗木的检疫结论与隔离期，独立留底。
 * 与班组的栽植 / 放行两摊分开：保存检疫结论只写 quarantines 表，
 * 失败时只重试苗圃自己的保存动作，绝不回滚或改动班组栽植记录。
 */
import { create } from 'zustand';
import type { Quarantine, QuarantineDraft } from '../types/quarantine';
import {
  ensurePendingQuarantine,
  getQuarantineBySeedling,
  initDatabase,
  putQuarantine,
  recalcOpenReleaseRequests,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import type { Seedling } from '../types/seedling';

/** 苗圃侧保存失败时的最大重试次数（只重试自己，不动班组数据） */
const QUARANTINE_SAVE_MAX_RETRY = 3;

interface NurseryStoreState {
  /** 页面用版本号：检疫档案保存 / 重试后 +1，驱动派生重算 */
  revision: number;
  lastMessage: string;
  init: () => Promise<void>;
  /** 登记新苗木批次后补一条「待检」底档（失败不阻断批次本身登记） */
  onboardSeedling: (seedling: Seedling) => Promise<Quarantine | null>;
  /**
   * 保存检疫结论（新建 / 改结论）。结论改动会让版本号 +1，并触发班组
   * 「还没放行」的申请跟着重算；已放行/已栽植的不动。
   * 保存失败时仅重试本动作，班组栽植记录不受影响。
   */
  saveQuarantine: (
    seedling: Seedling,
    draft: QuarantineDraft,
  ) => Promise<{ ok: boolean; quarantine: Quarantine | null; attempts: number; message: string }>;
}

export const useNurseryStore = create<NurseryStoreState>((set, get) => ({
  revision: 0,
  lastMessage: '',

  async init() {
    await initDatabase();
    set({ revision: get().revision + 1 });
  },

  async onboardSeedling(seedling) {
    try {
      return await ensurePendingQuarantine(seedling);
    } catch {
      // 苗圃底档没建成不阻断苗木批次登记；可在检疫台账页再补结论
      return null;
    }
  },

  async saveQuarantine(seedling, draft) {
    await initDatabase();
    const existing = await getQuarantineBySeedling(seedling.id);
    // 结论发生改动才升版本；只改隔离天数/检疫员等不升版本
    const conclusionChanged = existing !== undefined && existing.conclusion !== draft.conclusion;
    const stamp = nowIso();
    const row: Quarantine = {
      id: existing?.id ?? uuid('quarantine'),
      seedlingId: seedling.id,
      plotId: seedling.plotId,
      conclusion: draft.conclusion,
      version: existing === undefined ? 1 : existing.version + (conclusionChanged ? 1 : 0),
      isolationDays: Math.max(0, Math.trunc(draft.isolationDays)),
      isolatedFrom: draft.isolatedFrom,
      inspectedDate: draft.inspectedDate,
      inspector: draft.inspector.trim(),
      source: existing?.source ?? '苗圃登记',
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      revision: 3,
    };

    // 只重试苗圃自己的保存；班组栽植记录始终不动
    let attempts = 0;
    let lastError: unknown = null;
    while (attempts < QUARANTINE_SAVE_MAX_RETRY) {
      attempts += 1;
      try {
        await putQuarantine(row);
        // 保存成功后通知班组重算「还没放行」的申请；重算失败不影响苗圃结论已落库
        try {
          await recalcOpenReleaseRequests();
        } catch {
          /* 班组侧重算可在其页面再次触发，不回滚苗圃结论 */
        }
        set({
          revision: get().revision + 1,
          lastMessage: conclusionChanged
            ? `检疫结论已更新为「${row.conclusion}」（第 ${row.version} 版），未放行申请已重算`
            : `检疫档案已保存（仍为第 ${row.version} 版结论）`,
        });
        return { ok: true, quarantine: row, attempts, message: '保存成功' };
      } catch (error) {
        lastError = error;
      }
    }
    const message =
      lastError instanceof Error && lastError.message !== ''
        ? `检疫档案保存失败（已重试 ${attempts} 次，仅苗圃侧重试，班组栽植记录未受影响）：${lastError.message}`
        : `检疫档案保存失败（已重试 ${attempts} 次，仅苗圃侧重试，班组栽植记录未受影响）`;
    set({ revision: get().revision + 1, lastMessage: message });
    return { ok: false, quarantine: null, attempts, message };
  },
}));
