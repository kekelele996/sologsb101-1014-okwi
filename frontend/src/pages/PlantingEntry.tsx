/**
 * /plots/:id/plantings 班组放行申请与栽植记录（班组侧）
 * 两摊动作分开：
 * - 班组领苗先按批次「报放行申请」：没检疫 / 还在隔离期内的挂起等苗圃结论；
 * - 只有已放行的批次能录栽植，栽植记录写明依据检疫哪一版。
 * 挂起批不计进栽植总株数（没有栽植行），也不出补植计划。
 * 消费模型：ReleaseRequest、Planting、Seedling、Quarantine；复用组件：<FilterBar>、<StatBadge>、<EmptyPanel>、<ReleaseStateTag>
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
  EditOutlined,
  PlusOutlined,
  SendOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useNavigate, useParams } from 'react-router-dom';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import ReleaseStateTag from '../components/common/ReleaseStateTag';
import QuarantineTag from '../components/common/QuarantineTag';
import { useIdbTable } from '../hooks/useIdbTable';
import { usePlotStore } from '../stores/plotStore';
import { useReleaseStore } from '../stores/releaseStore';
import { db } from '../utils/db';
import type { Planting } from '../types/planting';
import type { Seedling } from '../types/seedling';
import type { Quarantine } from '../types/quarantine';
import type { ReleaseRequest } from '../types/release';
import { ROUTES } from '../router';
import {
  DENSITY_MAX_M2_PER_PLANT,
  DENSITY_MIN_M2_PER_PLANT,
  checkDensity,
  muToM2,
  type DensityCheck,
} from '../utils/rate';

interface PlantingFormValues {
  seedlingId: string;
  plantDate: Dayjs;
  spacingM: number;
  count: number;
  operator: string;
}

interface ReleaseFormValues {
  seedlingId: string;
  requestCount: number;
  applyDate: Dayjs;
  operator: string;
}

const DEFAULT_VALUES: PlantingFormValues = {
  seedlingId: '',
  plantDate: dayjs(),
  spacingM: 1,
  count: 1000,
  operator: '',
};

export default function PlantingEntry() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const ready = usePlotStore((state) => state.ready);
  const plot = usePlotStore((state) => state.plots.find((item) => item.id === id));

  const seedlingTable = useIdbTable<Seedling>(db.seedlings, { sortByUpdatedAt: false });
  const quarantineTable = useIdbTable<Quarantine>(db.quarantines, { sortByUpdatedAt: false });
  const releaseTable = useIdbTable<ReleaseRequest>(db.releases, { sortByUpdatedAt: false });
  const { rows, loading, create, update, remove } = useIdbTable<Planting>(db.plantings, { sortByUpdatedAt: false });

  const applyReleaseRequest = useReleaseStore((state) => state.apply);
  const refreshHeld = useReleaseStore((state) => state.refreshHeld);
  const withdraw = useReleaseStore((state) => state.withdraw);
  const releaseLastMessage = useReleaseStore((state) => state.lastMessage);

  const [keyword, setKeyword] = useState('');
  const [operatorFilter, setOperatorFilter] = useState('all');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Planting | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [density, setDensity] = useState<DensityCheck | null>(null);
  const [form] = Form.useForm<PlantingFormValues>();

  // 放行申请弹窗
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseSubmitting, setReleaseSubmitting] = useState(false);
  const [releaseForm] = Form.useForm<ReleaseFormValues>();
  const [refreshing, setRefreshing] = useState(false);

  const plotSeedlings = useMemo(
    () => seedlingTable.rows.filter((row) => row.plotId === id),
    [seedlingTable.rows, id],
  );

  const plotReleases = useMemo(
    () => releaseTable.rows.filter((row) => row.plotId === id).sort((a, b) => b.applyDate.localeCompare(a.applyDate)),
    [releaseTable.rows, id],
  );

  const plotPlantings = useMemo(
    () => rows.filter((row) => row.plotId === id).sort((a, b) => b.plantDate.localeCompare(a.plantDate)),
    [rows, id],
  );

  const seedlingById = useMemo(() => new Map(plotSeedlings.map((row) => [row.id, row])), [plotSeedlings]);
  const quarantineBySeedling = useMemo(
    () => new Map(quarantineTable.rows.filter((row) => row.plotId === id).map((row) => [row.seedlingId, row])),
    [quarantineTable.rows, id],
  );
  const releaseBySeedling = useMemo(
    () => new Map(plotReleases.map((row) => [row.seedlingId, row])),
    [plotReleases],
  );

  /** 已放行批次（可录栽植） */
  const releasedReleases = useMemo(() => plotReleases.filter((row) => row.state === '已放行'), [plotReleases]);
  const releasedSeedlingIds = useMemo(() => new Set(releasedReleases.map((row) => row.seedlingId)), [releasedReleases]);
  /** 挂起批次（没检疫 / 不合格 / 隔离期未满）——不进栽植总株数、不出补植 */
  const heldReleases = useMemo(() => plotReleases.filter((row) => row.state !== '已放行'), [plotReleases]);
  const heldQuantity = heldReleases.reduce((acc, row) => acc + (seedlingById.get(row.seedlingId)?.quantity ?? 0), 0);

  /** 还没报放行申请的批次 */
  const unreleasedBatchOptions = useMemo(
    () => plotSeedlings.filter((seedling) => !releaseBySeedling.has(seedling.id)),
    [plotSeedlings, releaseBySeedling],
  );

  const operatorOptions = useMemo(
    () => Array.from(new Set(plotPlantings.map((row) => row.operator).filter((item) => item !== ''))),
    [plotPlantings],
  );

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    return plotPlantings.filter((row) => {
      if (operatorFilter !== 'all' && row.operator !== operatorFilter) return false;
      if (key === '') return true;
      const species = seedlingById.get(row.seedlingId)?.species ?? '';
      return (
        row.operator.toLowerCase().includes(key) ||
        species.toLowerCase().includes(key) ||
        row.plantDate.includes(key)
      );
    });
  }, [plotPlantings, seedlingById, keyword, operatorFilter]);

  const totalCount = plotPlantings.reduce((acc, row) => acc + row.count, 0);
  const avgSpacing =
    plotPlantings.length === 0
      ? 0
      : Math.round((plotPlantings.reduce((acc, row) => acc + row.spacingM, 0) / plotPlantings.length) * 100) / 100;
  const usedSeedlingIds = new Set(plotPlantings.map((row) => row.seedlingId));

  const seedlingLabel = (seedlingId: string): string => {
    const seedling = seedlingById.get(seedlingId);
    return seedling === undefined ? '（批次已删除）' : `${seedling.species} · ${seedling.spec}`;
  };

  const openCreate = (): void => {
    setEditing(null);
    setDensity(null);
    const firstReleased = releasedReleases[0]?.seedlingId ?? '';
    form.setFieldsValue({
      ...DEFAULT_VALUES,
      seedlingId: firstReleased,
      operator: releasedReleases[0]?.operator ?? '',
      plantDate: dayjs(),
    });
    setOpen(true);
  };

  const openEdit = (row: Planting): void => {
    setEditing(row);
    form.setFieldsValue({
      seedlingId: row.seedlingId,
      plantDate: dayjs(row.plantDate),
      spacingM: row.spacingM,
      count: row.count,
      operator: row.operator,
    });
    setDensity(plot === undefined ? null : checkDensity(plot.areaMu, row.spacingM, row.count));
    setOpen(true);
  };

  const handleValuesChange = (): void => {
    if (plot === undefined) return;
    const values = form.getFieldsValue();
    setDensity(checkDensity(plot.areaMu, values.spacingM, values.count));
  };

  const handleSubmit = async (): Promise<void> => {
    if (id === undefined) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      // 只允许引用已放行批次；放行依据（版本 / 结论）随栽植记录留底
      const release = releaseBySeedling.get(values.seedlingId);
      if (!editing && (release === undefined || release.state !== '已放行')) {
        message.error('该批次还没放行，不能下滩栽植；请先在上方报放行申请并等苗圃结论');
        return;
      }
      const payload = {
        plotId: id,
        seedlingId: values.seedlingId,
        releaseId: release?.id ?? null,
        basisVersion: release?.basisVersion ?? null,
        basisConclusion: release?.basisConclusion ?? null,
        plantDate: values.plantDate.format('YYYY-MM-DD'),
        spacingM: values.spacingM,
        count: values.count,
        operator: values.operator.trim(),
      };
      if (editing === null) {
        await create(payload, 'planting');
        message.success(`已登记栽植 ${payload.count} 株（依据检疫第 ${payload.basisVersion ?? '-'} 版）`);
      } else {
        // 已栽下去的记录照旧保留原依据，编辑只改株距 / 株数等班组字段
        await update(editing.id, {
          plantDate: payload.plantDate,
          spacingM: payload.spacingM,
          count: payload.count,
          operator: payload.operator,
        });
        message.success('栽植记录已更新');
      }
      const check = plot === undefined ? null : checkDensity(plot.areaMu, payload.spacingM, payload.count);
      if (check !== null && !check.ok) {
        message.warning(check.message, 6);
      }
      setOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const openReleaseCreate = (): void => {
    if (unreleasedBatchOptions.length === 0) {
      message.info('每个批次只能报一条放行申请，当前没有可申报的批次');
      return;
    }
    const first = unreleasedBatchOptions[0];
    releaseForm.setFieldsValue({
      seedlingId: first.id,
      requestCount: first.quantity,
      applyDate: dayjs(),
      operator: '',
    });
    setReleaseOpen(true);
  };

  const handleReleaseBatchChange = (seedlingId: string): void => {
    const seedling = seedlingById.get(seedlingId);
    if (seedling) releaseForm.setFieldValue('requestCount', seedling.quantity);
  };

  const handleReleaseSubmit = async (): Promise<void> => {
    if (id === undefined) return;
    try {
      const values = await releaseForm.validateFields();
      setReleaseSubmitting(true);
      const created = await applyReleaseRequest({
        plotId: id,
        seedlingId: values.seedlingId,
        requestCount: values.requestCount,
        applyDate: values.applyDate.format('YYYY-MM-DD'),
        operator: values.operator,
      });
      message.success(
        created.state === '已放行'
          ? `已放行（依据检疫第 ${created.basisVersion ?? '-'} 版），可以下滩栽植`
          : `申请已挂起：${created.reason}`,
        6,
      );
      setReleaseOpen(false);
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setReleaseSubmitting(false);
    }
  };

  const handleRefreshHeld = async (): Promise<void> => {
    setRefreshing(true);
    try {
      const count = await refreshHeld();
      message.success(count > 0 ? `${count} 条挂起申请状态已更新` : '挂起申请状态暂无变化（结论或隔离期未满足）');
    } catch (error) {
      if (error instanceof Error) message.error(error.message);
    } finally {
      setRefreshing(false);
    }
  };

  if (!ready) {
    return <Card loading title="班组放行申请与栽植记录" />;
  }

  if (plot === undefined) {
    return (
      <EmptyPanel
        title="地块不存在或已被删除"
        description={`未能找到 id 为「${id ?? ''}」的修复地块，无法登记栽植记录。`}
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

  const releaseColumns: ColumnsType<ReleaseRequest> = [
    {
      title: '申请日期',
      dataIndex: 'applyDate',
      key: 'applyDate',
      width: 110,
      sorter: (a, b) => a.applyDate.localeCompare(b.applyDate),
    },
    {
      title: '苗木批次',
      key: 'seedling',
      width: 200,
      render: (_value, record) => {
        const seedling = seedlingById.get(record.seedlingId);
        return (
          <Space direction="vertical" size={0}>
            <span>{seedling ? `${seedling.species} · ${seedling.spec}` : '（批次已删除）'}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              申请 {record.requestCount.toLocaleString('zh-CN')} 株
            </Typography.Text>
          </Space>
        );
      },
    },
    { title: '班组', dataIndex: 'operator', key: 'operator', width: 100 },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      width: 120,
      render: (value: ReleaseRequest['state']) => <ReleaseStateTag state={value} />,
    },
    {
      title: '苗圃结论',
      key: 'quarantine',
      width: 130,
      render: (_value, record) => {
        const q = quarantineBySeedling.get(record.seedlingId);
        return <QuarantineTag conclusion={q?.conclusion} version={q?.version} />;
      },
    },
    {
      title: '说明 / 放行依据',
      key: 'reason',
      render: (_value, record) => {
        const q = quarantineBySeedling.get(record.seedlingId);
        const stale = record.state === '已放行' && q !== undefined && record.basisVersion !== null && q.version > record.basisVersion;
        return (
          <Space direction="vertical" size={0}>
            <span>{record.reason}</span>
            {record.state === '已放行' ? (
              <Space size={4}>
                <Tag color="green">放行依据：{record.basisConclusion} v{record.basisVersion ?? '-'}</Tag>
                {stale ? <Tag color="orange">苗圃已出第 {q?.version} 版，已栽部分照旧</Tag> : null}
              </Space>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 110,
      render: (_value, record) =>
        record.state === '已放行' ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            终态不重算
          </Typography.Text>
        ) : (
          <Popconfirm
            title="撤回该放行申请？"
            description="只撤回班组申请，已有的栽植记录不受影响。"
            okText="撤回"
            cancelText="取消"
            onConfirm={async () => {
              await withdraw(record.id);
              message.success('放行申请已撤回');
            }}
          >
            <Button size="small" type="link" danger>
              撤回
            </Button>
          </Popconfirm>
        ),
    },
  ];

  const columns: ColumnsType<Planting> = [
    {
      title: '栽植日期',
      dataIndex: 'plantDate',
      key: 'plantDate',
      width: 110,
      sorter: (a, b) => a.plantDate.localeCompare(b.plantDate),
    },
    {
      title: '苗木批次',
      key: 'seedling',
      width: 180,
      render: (_value, record) => (
        <Space direction="vertical" size={0}>
          <span>{seedlingLabel(record.seedlingId)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {seedlingById.get(record.seedlingId)?.source ?? '—'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '放行依据',
      key: 'basis',
      width: 170,
      render: (_value, record) =>
        record.releaseId === null || record.releaseId === undefined ? (
          <Tag>升级前栽植</Tag>
        ) : (
          <Tag color="green">
            {record.basisConclusion ?? '合格'} v{record.basisVersion ?? '-'}
          </Tag>
        ),
    },
    {
      title: '株距（米）',
      dataIndex: 'spacingM',
      key: 'spacingM',
      width: 100,
      align: 'right',
      render: (value: number) => value.toFixed(2),
    },
    {
      title: '株数',
      dataIndex: 'count',
      key: 'count',
      width: 100,
      align: 'right',
      sorter: (a, b) => a.count - b.count,
      render: (value: number) => value.toLocaleString('zh-CN'),
    },
    {
      title: '平均单株占地',
      key: 'perPlant',
      width: 130,
      align: 'right',
      render: (_value, record) => `${checkDensity(plot.areaMu, record.spacingM, record.count).areaPerPlant} ㎡/株`,
    },
    {
      title: '密度校验',
      key: 'densityCheck',
      width: 110,
      render: (_value, record) => {
        const check = checkDensity(plot.areaMu, record.spacingM, record.count);
        return (
          <Tag color={check.level === 'success' ? 'green' : check.level === 'warning' ? 'orange' : 'red'}>
            {check.ok ? '合理' : check.level === 'warning' ? '偏疏' : '异常'}
          </Tag>
        );
      },
    },
    { title: '班组', dataIndex: 'operator', key: 'operator', width: 110 },
    {
      title: '操作',
      key: 'action',
      width: 140,
      render: (_value, record) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该栽植记录？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={async () => {
              await remove(record.id);
              message.success('栽植记录已删除');
            }}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
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
          {plot.name} · 班组放行与栽植
        </Typography.Text>
        <Tag color="cyan">{plot.tideZone}潮位带</Tag>
        <Tag>
          {plot.areaMu} 亩 / {Math.round(muToM2(plot.areaMu)).toLocaleString('zh-CN')} ㎡
        </Tag>
      </Space>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <StatBadge label="放行申请" value={plotReleases.length} suffix="批" tone="primary" />
        <StatBadge label="已放行可下滩" value={releasedReleases.length} suffix="批" tone="success" />
        <StatBadge
          label="挂起批次"
          value={heldReleases.length}
          suffix="批"
          tone={heldReleases.length > 0 ? 'warning' : 'default'}
          hint="没检疫 / 不合格 / 隔离期未满；挂起批不计栽植总株数、不出补植"
        />
        <StatBadge label="挂起株数（不计栽植）" value={heldQuantity.toLocaleString('zh-CN')} suffix="株" tone="warning" />
        <StatBadge label="栽植总株数" value={totalCount.toLocaleString('zh-CN')} suffix="株" tone="info" />
        <StatBadge label="平均株距" value={avgSpacing.toFixed(2)} suffix="米" tone="default" />
        <StatBadge
          label="已栽植批次"
          value={`${usedSeedlingIds.size} / ${plotSeedlings.length}`}
          tone="default"
          hint="已被栽植记录引用的批次占全部批次的比例"
        />
      </div>

      {releaseLastMessage !== '' ? (
        <Alert type="info" showIcon style={{ marginBottom: 14 }} message={releaseLastMessage} closable />
      ) : null}

      {heldReleases.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`${heldReleases.length} 批苗挂起等苗圃结论，共 ${heldQuantity.toLocaleString('zh-CN')} 株未计进栽植总株数，也不生成补植计划`}
          description={
            <Space direction="vertical" size={2}>
              {heldReleases.map((request) => (
                <span key={request.id}>
                  · {seedlingLabel(request.seedlingId)}：{request.reason}
                </span>
              ))}
            </Space>
          }
        />
      ) : null}

      {/* 第一摊（班组侧）：放行申请 */}
      <Card
        title="放行申请（班组按批次申报）"
        style={{ marginBottom: 14 }}
        extra={
          <Space wrap>
            <Button icon={<SyncOutlined />} loading={refreshing} onClick={() => void handleRefreshHeld()}>
              重算挂起申请
            </Button>
            <Button type="primary" icon={<SendOutlined />} onClick={openReleaseCreate} disabled={unreleasedBatchOptions.length === 0}>
              报放行申请
            </Button>
          </Space>
        }
      >
        {plotReleases.length === 0 && !releaseTable.loading ? (
          <EmptyPanel
            title="还没有放行申请"
            description="班组领苗先按批次报放行申请：苗圃没出合格结论或隔离期未满会自动挂起，挂起批不能下滩栽植。"
            actionText="报第一份放行申请"
            onAction={openReleaseCreate}
          />
        ) : (
          <Table<ReleaseRequest>
            rowKey="id"
            size="middle"
            loading={releaseTable.loading}
            columns={releaseColumns}
            dataSource={plotReleases}
            pagination={false}
          />
        )}
      </Card>

      {plotSeedlings.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="该地块尚未登记苗木批次"
          description="放行申请必须引用一个苗木批次，请先到苗木批次页登记进场苗木。"
          action={
            <Button size="small" onClick={() => navigate(ROUTES.seedlings(plot.id))}>
              去登记苗木批次
            </Button>
          }
        />
      ) : null}

      {/* 第二摊（班组侧）：地块栽植与成活率依据 */}
      <Card
        title="栽植记录（只录已放行批次）"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={releasedSeedlingIds.size === 0}>
            新增栽植记录
          </Button>
        }
      >
        <FilterBar
          keyword={keyword}
          onKeywordChange={setKeyword}
          fields={[{ key: 'operator', label: '班组', options: operatorOptions }]}
          values={{ operator: operatorFilter }}
          onChange={(key: string, value: string) => {
            if (key === 'operator') setOperatorFilter(value);
          }}
          onReset={() => {
            setKeyword('');
            setOperatorFilter('all');
          }}
          resultText={`命中 ${filtered.length} / ${plotPlantings.length} 条`}
        />

        {plotPlantings.length === 0 && !loading ? (
          <EmptyPanel
            title="该地块还没有栽植记录"
            description="等苗圃出合格结论、隔离期满放行后，再录入栽植日期、株距与株数；系统按地块面积校验栽植密度。"
            actionText="新增栽植记录"
            onAction={openCreate}
          />
        ) : (
          <Table<Planting>
            rowKey="id"
            size="middle"
            loading={loading}
            columns={columns}
            dataSource={filtered}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            locale={{
              emptyText: (
                <EmptyPanel
                  title="没有符合筛选条件的栽植记录"
                  actionText="重置筛选"
                  onAction={() => {
                    setKeyword('');
                    setOperatorFilter('all');
                  }}
                />
              ),
            }}
          />
        )}
      </Card>

      {/* 报放行申请弹窗 */}
      <Modal
        title="报放行申请"
        open={releaseOpen}
        onCancel={() => setReleaseOpen(false)}
        onOk={() => void handleReleaseSubmit()}
        confirmLoading={releaseSubmitting}
        okText="提交申请"
        cancelText="取消"
      >
        <Form form={releaseForm} layout="vertical">
          <Form.Item name="seedlingId" label="苗木批次（每批一条申请）" rules={[{ required: true, message: '请选择苗木批次' }]}>
            <Select
              placeholder="选择尚未申报的苗木批次"
              onChange={(value: string) => handleReleaseBatchChange(value)}
              options={unreleasedBatchOptions.map((row) => {
                const q = quarantineBySeedling.get(row.id);
                return {
                  value: row.id,
                  label: `${row.species} · ${row.spec} · ${row.quantity} 株（苗圃结论：${q?.conclusion ?? '未建检疫账'}）`,
                };
              })}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="requestCount"
              label="申请株数"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写申请株数' }]}
            >
              <InputNumber min={1} max={200000} step={100} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="applyDate" label="申请日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="operator" label="领用班组" rules={[{ required: true, message: '请填写领用班组' }]}>
            <Input placeholder="如：东港一班" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            提交时自动判定：没检疫或隔离期未满先挂起等苗圃结论；合格且隔离期满即放行，放行后才能录栽植。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title={editing === null ? '新增栽植记录' : '编辑栽植记录'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void handleSubmit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        width={560}
      >
        <Form form={form} layout="vertical" initialValues={DEFAULT_VALUES} onValuesChange={handleValuesChange}>
          <Form.Item name="seedlingId" label="已放行苗木批次" rules={[{ required: true, message: '请选择已放行批次' }]}>
            <Select
              placeholder="只列出已放行批次"
              disabled={editing !== null}
              options={releasedReleases.map((request) => {
                const seedling = seedlingById.get(request.seedlingId);
                return {
                  value: request.seedlingId,
                  label: `${seedling ? `${seedling.species} · ${seedling.spec}` : '（批次已删除）'} · ${request.requestCount.toLocaleString('zh-CN')} 株（${request.basisConclusion} v${request.basisVersion ?? '-'}）`,
                };
              })}
            />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="plantDate" label="栽植日期" style={{ flex: 1 }} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="spacingM"
              label="株距（米）"
              style={{ flex: 1 }}
              rules={[{ required: true, message: '请填写株距' }]}
            >
              <InputNumber min={0.2} max={10} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="count" label="株数" style={{ flex: 1 }} rules={[{ required: true, message: '请填写株数' }]}>
              <InputNumber min={1} max={200000} step={100} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="operator" label="作业班组" rules={[{ required: true, message: '请填写作业班组' }]}>
            <Input placeholder="如：东港一班" />
          </Form.Item>

          {density !== null ? (
            <Alert
              type={density.level === 'success' ? 'success' : density.level === 'warning' ? 'warning' : 'error'}
              showIcon
              message={`密度校验：${density.ok ? '合理' : '需要关注'}`}
              description={
                <span>
                  {density.message}
                  <br />
                  合理区间为 {DENSITY_MIN_M2_PER_PLANT}–{DENSITY_MAX_M2_PER_PLANT} ㎡/株。
                </span>
              }
            />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              填写株距与株数后会自动校验密度（合理区间 {DENSITY_MIN_M2_PER_PLANT}–{DENSITY_MAX_M2_PER_PLANT} ㎡/株）。
            </Typography.Text>
          )}
        </Form>
      </Modal>
    </div>
  );
}
