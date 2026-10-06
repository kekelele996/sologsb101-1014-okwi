/**
 * /plots/:id/releases 班组放行申请（班组上下文）
 * 班组领苗下滩前按批次报放行申请：没检疫或还在隔离期内的先挂起，等苗圃出结论；
 * 合格且隔离期满的直接放行。挂起批次不计栽植总株数、不出补植计划。
 * 检疫结论改动后可在此重算未放行申请；已放行的固化「依据第 N 版结论」不再变。
 * 消费模型：ReleaseRequest、Seedling、Quarantine、Plot；复用组件：<StatBadge>、<EmptyPanel>
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  PlusOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useReleaseStore } from '../stores/releaseStore';
import { db } from '../utils/db';
import {
  RELEASE_HOLD_REASON_LABEL,
  RELEASE_STATE_COLOR,
  type ReleaseDraft,
  type ReleaseRequest,
} from '../types/release';
import type { Quarantine } from '../types/quarantine';
import { QUARANTINE_CONCLUSION_COLOR } from '../types/quarantine';
import type { Seedling } from '../types/seedling';
import { ROUTES } from '../router';
import { isInIsolation, isolationEndDate } from '../utils/quarantine';

interface ReleaseFormValues {
  seedlingId: string;
  quantity: number;
  operator: string;
  requestDate: Dayjs;
}

export default function ReleaseGate() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plot = usePlotStore((state) => state.plots.find((item) => item.id === id));
  const applyRelease = useReleaseStore((state) => state.applyRelease);
  const discard = useReleaseStore((state) => state.discard);
  const refreshFromQuarantine = useReleaseStore((state) => state.refreshFromQuarantine);

  const seedlingTable = useIdbTable<Seedling>(db.seedlings, { sortByUpdatedAt: false });
  const quarantineTable = useIdbTable<Quarantine>(db.quarantines, { sortByUpdatedAt: false });
  const { rows, loading } = useIdbTable<ReleaseRequest>(db.releaseRequests, { sortByUpdatedAt: false });

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<ReleaseFormValues>();

  const plotSeedlings = useMemo(
    () => seedlingTable.rows.filter((row) => row.plotId === id).sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate)),
    [seedlingTable.rows, id],
  );

  const plotReleases = useMemo(
    () => rows.filter((row) => row.plotId === id).sort((a, b) => b.requestDate.localeCompare(a.requestDate)),
    [rows, id],
  );

  /** 每批次取最新一条申请（同一批次多次报申请时只显示最新状态） */
  const latestBySeedling = useMemo(() => {
    const map = new Map<string, ReleaseRequest>();
    plotReleases.forEach((row) => {
      const current = map.get(row.seedlingId);
      if (current === undefined || row.createdAt > current.createdAt) map.set(row.seedlingId, row);
    });
    return map;
  }, [plotReleases]);

  const quarantineBySeedling = useMemo(() => {
    const map = new Map<string, Quarantine>();
    quarantineTable.rows.filter((row) => row.plotId === id).forEach((row) => map.set(row.seedlingId, row));
    return map;
  }, [quarantineTable.rows, id]);

  const stats = useMemo(() => {
    const latest = [...latestBySeedling.values()];
    const held = latest.filter((row) => row.state === '挂起').length;
    const rejected = latest.filter((row) => row.state === '已驳回').length;
    const released = latest.filter((row) => row.state === '已放行').length;
    const heldQuantity = plotReleases
      .filter((row) => row.state === '挂起')
      .reduce((acc, row) => acc + row.quantity, 0);
    return { held, rejected, released, heldQuantity };
  }, [latestBySeedling, plotReleases]);

  const openCreate = (): void => {
    form.setFieldsValue({
      seedlingId: plotSeedlings[0]?.id ?? '',
      quantity: plotSeedlings[0]?.quantity ?? 1000,
      operator: '',
      requestDate: dayjs(),
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    if (id === undefined) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const draft: ReleaseDraft = {
        plotId: id,
        seedlingId: values.seedlingId,
        quantity: values.quantity,
        operator: values.operator,
        requestDate: values.requestDate.format('YYYY-MM-DD'),
      };
      const result = await applyRelease(draft, quarantineBySeedling.get(values.seedlingId));
      if (result.state === '已放行') {
        message.success(`已放行 ${result.quantity} 株（${result.releasedConclusion}）`);
      } else if (result.state === '已驳回') {
        message.error('该批次检疫不合格，已驳回，不能下滩栽植');
      } else {
        message.warning(`该批次先挂起：${RELEASE_HOLD_REASON_LABEL[result.holdReason === '' ? '无检疫结论' : result.holdReason]}`, 6);
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRefresh = async (): Promise<void> => {
    const changed = await refreshFromQuarantine();
    if (changed === 0) message.info('未放行申请均与当前检疫结论一致，无需重算');
    else message.success(`已按苗圃最新结论重算 ${changed} 条未放行申请`);
  };

  if (!ready) {
    return <Card loading title="班组放行申请" />;
  }

  if (plot === undefined) {
    return (
      <EmptyPanel
        title="地块不存在或已被删除"
        description={`未能找到 id 为「${id ?? ''}」的修复地块，无法报放行申请。`}
        actionText="返回地块台账"
        onAction={() => navigate(ROUTES.plots)}
        extra={
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plots)}>
            返回
          </Button>
        }
      />
    );
  }

  const columns: ColumnsType<ReleaseRequest> = [
    {
      title: '苗木批次',
      key: 'seedling',
      width: 220,
      render: (_value, record) => {
        const seedling = plotSeedlings.find((row) => row.id === record.seedlingId);
        return (
          <Space direction="vertical" size={0}>
            <span>{seedling ? `${seedling.species} · ${seedling.spec}` : '（批次已删除）'}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              申请 {record.requestDate} · {record.quantity.toLocaleString('zh-CN')} 株
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '检疫结论',
      key: 'quarantine',
      width: 150,
      render: (_value, record) => {
        const q = quarantineBySeedling.get(record.seedlingId);
        if (q === undefined) return <Tag>无档案</Tag>;
        return (
          <Space direction="vertical" size={0}>
            <Tag color={QUARANTINE_CONCLUSION_COLOR[q.conclusion]}>
              {q.conclusion} · 第 {q.version} 版
            </Tag>
            {q.conclusion === '合格' && isInIsolation(q.isolatedFrom, q.isolationDays, record.requestDate) ? (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                隔离至 {isolationEndDate(q.isolatedFrom, q.isolationDays)}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '放行状态',
      dataIndex: 'state',
      key: 'state',
      width: 110,
      render: (value: ReleaseRequest['state']) => <Tag color={RELEASE_STATE_COLOR[value]}>{value}</Tag>,
    },
    {
      title: '挂起原因 / 放行依据',
      key: 'reason',
      width: 260,
      render: (_value, record) =>
        record.state === '已放行' ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            依据：{record.releasedConclusion || `第 ${record.quarantineVersion} 版结论`}
            {record.releasedAt ? ` · ${record.releasedAt} 放行` : ''}
          </Typography.Text>
        ) : (
          <Typography.Text type={record.state === '已驳回' ? 'danger' : 'warning'} style={{ fontSize: 12 }}>
            {record.holdReason === '' ? '—' : RELEASE_HOLD_REASON_LABEL[record.holdReason]}
          </Typography.Text>
        ),
    },
    { title: '领苗班组', dataIndex: 'operator', key: 'operator', width: 120 },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_value, record) => (
        <Popconfirm
          title="确认撤销这条放行申请？"
          description="仅删除申请记录，不影响已登记的栽植记录。"
          okText="撤销"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          onConfirm={async () => {
            await discard(record.id);
            message.success('放行申请已撤销');
          }}
        >
          <Button size="small" type="link" danger icon={<DeleteOutlined />}>
            撤销
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const dataSource = [...latestBySeedling.values()];

  return (
    <div>
      <Space size={8} style={{ marginBottom: 12 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plots)}>
          返回地块台账
        </Button>
        <Typography.Text strong style={{ fontSize: 16 }}>
          {plot.name} · 班组放行申请
        </Typography.Text>
        <Tag color="blue">班组侧留底</Tag>
      </Space>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="已放行批次" value={stats.released} suffix="批" tone="success" />
        <StatBadge label="挂起批次" value={stats.held} suffix="批" tone={stats.held > 0 ? 'warning' : 'default'} />
        <StatBadge label="挂起苗木" value={stats.heldQuantity.toLocaleString('zh-CN')} suffix="株" tone="danger" hint="挂起批次不计入栽植总株数，也不出补植计划" />
        <StatBadge label="已驳回" value={stats.rejected} suffix="批" tone={stats.rejected > 0 ? 'danger' : 'default'} />
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="没检疫或还在隔离期内的批次先挂起，等苗圃出结论"
        description="检疫结论改动后，点「按苗圃结论重算」可刷新所有未放行申请；已放行、已栽下去的批次不动，仍按放行时写明的结论版本留底。"
      />

      <Card
        title="放行申请"
        extra={
          <Space wrap>
            <Button icon={<SyncOutlined />} onClick={() => void handleRefresh()}>
              按苗圃结论重算
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={plotSeedlings.length === 0}>
              按批次报放行
            </Button>
          </Space>
        }
      >
        {plotSeedlings.length === 0 && !loading ? (
          <EmptyPanel
            title="该地块还没有苗木批次"
            description="先到苗木批次页登记进场苗木，班组才能按批次报放行申请。"
            actionText="去登记苗木批次"
            onAction={() => navigate(ROUTES.seedlings(plot.id))}
          />
        ) : (
          <Table
            rowKey="id"
            size="middle"
            loading={loading}
            columns={columns}
            dataSource={dataSource}
            pagination={false}
          />
        )}
      </Card>

      <Modal
        title="按批次报放行申请"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="提交申请"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="seedlingId" label="苗木批次" rules={[{ required: true, message: '请选择苗木批次' }]}>
            <Select
              options={plotSeedlings.map((row) => {
                const q = quarantineBySeedling.get(row.id);
                const qText = q === undefined ? '无检疫档案' : `${q.conclusion} 第${q.version}版`;
                return { value: row.id, label: `${row.species} · ${row.spec} · ${row.quantity} 株（${qText}）` };
              })}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="quantity" label="领苗数量（株）" style={{ flex: 1 }} rules={[{ required: true }]}>
              <InputNumber min={1} max={200000} step={100} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="requestDate" label="申请日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="operator" label="领苗班组" rules={[{ required: true, message: '请填写领苗班组' }]}>
            <Input placeholder="如：东港一班" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            提交时按当日苗圃结论判定：合格且隔离期满直接放行并留底结论版本；待检或隔离期内先挂起，不计栽植总株数。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
