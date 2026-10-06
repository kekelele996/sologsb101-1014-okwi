/**
 * /plots/:id/quarantines 苗圃检疫台账（苗圃上下文）
 * 只管每批苗木的检疫结论与隔离期，独立留底；与班组栽植记录分开。
 * 旧数据升级补录的批次默认「待检」，到场日期补不上的不建档、先搁着。
 * 消费模型：Quarantine、Seedling、Plot；复用组件：<StatBadge>、<EmptyPanel>
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
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowLeftOutlined, EditOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useNurseryStore } from '../stores/nurseryStore';
import { db } from '../utils/db';
import {
  QUARANTINE_CONCLUSION_COLOR,
  QUARANTINE_CONCLUSION_OPTIONS,
  type Quarantine,
  type QuarantineConclusion,
  type QuarantineDraft,
} from '../types/quarantine';
import type { Seedling } from '../types/seedling';
import { ROUTES } from '../router';
import { isInIsolation, isolationEndDate } from '../utils/quarantine';
import { today } from '../utils/id';

interface QuarantineFormValues {
  conclusion: QuarantineConclusion;
  isolationDays: number;
  isolatedFrom: Dayjs;
  inspectedDate: Dayjs | null;
  inspector: string;
}

export default function QuarantineBoard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plot = usePlotStore((state) => state.plots.find((item) => item.id === id));
  const saveQuarantine = useNurseryStore((state) => state.saveQuarantine);
  const lastMessage = useNurseryStore((state) => state.lastMessage);
  const nurseryRevision = useNurseryStore((state) => state.revision);

  const seedlingTable = useIdbTable<Seedling>(db.seedlings, { sortByUpdatedAt: false });
  const { rows, loading } = useIdbTable<Quarantine>(db.quarantines, { sortByUpdatedAt: false });

  const [open, setOpen] = useState(false);
  const [editingSeedling, setEditingSeedling] = useState<Seedling | null>(null);
  const [editingQuarantine, setEditingQuarantine] = useState<Quarantine | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<QuarantineFormValues>();

  const plotSeedlings = useMemo(
    () => seedlingTable.rows.filter((row) => row.plotId === id).sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate)),
    [seedlingTable.rows, id],
  );

  const quarantineBySeedling = useMemo(() => {
    const map = new Map<string, Quarantine>();
    rows.filter((row) => row.plotId === id).forEach((row) => map.set(row.seedlingId, row));
    return map;
  }, [rows, id, nurseryRevision]);

  /** 没建上检疫档案的批次：旧数据到场日期补不上，或登记时留底失败，先搁着提示 */
  const missingArchive = useMemo(
    () => plotSeedlings.filter((seedling) => !quarantineBySeedling.has(seedling.id)),
    [plotSeedlings, quarantineBySeedling],
  );

  const stats = useMemo(() => {
    const pending = plotSeedlings.filter((s) => quarantineBySeedling.get(s.id)?.conclusion === '待检').length;
    const passed = plotSeedlings.filter((s) => quarantineBySeedling.get(s.id)?.conclusion === '合格').length;
    const rejected = plotSeedlings.filter((s) => quarantineBySeedling.get(s.id)?.conclusion === '不合格').length;
    const isolating = plotSeedlings.filter((s) => {
      const q = quarantineBySeedling.get(s.id);
      return q !== undefined && q.conclusion === '合格' && isInIsolation(q.isolatedFrom, q.isolationDays, today());
    }).length;
    return { pending, passed, rejected, isolating };
  }, [plotSeedlings, quarantineBySeedling, nurseryRevision]);

  const openEdit = (seedling: Seedling): void => {
    const quarantine = quarantineBySeedling.get(seedling.id) ?? null;
    setEditingSeedling(seedling);
    setEditingQuarantine(quarantine);
    form.setFieldsValue({
      conclusion: quarantine?.conclusion ?? '待检',
      isolationDays: quarantine?.isolationDays ?? 7,
      isolatedFrom: dayjs(quarantine?.isolatedFrom ?? seedling.arrivalDate),
      inspectedDate: quarantine?.inspectedDate ? dayjs(quarantine.inspectedDate) : null,
      inspector: quarantine?.inspector ?? '',
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    if (editingSeedling === null) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const draft: QuarantineDraft = {
        conclusion: values.conclusion,
        isolationDays: values.isolationDays,
        isolatedFrom: values.isolatedFrom.format('YYYY-MM-DD'),
        inspectedDate: values.inspectedDate ? values.inspectedDate.format('YYYY-MM-DD') : '',
        inspector: values.inspector,
      };
      const result = await saveQuarantine(editingSeedling, draft);
      if (result.ok) {
        message.success(`检疫档案已保存（第 ${result.quarantine?.version ?? 1} 版结论）`);
        setOpen(false);
      } else {
        message.error(result.message, 8);
      }
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!ready) {
    return <Card loading title="苗圃检疫台账" />;
  }

  if (plot === undefined) {
    return (
      <EmptyPanel
        title="地块不存在或已被删除"
        description={`未能找到 id 为「${id ?? ''}」的修复地块。可能是链接已过期，或该地块已被删除。`}
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

  const modalTitle =
    editingSeedling === null
      ? '检疫档案'
      : `${editingQuarantine ? '更新检疫结论' : '补建检疫档案'} · ${editingSeedling.species} ${editingSeedling.spec}`;

  const columns: ColumnsType<Seedling> = [
    {
      title: '树种 / 规格',
      key: 'seedling',
      width: 220,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Tag color="green">{record.species}</Tag>
            <span>{record.spec}</span>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            进场 {record.arrivalDate} · {record.quantity.toLocaleString('zh-CN')} 株 · {record.source}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '检疫结论',
      key: 'conclusion',
      width: 120,
      render: (_value, record) => {
        const q = quarantineBySeedling.get(record.id);
        if (q === undefined) return <Tag>未建档</Tag>;
        return <Tag color={QUARANTINE_CONCLUSION_COLOR[q.conclusion]}>{q.conclusion}</Tag>;
      },
    },
    {
      title: '结论版本',
      key: 'version',
      width: 100,
      align: 'center',
      render: (_value, record) => {
        const q = quarantineBySeedling.get(record.id);
        return q ? `第 ${q.version} 版` : '—';
      },
    },
    {
      title: '隔离期',
      key: 'isolation',
      width: 200,
      render: (_value, record) => {
        const q = quarantineBySeedling.get(record.id);
        if (q === undefined) return <Typography.Text type="secondary">—</Typography.Text>;
        const until = isolationEndDate(q.isolatedFrom, q.isolationDays);
        const isolating = q.conclusion === '合格' && isInIsolation(q.isolatedFrom, q.isolationDays, today());
        return (
          <Space direction="vertical" size={0}>
            <span>
              {q.isolationDays} 天（{q.isolatedFrom} 起）
            </span>
            <Typography.Text type={isolating ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
              {q.conclusion === '合格' ? (isolating ? `隔离中，至 ${until} 期满` : `已于 ${until} 隔离期满`) : `隔离至 ${until}`}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '检疫日期 / 检疫员',
      key: 'inspector',
      width: 200,
      render: (_value, record) => {
        const q = quarantineBySeedling.get(record.id);
        if (q === undefined) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Space direction="vertical" size={0}>
            <span>{q.inspectedDate || '未检疫'}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {q.inspector || '—'}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '来源',
      key: 'source',
      width: 110,
      render: (_value, record) => {
        const q = quarantineBySeedling.get(record.id);
        if (q === undefined) return <Tag>待补建档</Tag>;
        return <Tag color={q.source === '升级补录' ? 'gold' : 'cyan'}>{q.source}</Tag>;
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_value, record) => (
        <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
          {quarantineBySeedling.has(record.id) ? '改结论' : '补建档'}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Space size={8} style={{ marginBottom: 12 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plots)}>
          返回地块台账
        </Button>
        <Typography.Text strong style={{ fontSize: 16 }}>
          {plot.name} · 苗圃检疫台账
        </Typography.Text>
        <Tag color="cyan">{plot.tideZone}潮位带</Tag>
        <Tag icon={<SafetyCertificateOutlined />} color="gold">
          苗圃侧独立留底
        </Tag>
      </Space>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="苗木批次" value={plotSeedlings.length} suffix="批" tone="primary" />
        <StatBadge label="待检" value={stats.pending} suffix="批" tone={stats.pending > 0 ? 'warning' : 'default'} />
        <StatBadge label="合格" value={stats.passed} suffix="批" tone="success" />
        <StatBadge label="不合格" value={stats.rejected} suffix="批" tone={stats.rejected > 0 ? 'danger' : 'default'} />
        <StatBadge label="隔离中" value={stats.isolating} suffix="批" tone="info" hint="结论合格但隔离期尚未满，班组仍会被挂起" />
      </div>

      {missingArchive.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${missingArchive.length} 批苗还没有检疫档案，先搁着`}
          description={
            <Space direction="vertical" size={2}>
              <span>
                {missingArchive.map((row) => `${row.species}（${row.arrivalDate}）`).join('、')}
                ，到场日期缺失或登记时留底失败。补建好检疫档案前，班组放行申请会一直挂起。
              </span>
              <span>{lastMessage}</span>
            </Space>
          }
        />
      ) : null}

      <Card title="批次检疫结论与隔离期">
        {plotSeedlings.length === 0 && !loading ? (
          <EmptyPanel
            title="该地块还没有苗木批次"
            description="先到苗木批次页登记进场苗木，苗圃再在这里逐批出具检疫结论与隔离期。"
            actionText="去登记苗木批次"
            onAction={() => navigate(ROUTES.seedlings(plot.id))}
          />
        ) : (
          <Table
            rowKey="id"
            size="middle"
            loading={loading}
            columns={columns}
            dataSource={plotSeedlings}
            pagination={false}
          />
        )}
      </Card>

      <Modal
        title={modalTitle}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存结论"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="conclusion" label="检疫结论" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={QUARANTINE_CONCLUSION_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item
              name="isolationDays"
              label="隔离期（天）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写隔离天数' }]}
            >
              <InputNumber min={0} max={365} step={1} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="isolatedFrom" label="隔离起算日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="inspectedDate" label="检疫日期" style={{ flex: 1 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="inspector" label="检疫机构 / 检疫员">
            <Input placeholder="如：市林检站 · 陈检疫" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {editingQuarantine
              ? `当前为第 ${editingQuarantine.version} 版结论；改动结论会升一版，班组还没放行的申请会跟着重算，已放行/已栽植的照旧留底。`
              : '保存后建立第 1 版检疫结论；没出结论前班组领苗会被挂起。'}
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  );
}
