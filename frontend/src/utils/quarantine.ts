/**
 * 检疫与放行判定的纯函数口径（苗圃 / 班组两摊共用同一套规则，但各自留底）。
 * 这里不触碰 IndexedDB，只做日期与结论判定，方便被 store、页面与升级迁移复用。
 */
import type { Quarantine } from '../types/quarantine';
import type { ReleaseDecision, ReleaseHoldReason, ReleaseState } from '../types/release';

/** 日期加天数，返回 YYYY-MM-DD（按本地日历，不做时区换算） */
export function addDays(dateStr: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '';
  const [y, m, d] = dateStr.split('-').map((part) => Number(part));
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + Math.max(0, Math.trunc(days)));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 隔离截止日期 = 隔离起算日 + 隔离天数（当天即隔离期满） */
export function isolationEndDate(isolatedFrom: string, isolationDays: number): string {
  return addDays(isolatedFrom, Math.max(0, Math.trunc(isolationDays)));
}

/** 截止 asOf 当日是否仍在隔离期内（隔离期满当日即可放行） */
export function isInIsolation(isolatedFrom: string, isolationDays: number, asOf: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isolatedFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return true;
  return asOf < isolationEndDate(isolatedFrom, isolationDays);
}

/**
 * 按某份检疫档案与判定日期，算班组放行结果。
 * - 无档案 / 待检：挂起，等苗圃出结论
 * - 合格但隔离未满：挂起
 * - 合格且隔离期满：可放行
 * - 不合格：驳回（结论再改且未放行时可被重算翻回来）
 */
export function evaluateRelease(
  quarantine: Quarantine | undefined,
  asOf: string,
): ReleaseDecision & { eligible: boolean } {
  if (quarantine === undefined || quarantine.conclusion === '待检') {
    return decision('挂起', '无检疫结论', quarantine, true, false);
  }
  if (quarantine.conclusion === '不合格') {
    return decision('已驳回', '检疫不合格', quarantine, false, false);
  }
  const inIsolation = isInIsolation(quarantine.isolatedFrom, quarantine.isolationDays, asOf);
  if (inIsolation) {
    return decision('挂起', '隔离期内', quarantine, true, false);
  }
  return decision('已放行', '', quarantine, false, true);
}

function decision(
  state: ReleaseState,
  holdReason: ReleaseHoldReason | '',
  quarantine: Quarantine | undefined,
  inIsolation: boolean,
  eligible: boolean,
): ReleaseDecision & { eligible: boolean } {
  const from = quarantine?.isolatedFrom ?? '';
  const days = quarantine?.isolationDays ?? 0;
  return {
    state,
    holdReason,
    isolationUntil: from === '' ? '' : isolationEndDate(from, days),
    inIsolation: quarantine?.conclusion === '合格' ? inIsolation : false,
    eligible,
  };
}

/** 放行留底快照文案：写明依据哪一版结论 */
export function releaseSnapshotText(quarantine: Quarantine): string {
  return `第 ${quarantine.version} 版检疫结论：${quarantine.conclusion}（${
    quarantine.inspectedDate || '未填检疫日期'
  }），隔离 ${quarantine.isolationDays} 天`;
}
