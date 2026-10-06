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
        ├── stores/             # plotStore.ts nurseryStore.ts releaseStore.ts surveyStore.ts replantStore.ts
        ├── components/common/  # RateTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # useSurvivalRate.ts useIdbTable.ts
        ├── pages/              # 7 个模块页面（含苗圃检疫台账、班组放行申请）
        ├── router/index.tsx    # 路由表 + ROUTES 常量
        └── utils/              # rate.ts quarantine.ts db.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/plots` | `pages/PlotList.tsx` | 修复地块台账：新建/编辑/级联删除、按潮位带与底质筛选、回显栽植总株数与最新成活率 |
| `/plots/:id/seedlings` | `pages/SeedlingBoard.tsx` | 苗木批次与来源登记、批次数量累计校验（含密度提示），登记后苗圃自动留「待检」底档 |
| `/plots/:id/quarantines` | `pages/QuarantineBoard.tsx` | **苗圃侧**检疫台账：每批的检疫结论（待检/合格/不合格）、结论版本、隔离期与检疫员，独立留底 |
| `/plots/:id/releases` | `pages/ReleaseGate.tsx` | **班组侧**放行申请：按批次报放行，没检疫/隔离期内先挂起；结论改动后重算，已放行写明依据版本 |
| `/plots/:id/plantings` | `pages/PlantingEntry.tsx` | 栽植记录：只能引用已放行批次，录株距与株数、按面积与株距校验密度；挂起批次不计株数 |
| `/surveys` | `pages/SurveyBoard.tsx` | 成活率与株高验收台：按测次录入、自动算成活率、低于阈值告警、批量调整成活率等级 |
| `/replants` | `pages/ReplantPlan.tsx` | 补植计划：状态流转（待补植→已补植→已复核）、行内草稿、JSON 导入导出、结构版本查看 |

`/` 重定向到 `/plots`，未匹配路径统一回落到 `/plots`。
**层级路由支持直接深链**：把 `http://localhost:22814/plots/plot-donggang-3/seedlings` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「地块不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbmangrove`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`，`version(1)` 建立全部表，`version(2)` 补齐索引并迁移，`version(3)` 把
  **苗圃检疫**与**班组放行**两摊分家、各立一张表：
  * v2：为 `plots` 增加 `updatedAt`、`surveys` 增加 `[plotId+round]` 复合索引、`plantings` 增加 `spacingM` 索引；
    回填 `revision`/`createdAt`/`updatedAt`；为 `plots` 补 `missingCount`/`lastReplantDate`；为 `surveys` 补 `grade`/`gradeManual`。
  * v3：新增 `quarantines`（苗圃：每批检疫结论/结论版本/隔离期）与 `releaseRequests`（班组：按批次放行申请）两张表，并迁移旧数据：
    * **旧数据没有检疫结论**：按批次**到场日期**补一条「待检 · 升级补录」档案（隔离自到场日起算）；
      到场日期补不上（缺失/格式不符）的批次**先搁着、不建档**，可在检疫台账页补建。
    * **已栽下去的照旧留着**：为既有栽植记录引用到的批次补一条「已放行」申请，放行依据写明第 1 版结论，
      保证升级后历史栽植总株数与成活率不被当成挂起而清零。
* **两摊分家、各自留底**：
  * 苗圃侧只写 `quarantines`：保存检疫结论失败时**只重试自己**（最多 3 次），班组 `plantings` 栽植记录一律不动。
  * 班组侧只写 `releaseRequests`/`plantings`：按批次报放行，结论改动后由 `recalcOpenReleaseRequests()`
    只重算「还没放行」的申请；已放行/已栽植的固化放行快照（依据第几版结论）不再变动。
