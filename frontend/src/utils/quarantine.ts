/**
 * 检疫 / 放行判定工具（纯函数，无 IndexedDB 依赖，便于测试与复用）
 * - 隔离期计算：从结论签发日起满 N 天
 * - 放行结论判定：合格 / 复检合格才算过检疫关
 * - 放行状态派生：待检 → 不合格 → 隔离期 → 已放行
 * - 苗圃侧保存重试：只包苗圃自己的写操作，绝不触碰班组栽植记录
 */
import type { Quarantine } from '../types/quarantine';
import { isReleasableConclusion } from '../types/quarantine';
import type { ReleaseState } from '../types/release';

/** 日期加天数，返回 YYYY-MM-DD（本地日历，避免 toISOString 的 UTC 偏移） */
export function addDays(dateText: string, days: number): string {
  if (dateText === '' || !/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return '';
  const [y, m, d] = dateText.split('-').map((part) => Number(part));
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 由结论签发日期与隔离天数派生隔离期满日期 */
export function isolationEndDate(conclusionDate: string, isolationDays: number): string {
  if (conclusionDate === '') return '';
  return addDays(conclusionDate, Math.max(0, Math.floor(isolationDays)));
}

/** 隔离期是否已满（today 可注入，便于测试） */
export function isIsolationOver(endDate: string, today: string): boolean {
  if (endDate === '') return false;
  return today >= endDate;
}

export interface ReleaseDecision {
  state: ReleaseState;
  /** 给班组看的挂起 / 放行说明 */
  reason: string;
  /** 是否可放行（结论合格且隔离期已满） */
  releasableNow: boolean;
}

/**
 * 按当前检疫台账与判定日派生放行状态。
 * 调用方需保证只对「未放行」的申请调用；已放行是终态，不参与重算。
 *
 * @param today 判定日 YYYY-MM-DD，默认当天（参数化便于测试）
 */
export function evaluateRelease(
  quarantine: Quarantine | undefined,
  today: string,
): ReleaseDecision {
  if (quarantine === undefined) {
    return { state: '挂起-待检', reason: '苗圃尚未建立该批次的检疫台账，先挂起等待检疫结论', releasableNow: false };
  }
  if (!isReleasableConclusion(quarantine.conclusion)) {
    if (quarantine.conclusion === '不合格') {
      return {
        state: '挂起-不合格',
        reason: `检疫结论为「不合格」（第 ${quarantine.version} 版，${quarantine.conclusionDate || '未注明日期'}），暂缓放行`,
        releasableNow: false,
      };
    }
    return { state: '挂起-待检', reason: '检疫结论仍为「待检」，先挂起等苗圃出结论', releasableNow: false };
  }

  const endDate = quarantine.isolationUntil || isolationEndDate(quarantine.conclusionDate, quarantine.isolationDays);
  if (!isIsolationOver(endDate, today)) {
    return {
      state: '挂起-隔离期',
      reason: `检疫合格（第 ${quarantine.version} 版），隔离期至 ${endDate}，期满后自动可放行`,
      releasableNow: false,
    };
  }
  return {
    state: '已放行',
    reason: `检疫合格（第 ${quarantine.version} 版），隔离期已于 ${endDate} 满，准予放行`,
    releasableNow: true,
  };
}

/** 挂起状态对应的徽标颜色 */
export function releaseStateColor(state: ReleaseState): string {
  switch (state) {
    case '已放行':
      return 'green';
    case '挂起-待检':
      return 'default';
    case '挂起-不合格':
      return 'red';
    case '挂起-隔离期':
      return 'orange';
  }
}

/**
 * 通用「带重试」执行：仅用于苗圃侧保存。
 * 设计约束：operation 里只允许写苗圃自己的表（quarantines），
 * 不把班组栽植记录放进同一个事务，保证苗圃失败重试时班组数据原封不动。
 */
export async function runWithRetry<T>(
  operation: () => Promise<T>,
  options: { retries?: number; retryDelayMs?: number } = {},
): Promise<T> {
  const { retries = 2, retryDelayMs = 200 } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      // 指数退避：200ms → 400ms
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('苗圃检疫台账保存失败');
}
