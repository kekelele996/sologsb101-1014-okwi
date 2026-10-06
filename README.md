# 红树林修复地块成活率跟踪台（sologsb101-1014）

面向红树林修复项目的现场管理人员：按地块登记苗木批次与栽植记录，分次验收成活株数与株高，
按测次生成成活率趋势，低于阈值时生成补植计划并回写地块缺株数。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22814**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbmangrove` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18 | 函数组件 + Hooks |
| 语言 | TypeScript 5 | `strict` 模式，`tsc --noEmit` 零错误 |
| UI 组件库 | Ant Design 5 | 表格、表单、弹窗、日期选择、消息提示 |
| 图标 | @ant-design/icons | |
| 构建 | Vite 5 | 开发端口与宿主端口一致（22814） |
| 路由 | React Router 6 | `createBrowserRouter` + 路由懒加载 |
| 状态管理 | Zustand 4 | 跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbmangrove`，含 v1 → v2 → v3 升级迁移 |
| 时间处理 | dayjs | |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1014/
├── README.md
├── docker-compose.yml          # name: gbmangrove，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.tsx            # 入口：ConfigProvider + RouterProvider
        ├── App.tsx             # 外壳：侧边导航 + 当前地块上下文 + 数据库初始化
        ├── styles/main.css
        ├── types/              # plot.ts seedling.ts quarantine.ts release.ts planting.ts survey.ts replant.ts
        ├── stores/             # plotStore surveyStore replantStore quarantineStore releaseStore.ts
        ├── components/common/  # RateTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx QuarantineTag.tsx ReleaseStateTag.tsx
        ├── hooks/              # useSurvivalRate.ts useIdbTable.ts
        ├── pages/              # 5 个模块页面
        ├── router/index.tsx    # 路由表 + ROUTES 常量
        └── utils/              # rate.ts db.ts export.ts seed.ts id.ts quarantine.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/plots` | `pages/PlotList.tsx` | 修复地块台账：新建/编辑/级联删除、按潮位带与底质筛选、回显栽植总株数与最新成活率 |
| `/plots/:id/seedlings` | `pages/SeedlingBoard.tsx` | 苗木批次进场账 + **苗圃检疫台账（每批的检疫结论、隔离期与版本留痕）**；批次数量累计校验（含密度提示） |
| `/plots/:id/plantings` | `pages/PlantingEntry.tsx` | **班组放行申请（按批次申报、挂起重算）** + 栽植记录（只录已放行批次、写明依据版本）；按面积与株距校验密度合理性 |
| `/surveys` | `pages/SurveyBoard.tsx` | 成活率与株高验收台：按测次录入、自动算成活率、低于阈值告警、批量调整成活率等级 |
| `/replants` | `pages/ReplantPlan.tsx` | 补植计划：状态流转（待补植→已补植→已复核）、行内草稿、JSON 导入导出、结构版本查看 |

`/` 重定向到 `/plots`，未匹配路径统一回落到 `/plots`。
**层级路由支持直接深链**：把 `http://localhost:22814/plots/plot-donggang-3/seedlings` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「地块不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbmangrove`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`，`version(1)` 建立全部表，`version(2)` 补齐索引并执行 `.upgrade()` 迁移，`version(3)` 把苗圃检疫与班组栽植两摊账分开：
  * v2 迁移：为 `plots` 增加 `updatedAt`、`surveys` 增加 `[plotId+round]` 复合索引、`plantings` 增加 `spacingM` 索引等；回填 `revision` / `createdAt` / `updatedAt`；为 `plots` 补齐 `missingCount`、`lastReplantDate`；为 `surveys` 补齐 `grade`、`gradeManual`。
  * **v3 迁移（苗圃 / 班组两账分立）**：
    * 新增 `quarantines`（苗圃检疫台账：结论、结论日期、隔离期、版本与历史留痕）与 `releases`（班组按批次报的放行申请）两张表；`plantings` 增加 `releaseId` 索引与 `basisVersion` / `basisConclusion` 放行依据字段；
    * 旧数据没有检疫结论，升级时**按批次到场日期补一条「待检」来源**（注明来源为到场日期）；到场日期缺失或格式无效的批次**补不上先搁着**，由苗圃在苗木批次页点「补登待检」人工补登；
    * 升级前已栽下去的栽植记录照旧保留、不补放行依据（页面标注「升级前栽植」），照常计入栽植总株数。
