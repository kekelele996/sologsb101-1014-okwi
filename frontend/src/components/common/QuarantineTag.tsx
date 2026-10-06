/**
 * <QuarantineTag> 检疫结论徽标（苗圃侧）
 * 被苗木批次页、放行申请卡复用。
 */
import { Tag } from 'antd';
import type { QuarantineConclusion } from '../../types/quarantine';

const COLOR: Record<QuarantineConclusion, string> = {
  待检: 'default',
  合格: 'green',
  复检合格: 'cyan',
  不合格: 'red',
};

export interface QuarantineTagProps {
  conclusion: QuarantineConclusion | undefined;
  /** 是否同时展示版本号，如「合格 v2」 */
  version?: number;
}

export default function QuarantineTag({ conclusion, version }: QuarantineTagProps) {
  if (conclusion === undefined) {
    return <Tag>未建检疫账</Tag>;
  }
  return (
    <Tag color={COLOR[conclusion]}>
      {conclusion}
      {version !== undefined && version > 0 ? ` v${version}` : ''}
    </Tag>
  );
}
