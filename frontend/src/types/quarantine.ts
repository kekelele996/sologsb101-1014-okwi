/**
 * 苗圃检疫档案（Quarantine）——苗圃上下文
 * 与苗木批次（只记批次与进场数量）分开记账：检疫结论与隔离期由苗圃侧独立留底，
 * 班组放行申请只认这里的结论版本，不直接改写苗木批次台账。
 */

/** 检疫结论：待检 / 合格 / 不合格 */
export type QuarantineConclusion = '待检' | '合格' | '不合格';

/** 检疫结论数据来源：苗圃登记 / 旧数据升级按到场日期补录 */
export type QuarantineSource = '苗圃登记' | '升级补录';

export const QUARANTINE_CONCLUSION_OPTIONS: QuarantineConclusion[] = ['待检', '合格', '不合格'];

/** 结论 → 徽标配色 */
export const QUARANTINE_CONCLUSION_COLOR: Record<QuarantineConclusion, string> = {
  待检: 'gold',
  合格: 'green',
  不合格: 'red',
};

/** 第一版检疫结论（结论每改动一次版本 +1，班组据此留底依据） */
export const QUARANTINE_FIRST_VERSION = 1;

export interface Quarantine {
  id: string;
  /** 对应的苗木批次（一苗一批一档） */
  seedlingId: string;
  /** 冗余地块 id，便于按地块直接查档（批次挪地块时随批次同步） */
  plotId: string;
  /** 检疫结论 */
  conclusion: QuarantineConclusion;
  /** 结论版本号：从 1 开始，结论每改动一次 +1 */
  version: number;
  /** 隔离期（天）；合格批次隔离未满也不放行 */
  isolationDays: number;
  /** 隔离起算日期 YYYY-MM-DD（旧数据升级时取批次到场日期） */
  isolatedFrom: string;
  /** 检疫日期 YYYY-MM-DD，未出结论时为空串 */
  inspectedDate: string;
  /** 检疫机构 / 检疫员备注 */
  inspector: string;
  /** 结论数据来源 */
  source: QuarantineSource;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑检疫结论的表单草稿 */
export interface QuarantineDraft {
  conclusion: QuarantineConclusion;
  isolationDays: number;
  isolatedFrom: string;
  inspectedDate: string;
  inspector: string;
}