* **表结构**：

  | 表 | 主键 | 主要索引 | 归属 |
  | --- | --- | --- | --- |
  | `plots` | id | name, tideZone, substrate, restoreMode, state, createdAt, updatedAt | 地块 |
  | `seedlings` | id | plotId, species, source, arrivalDate, quantity | 苗圃（批次进场账） |
  | `quarantines` | id（`quarantine-<seedlingId>`，一批一条） | plotId, seedlingId, conclusion, updatedAt | **苗圃留底：检疫结论 / 隔离期 / 版本** |
  | `releases` | id | plotId, seedlingId, state, applyDate, releasedAt | **班组留底：按批次的放行申请** |
  | `plantings` | id | plotId, seedlingId, plantDate, spacingM, releaseId | **班组留底：地块栽植 / 成活率依据** |
  | `surveys` | id | plotId, [plotId+round], date, grade | 验收 |
  | `replants` | id | plotId, planDate, state, species | 补植 |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `plots` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **地块 → 苗木批次 / 苗圃检疫台账 → 班组放行申请 → 栽植 → 验收 → 补植**：
  * 3 个地块（东港南堤 3 号地块 / 西湾滩涂 A 区 / 北屿外滩 B 区），覆盖三种潮位带与三种底质；
  * 8 个苗木批次（每地块 2 批正常下滩，东港另加 2 批挂起苗：一批检疫不合格、一批隔离期未满）、8 条检疫台账（含一条两版留痕）；
  * 8 条班组放行申请（6 条已放行 + 2 条挂起）、6 条栽植记录（只引用已放行批次并写明依据版本）；
  * 7 条验收记录（每地块 2–3 个测次，成活率自洽：90.0% → 85.0% → 79.0% 等）；
  * 3 条补植计划（覆盖待补植 / 已补植 / 已复核三种状态）。
  * 固定 id 如 `plot-donggang-3`、`plot-xiwan-a`、`plot-beiyu-b` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的地块 id」这一界面偏好，不存业务数据。
* 删除地块会**级联清理**其下的苗木批次、检疫台账、放行申请、栽植记录、验收记录与补植计划（同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22814
```

其他命令：

```bash
npm run build        # tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则

* **两摊账各自留底（v3）**：苗圃侧 `quarantines` 管每批的检疫结论与隔离期（结论/日期/隔离期改动自动升版并保留历史）；
  班组侧 `releases`（放行申请）与 `plantings`（地块栽植、成活率依据）分开记录，互不代填。
* **班组放行**：领苗按批次报放行申请；苗圃没出结论（待检）→「挂起-待检」，结论不合格 →「挂起-不合格」，
  合格但隔离期未满 →「挂起-隔离期」；合格且隔离期满才转「已放行」并记下依据的检疫版本号。
* **挂起批口径**：挂起批没有栽植行，**不计进栽植总株数，也不出补植计划**；页面与 CSV 单列挂起批次/挂起株数。
* **结论改动重算**：苗圃保存检疫结论后，只重算**还没放行**的申请；**已放行是终态不重算**，
  已栽下去的记录照旧保留，栽植行写明当时依据的检疫版本（如「复检合格 v2」），苗圃再出新版本时标注「已栽部分照旧」。
* **保存失败隔离**：苗圃保存检疫结论只写自己的 `quarantines` 表并带退避重试（共 3 次尝试），
  不与班组栽植记录同事务；苗圃重试 / 失败全程不动班组栽植记录。
* **旧数据升级**：没有检疫结论的旧批次按到场日期补一条「待检」；到场日期缺失 / 无效的批次补不上先搁着，
  可在苗木批次页人工「补登待检」；升级前已栽植的记录照旧保留、照常计入总株数（标注「升级前栽植」）。
* **成活率** = 成活株数 ÷ 该地块栽植总株数 × 100%（`src/utils/rate.ts` 统一口径）。
* **成活率等级**：≥ 85% 优，70%–85% 良，50%–70% 一般，< 50% 差；低于 50% 视为告警，建议生成补植计划。
* **密度合理性**：平均单株占地面积需落在 0.6–12 ㎡/株；过密/过疏都会在栽植记录页给出提示。
* **补植回写**：补植状态推进到「已补植」时，自动扣减地块缺株数、写入最近补植日期，
  并按「原成活株数 + 本次补植株数」重算最新一次验收的成活率。