* **表结构**：

  | 表 | 归属 | 主键 | 主要索引 |
  | --- | --- | --- | --- |
  | `plots` | 共用 | id | name, tideZone, substrate, restoreMode, state, createdAt, updatedAt |
  | `seedlings` | 苗圃（批次/进场量台账） | id | plotId, species, source, arrivalDate, quantity |
  | `quarantines` | 苗圃（检疫结论/隔离期） | id | seedlingId, plotId, conclusion, version |
  | `releaseRequests` | 班组（放行申请） | id | plotId, seedlingId, state, requestDate |
  | `plantings` | 班组（地块栽植/成活率） | id | plotId, seedlingId, plantDate, spacingM |
  | `surveys` | 班组（验收） | id | plotId, [plotId+round], date, grade |
  | `replants` | 班组（补植） | id | plotId, planDate, state, species |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `plots` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **地块 → 苗木批次 → 苗圃检疫 / 班组放行 → 栽植 → 验收 → 补植**：
  * 3 个地块（东港南堤 3 号地块 / 西湾滩涂 A 区 / 北屿外滩 B 区），覆盖三种潮位带与三种底质；
  * 7 个苗木批次：6 批检疫合格且隔离期满、已放行并栽植；另有 1 批「白骨壤」待检在隔离、放行申请被挂起，不计栽植总株数；
  * 6 条栽植记录（引用已放行批次 id）、7 条验收记录（成活率自洽：90.0% → 85.0% → 79.0% 等）；
  * 7 条放行申请（6 已放行 + 1 挂起）、3 条补植计划（待补植 / 已补植 / 已复核）。
  * 固定 id 如 `plot-donggang-3`、`plot-xiwan-a`、`plot-beiyu-b` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的地块 id」这一界面偏好，不存业务数据。
* 删除地块会**级联清理**其下的苗木批次、检疫档案、放行申请、栽植记录、验收记录与补植计划（同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22814
```

其他命令：

```bash
npm run build             # tsc --noEmit && vite build（零错误）
npm run typecheck         # 仅做 TypeScript 类型检查
npm run preview           # 预览 dist 产物
npm run verify            # 在 fake-indexeddb 上跑 v2→v3 迁移与「苗圃失败只重试自己」端到端断言
```

---

## 七、核心业务规则

* **苗圃 / 班组两摊分家、各自留底**：苗圃只登记每批的**检疫结论与隔离期**（`quarantines`）；
  班组只管地块**栽植与成活率**（`plantings`），中间通过按批次的**放行申请**（`releaseRequests`）衔接。
* **放行闸门**：班组领苗按批次报放行——没检疫（待检/无档案）或还在隔离期内的先**挂起**等苗圃出结论，
  不合格的驳回。**挂起那批苗不计进栽植总株数，也不出补植计划**；栽植页只能选择已放行批次。
* **结论改动联动**：检疫结论改动时版本号 +1，**还没放行的申请跟着重算**（隔离期满后自动放行并固化当前版本）；
  **已放行、栽下去的照旧留着**，放行记录写明依据的是第几版结论，之后苗圃再改也不动它。
* **失败隔离**：苗圃侧保存检疫结论失败时只重试苗圃自己的保存动作（最多 3 次），班组栽植记录不回滚、不受影响。
* **旧数据升级**：无检疫结论的批次按**到场日期**补一条「待检」来源；到场日期补不上的批次先搁着不建档；
  已被既有栽植引用的批次补登「已放行（第 1 版）」，保证历史栽植数据照旧有效。
* **成活率** = 成活株数 ÷ 该地块**已放行批次**栽植总株数 × 100%（`src/utils/rate.ts` 统一口径）。
* **成活率等级**：≥ 85% 优，70%–85% 良，50%–70% 一般，< 50% 差；低于 50% 视为告警，建议生成补植计划。
* **密度合理性**：平均单株占地面积需落在 0.6–12 ㎡/株；过密/过疏都会在栽植记录页给出提示。
* **隔离期口径**：隔离截止日 = 隔离起算日 + 隔离天数，**截止当日即隔离期满**可放行（`src/utils/quarantine.ts`）。
* **补植回写**：补植状态推进到「已补植」时，自动扣减地块缺株数、写入最近补植日期，
  并按「原成活株数 + 本次补植株数」重算最新一次验收的成活率（分母同样只算已放行批次）。
