/**
 * <ReleaseStateTag> 班组放行状态徽标
 * 被栽植记录页的放行申请卡与栽植记录列复用。
 */
import { Tag } from 'antd';
import type { ReleaseState } from '../../types/release';
import { releaseStateColor } from '../../utils/quarantine';

export interface ReleaseStateTagProps {
  state: ReleaseState;
}

export default function ReleaseStateTag({ state }: ReleaseStateTagProps) {
  return <Tag color={releaseStateColor(state)}>{state}</Tag>;
}
