/**
 * /plots/:id/seedlings 苗木批次与苗圃检疫台账（苗圃侧）
 * 两摊账分开：
 * - 「苗木批次与来源」是进场账：树种、来源、规格、数量、进场日期；
 * - 「苗圃检疫台账」每批一条：检疫结论、隔离期、版本留痕（苗圃自己留底）。
 * 保存检疫结论只写苗圃自己的表，失败只重试自己，与班组栽植记录互不影响。
 * 消费模型：Seedling、Quarantine、Plot；复用组件：<StatBadge>、<EmptyPanel>、<QuarantineTag>
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
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ArrowLeftOutlined, DeleteOutlined, EditOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import QuarantineTag from '../components/common/QuarantineTag';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useQuarantineStore } from '../stores/quarantineStore';
import { db, removeSeedling } from '../utils/db';
import {
  DEFAULT_ISOLATION_DAYS,
  QUARANTINE_CONCLUSION_OPTIONS,
  isReleasableConclusion,
  type Quarantine,
  type QuarantineConclusion,
  type QuarantineDraft,
} from '../types/quarantine';
import {
  SEEDLING_SOURCE_OPTIONS,
  SEEDLING_SPECIES_OPTIONS,
  type Seedling,
  type SeedlingSource,
  type SeedlingSpecies,
} from '../types/seedling';
import { ROUTES } from '../router';
import { muToM2, round1 } from '../utils/rate';

/** 到场日期合法格式（无效则该批旧苗检疫账升级时补不上、先搁着） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface SeedlingFormValues {
  species: SeedlingSpecies;
  source: SeedlingSource;
  spec: string;
  quantity: number;
  arrivalDate: Dayjs;
}

interface QuarantineFormValues {
  conclusion: QuarantineConclusion;
  conclusionDate: Dayjs | null;
  isolationDays: number;
  note: string;
}

/** 参考密度：每平方米不超过 2 株（约 0.5 ㎡/株），用于批次数量提示 */
const MAX_PLANTS_PER_M2 = 2;

