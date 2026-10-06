/**
 * 栽植记录（Planting）——班组侧留底
 * 一条栽植记录引用一个「已放行」的苗木批次，登记株距、株数与成活率依据。
 * 挂起批次不能下滩，因此不会产生栽植行，自然不计入栽植总株数、也不产生补植。
 */

export interface Planting {
  id: string;
  /** 所属地块 */
  plotId: string;
  /** 消耗的苗木批次 */
  seedlingId: string;
  /** 放行依据：班组放行申请 id（v3 新增；升级前的旧数据为空，表示「升级前栽植」） */
  releaseId: string | null;
  /** 放行时依据的检疫版本号（旧数据为 null） */
  basisVersion: number | null;
  /** 放行时依据的检疫结论快照（旧数据为 null） */
  basisConclusion: string | null;
  /** 栽植日期 YYYY-MM-DD */
  plantDate: string;
  /** 株距（米） */
  spacingM: number;
  /** 株数（株） */
  count: number;
  /** 作业班组 */
  operator: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

/** 新建 / 编辑栽植记录的表单草稿 */
export interface PlantingDraft {
  plotId: string;
  seedlingId: string;
  releaseId: string | null;
  basisVersion: number | null;
  basisConclusion: string | null;
  plantDate: string;
  spacingM: number;
  count: number;
  operator: string;
}