export default function SeedlingBoard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plot = usePlotStore((state) => state.plots.find((item) => item.id === id));
  const plantings = usePlotStore((state) => state.plantings);
  const attachPending = useQuarantineStore((state) => state.attachPendingForSeedling);
  const backfillPending = useQuarantineStore((state) => state.backfillPending);
  const saveConclusion = useQuarantineStore((state) => state.saveConclusion);
  const qRevision = useQuarantineStore((state) => state.revision);
  const qLastMessage = useQuarantineStore((state) => state.lastMessage);
  const { rows, loading, create } = useIdbTable<Seedling>(db.seedlings, { sortByUpdatedAt: false });
  const { rows: qRows, loading: qLoading } = useIdbTable<Quarantine>(db.quarantines, { sortByUpdatedAt: false });

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<SeedlingFormValues>();

  // 检疫结论弹窗
  const [qOpen, setQOpen] = useState(false);
  const [qSeedling, setQSeedling] = useState<Seedling | null>(null);
  const [qSubmitting, setQSubmitting] = useState(false);
  const [qForm] = Form.useForm<QuarantineFormValues>();
  // 查看历史版本
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRow, setHistoryRow] = useState<Quarantine | null>(null);

  const plotSeedlings = useMemo(
    () => rows.filter((row) => row.plotId === id).sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate)),
    [rows, id],
  );

  const plotQuarantines = useMemo(
    () => qRows.filter((row) => row.plotId === id),
    [qRows, id],
  );

  void qRevision;

  const quarantineOf = (seedlingId: string): Quarantine | undefined =>
    plotQuarantines.find((row) => row.seedlingId === seedlingId);

  /** 升级时缺到场日期、检疫账补不上被搁置的批次 */
  const missingQuarantineSeedlings = useMemo(
    () => plotSeedlings.filter((seedling) => !plotQuarantines.some((q) => q.seedlingId === seedling.id)),
    [plotSeedlings, plotQuarantines],
  );

  const totalQuantity = plotSeedlings.reduce((acc, row) => acc + row.quantity, 0);
  const usedQuantity = plantings
    .filter((row) => row.plotId === id)
    .reduce((acc, row) => acc + row.count, 0);

  const density = plot ? round1(totalQuantity / Math.max(1, muToM2(plot.areaMu))) : 0;
  const overloaded = plot !== undefined && density > MAX_PLANTS_PER_M2;

  const openCreate = (): void => {
    form.setFieldsValue({
      species: '秋茄',
      source: '自育苗',
      spec: '50cm 裸根苗',
      quantity: 1000,
      arrivalDate: dayjs(),
    });
    setOpen(true);
  };

  const handleSubmit = async (): Promise<void> => {
    if (id === undefined) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const arrivalDate = values.arrivalDate.format('YYYY-MM-DD');
      const payload = {
        plotId: id,
        species: values.species,
        source: values.source,
        spec: values.spec.trim(),
        quantity: values.quantity,
        arrivalDate,
      };
      const created = await create(payload, 'seedling');
      // 新批次登记后，苗圃自动挂一本「待检」台账（各账留底，互不依赖）
      await attachPending({ id: created.id, plotId: id, arrivalDate });
      message.success(`已登记苗木批次：${payload.species} ${payload.quantity} 株，并自动挂「待检」台账`);
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (row: Seedling): Promise<void> => {
    const bound = plantings.filter((item) => item.seedlingId === row.id).length;
    // 走 db.removeSeedling：级联清理该批次的检疫台账、放行申请与栽植记录，各账不留悬空引用
    await removeSeedling(row.id);
    message.success(
      bound > 0 ? `已删除批次（同时清理了 ${bound} 条引用它的栽植记录）` : '已删除苗木批次',
    );
  };

  const openQuarantine = (seedling: Seedling): void => {
    const q = quarantineOf(seedling.id);
    setQSeedling(seedling);
    qForm.setFieldsValue({
      conclusion: q?.conclusion ?? '待检',
      conclusionDate: q?.conclusionDate ? dayjs(q.conclusionDate) : null,
      isolationDays: q?.isolationDays ?? DEFAULT_ISOLATION_DAYS,
      note: q?.note ?? '',
    });
    setQOpen(true);
  };

  const handleQuarantineSubmit = async (): Promise<void> => {
    if (qSeedling === null) return;
    try {
      const values = await qForm.validateFields();
      setQSubmitting(true);
      const draft: QuarantineDraft = {
        conclusion: values.conclusion,
        conclusionDate: values.conclusionDate ? values.conclusionDate.format('YYYY-MM-DD') : '',
        isolationDays: values.isolationDays,
        note: values.note ?? '',
      };
      const result = await saveConclusion(qSeedling.id, draft);
      message.success(
        result.changed
          ? `检疫结论已更新到第 ${result.row.version} 版，班组挂起申请重算 ${result.recalcCount} 条`
          : '检疫台账已保存（结论未变，版本不递增）',
        5,
      );
      setQOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error instanceof Error ? error.message : '检疫台账保存失败');
    } finally {
      setQSubmitting(false);
    }
  };

  const handleBackfill = async (seedling: Seedling): Promise<void> => {
    await backfillPending(seedling);
    message.success(`已为「${seedling.species} · ${seedling.spec}」补登待检台账`);
  };

  if (!ready) {
    return <Card loading title="苗木批次与苗圃检疫台账" />;
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

  const batchColumns: ColumnsType<Seedling> = [
    {
      title: '树种',
      dataIndex: 'species',
      key: 'species',
      width: 120,
      render: (value: string) => <Tag color="green">{value}</Tag>,
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 100,
      render: (value: string) => <Tag color={value === '自育苗' ? 'cyan' : 'gold'}>{value}</Tag>,
    },
    { title: '规格', dataIndex: 'spec', key: 'spec', width: 160 },
    {
      title: '数量（株）',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 110,
      align: 'right',
      sorter: (a, b) => a.quantity - b.quantity,
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '已栽植（株）',
      key: 'used',
      width: 110,
      align: 'right',
      render: (_value, record) =>
        plantings
          .filter((item) => item.seedlingId === record.id)
          .reduce((acc, item) => acc + item.count, 0)
          .toLocaleString('zh-CN'),
    },
    {
      title: '进场日期',
      dataIndex: 'arrivalDate',
      key: 'arrivalDate',
      width: 120,
      sorter: (a, b) => a.arrivalDate.localeCompare(b.arrivalDate),
      render: (value: string) => (DATE_RE.test(value) ? value : <Tag color="orange">日期缺失</Tag>),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<SafetyCertificateOutlined />} onClick={() => openQuarantine(record)}>
            检疫
          </Button>
          <Popconfirm
            title="确认删除该苗木批次？"
            description="引用该批次的栽植记录、放行申请与检疫台账会被一并清理。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void handleDelete(record)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const quarantineColumns: ColumnsType<Seedling> = [
    {
      title: '苗木批次',
      key: 'seedling',
      width: 210,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>
            {record.species} · {record.spec}
          </span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            进场 {record.arrivalDate} · {record.quantity.toLocaleString('zh-CN')} 株
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '检疫结论',
      key: 'conclusion',
      width: 130,
      render: (_value, record) => {
        const q = quarantineOf(record.id);
        return <QuarantineTag conclusion={q?.conclusion} version={q?.version} />;
      },
    },
    {
      title: '结论日期',
      key: 'conclusionDate',
      width: 120,
      render: (_value, record) => quarantineOf(record.id)?.conclusionDate || '—',
    },
    {
      title: '隔离期',
      key: 'isolation',
      width: 180,
      render: (_value, record) => {
        const q = quarantineOf(record.id);
        if (!q) return '—';
        return (
          <Space direction="vertical" size={0}>
            <span>{q.isolationDays} 天</span>
            {q.isolationUntil ? (
              <Typography.Text
                type={isReleasableConclusion(q.conclusion) ? 'secondary' : 'secondary'}
                style={{ fontSize: 12 }}
              >
                至 {q.isolationUntil}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                待出结论
              </Typography.Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '备注 / 留痕',
      key: 'note',
      render: (_value, record) => {
        const q = quarantineOf(record.id);
        if (!q) {
          return (
            <Button size="small" type="link" onClick={() => void handleBackfill(record)}>
              补登待检
            </Button>
          );
        }
        return (
          <Space direction="vertical" size={0}>
            <span>{q.note || <Typography.Text type="secondary">无</Typography.Text>}</span>
            <Button
              size="small"
              type="link"
              style={{ padding: 0, height: 'auto' }}
              onClick={() => {
                setHistoryRow(q);
                setHistoryOpen(true);
              }}
            >
              查看 {q.history.length} 版留痕
            </Button>
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_value, record) => (
        <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openQuarantine(record)}>
          出 / 改结论
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
          {plot.name}
        </Typography.Text>
        <Tag color="cyan">{plot.tideZone}潮位带</Tag>
        <Tag>{plot.substrate}</Tag>
        <Tag color="blue">{plot.restoreMode}</Tag>
        <Typography.Text type="secondary">
          面积 {plot.areaMu} 亩（{Math.round(muToM2(plot.areaMu)).toLocaleString('zh-CN')} ㎡）
        </Typography.Text>
      </Space>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="苗木批次" value={plotSeedlings.length} suffix="批" tone="primary" />
        <StatBadge label="进场苗木合计" value={totalQuantity.toLocaleString('zh-CN')} suffix="株" tone="info" />
        <StatBadge
          label="已栽植"
          value={usedQuantity.toLocaleString('zh-CN')}
          suffix="株"
          percent={totalQuantity > 0 ? (usedQuantity / totalQuantity) * 100 : 0}
          tone="success"
        />
        <StatBadge
          label="检疫台账覆盖"
          value={`${plotQuarantines.length} / ${plotSeedlings.length}`}
          suffix="批"
          percent={plotSeedlings.length > 0 ? (plotQuarantines.length / plotSeedlings.length) * 100 : 0}
          tone="warning"
          hint="苗圃检疫台账：每批一条检疫结论与隔离期记录"
        />
        <StatBadge
          label="批次密度"
          value={density}
          suffix="株/㎡"
          tone={overloaded ? 'danger' : 'default'}
          hint={`地块面积 ${plot.areaMu} 亩，建议每平方米不超过 ${MAX_PLANTS_PER_M2} 株`}
        />
      </div>

      {qLastMessage !== '' ? (
        <Alert type="info" showIcon style={{ marginBottom: 14 }} message={qLastMessage} closable />
      ) : null}

      {missingQuarantineSeedlings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${missingQuarantineSeedlings.length} 批旧苗没补上检疫台账（到场日期缺失或无效，升级时先搁着）`}
          description={
            <Space direction="vertical" size={4}>
              {missingQuarantineSeedlings.map((seedling) => (
                <Space key={seedling.id}>
                  <span>
                    {seedling.species} · {seedling.spec}
                  </span>
                  <Button size="small" onClick={() => void handleBackfill(seedling)}>
                    补登待检
                  </Button>
                </Space>
              ))}
            </Space>
          }
        />
      ) : null}

      {/* 第一摊：苗圃检疫台账（结论 / 隔离期 / 版本留痕） */}
      <Card
        title={
          <Space>
            <SafetyCertificateOutlined />
            苗圃检疫台账（苗圃留底）
          </Space>
        }
        style={{ marginBottom: 14 }}
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            结论 / 日期 / 隔离期改动会自动升版并留痕，未放行的班组申请跟着重算
          </Typography.Text>
        }
      >
        <Table<Seedling>
          rowKey="id"
          size="middle"
          loading={qLoading}
          columns={quarantineColumns}
          dataSource={plotSeedlings}
          pagination={false}
          locale={{ emptyText: '先在下方登记苗木批次' }}
        />
      </Card>

      {overloaded ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="苗木批次数量偏多"
          description={`当前地块累计进场 ${totalQuantity} 株，折算密度 ${density} 株/㎡，已超过 ${MAX_PLANTS_PER_M2} 株/㎡ 的参考上限。请核对规格与数量，或拆分到其他地块。`}
        />
      ) : null}

      {/* 第二摊的源头：批次进场账（树种 / 来源 / 数量 / 进场日期） */}
      <Card
        title="苗木批次与来源（进场账）"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            登记苗木批次
          </Button>
        }
      >
        {plotSeedlings.length === 0 && !loading ? (
          <EmptyPanel
            title="该地块还没有苗木批次"
            description="登记进场苗木的树种、来源、规格与数量，系统会自动挂一本「待检」台账，等苗圃出检疫结论。"
            actionText="登记第一批苗木"
            onAction={openCreate}
          />
        ) : (
          <Table<Seedling>
            rowKey="id"
            size="middle"
            loading={loading}
            columns={batchColumns}
            dataSource={plotSeedlings}
            pagination={false}
          />
        )}
      </Card>

      <Modal
        title="登记苗木批次"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="species" label="树种" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SEEDLING_SPECIES_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item name="source" label="来源" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={SEEDLING_SOURCE_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
          </Space>
          <Form.Item name="spec" label="规格" rules={[{ required: true, message: '请填写苗木规格' }]}>
            <Input placeholder="如：50cm 裸根苗 / 40cm 营养袋苗" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="quantity"
              label="数量（株）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写数量' }]}
            >
              <InputNumber min={1} max={200000} step={100} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="arrivalDate"
              label="进场日期"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请选择进场日期' }]}
            >
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            保存后自动挂一本「待检」检疫台账；班组要等苗圃出合格结论且隔离期满、放行后才能下滩。
          </Typography.Text>
        </Form>
      </Modal>

      {/* 苗圃出 / 改检疫结论 */}
      <Modal
        title={
          qSeedling
            ? `检疫台账 · ${qSeedling.species} · ${qSeedling.spec}（${qSeedling.quantity.toLocaleString('zh-CN')} 株）`
            : '检疫台账'
        }
        open={qOpen}
        onCancel={() => setQOpen(false)}
        onOk={() => void handleQuarantineSubmit()}
        confirmLoading={qSubmitting}
        okText="保存结论"
        cancelText="取消"
        width={560}
      >
        <Form form={qForm} layout="vertical" initialValues={{ isolationDays: DEFAULT_ISOLATION_DAYS }}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="conclusion" label="检疫结论" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Select options={QUARANTINE_CONCLUSION_OPTIONS.map((value) => ({ value, label: value }))} />
            </Form.Item>
            <Form.Item name="conclusionDate" label="结论日期" style={{ flex: 1 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="isolationDays"
              label="隔离期（天）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写隔离期天数' }]}
            >
              <InputNumber min={0} max={365} step={1} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注（复检说明等）">
            <Input.TextArea rows={2} placeholder="如：初检异常，隔离复检合格" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            改动结论 / 日期 / 隔离期会自动 +1 版本，旧版本保留在留痕里；保存只写苗圃自己的账，失败只重试自己。
          </Typography.Text>
        </Form>
      </Modal>

      {/* 检疫版本留痕 */}
      <Modal
        title="检疫结论版本留痕"
        open={historyOpen}
        onCancel={() => setHistoryOpen(false)}
        footer={null}
      >
        {historyRow ? (
          <Timeline
            items={[...historyRow.history]
              .sort((a, b) => a.version - b.version)
              .map((entry) => ({
                color: entry.version === historyRow.version ? 'green' : 'gray',
                children: (
                  <Space direction="vertical" size={0}>
                    <Typography.Text strong>
                      第 {entry.version} 版 · {entry.conclusion}
                      {entry.version === historyRow.version ? '（当前）' : ''}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      结论日期 {entry.conclusionDate || '—'} · 隔离 {entry.isolationDays} 天 · {entry.changedAt.slice(0, 10)}
                    </Typography.Text>
                    {entry.note ? <Typography.Text type="secondary">{entry.note}</Typography.Text> : null}
                  </Space>
                ),
              }))}
          />
        ) : null}
      </Modal>
    </div>
  );
}
