# ai-paint

**Excalidraw 风格的手绘图表绘图引擎 + MCP 服务** —— 让 AI 助手（Claude、Cursor、任何支持 MCP 的客户端）用一句自然语言，就能画出**流程图 / 架构图 / 时序图 / ER 图**，输出为手绘风格的 **SVG / PNG**。

```
┌────────────────────────────────────────────────────────┐
│  你（AI 客户端）                                       │
│  "画一个登录流程图，含菱形判断和数据库圆柱"              │
└────────────────────────┬───────────────────────────────┘
                         │ MCP (stdio, JSON-RPC)
┌────────────────────────▼───────────────────────────────┐
│  ai-paint  MCP 服务                                     │
│  ┌────────────┐  ┌─────────────┐  ┌──────────────────┐  │
│  │ 布局系统     │→│ 连接线系统    │→│ ts-svg 渲染       │  │
│  │ layered    │ │ straight    │ │  SVG / PNG        │  │
│  │ tree/grid  │ │ bezier…     │ │ (手绘风格)         │  │
│  └────────────┘  └─────────────┘  └──────────────────┘  │
└────────────────────────────────────────────────────────┘
```

---

## 📖 目录

- [一、功能介绍](#一功能介绍)
- [二、原理介绍](#二原理介绍)
- [三、小白安装使用](#三小白安装使用)
  - [3.1 安装 Node.js](#31-安装-nodejs)
  - [3.2 全局安装 ai-paint](#32-全局安装-ai-paint)
  - [3.3 接入 AI 客户端](#33-接入-ai-客户端)
  - [3.4 试试看（示例）](#34-试试看示例)
  - [3.5 常见问题](#35-常见问题)
- [四、MCP 工具一览](#四mcp-工具一览)
- [五、输出 SVG / PNG](#五输出-svg--png)
- [六、作为 npm 库使用](#六作为-npm-库使用)
- [License](#license)

---

## 一、功能介绍

### 核心卖点

| 能力 | 说明 |
|---|---|
| 🎨 **手绘风格** | 形状带种子化抖动、双线描边、影线填充，看起来像真人手绘（Excalidraw / rough.js 风格） |
| 🧩 **21 种节点形状** | 矩形、菱形、椭圆、圆柱（数据库）、便签、星形、UML 人物、云朵、心形…… |
| 🔀 **5 种连接线** | 直线 / 正交折线 / 贝塞尔曲线 / 平滑曲线 / 弧线，自动避障、平行边自动错开 |
| 🗺️ **4 种布局** | 分层（layered）、树形（tree）、网格（grid）、环形（circular） |
| 📊 **4 种图表** | 流程图 / 系统架构图 / 时序图 / ER 实体关系图，一条命令生成 |
| 🖼️ **SVG + PNG** | SVG 矢量（可无损缩放 / 编辑），PNG 位图（无头渲染，方便预览） |
| 🤖 **MCP 原生** | 通过 MCP stdio 协议接入任意 AI 客户端 |

### 支持的图表

**统一图表管线**（`create_diagram`）—— 完全贴合"大模型产出节点/边数组"的流程：

```
1. 用户指定图类型 + 图描述
2. 大模型给出 nodes：[{ name, description, type, width, height, x, y }]
              edges：[{ source, target }]
3. ai-paint 归一化数据契约（name→key、source/target→from/to、type→形状）
4. antv/layout 布局（layered / tree / grid / circular）
5. 后处理：环（自环/回边）、位置检查、碰撞推挤 → 最终绘制数据
6. 本地缓存（.ai-paint/plans/，输入指纹命中）→ 绘制
7. 生成 SVG + PNG（默认导出到当前目录）
```

**① 流程图 / 有向图** —— `create_flow_diagram` / `create_diagram type=flow`
- 支持菱形**判断分支**（"是/否"自动从菱形上进、下出/左出）、循环回边、多分支
- 自动布局：节点按依赖分层，连线不重叠、对齐美观、整体居中

**② 系统架构图** —— `create_architecture_diagram`
- 自上而下分层：每层一个大框 + 标题 + 配色，层内含多个子模块
- 跨层依赖连线自动正交避障，对齐用直线、错位用 U 型

**③ 时序图** —— `create_sequence_diagram`
- 参与者顶部排开 + 生命线 + 实线/虚线消息 + 自消息 + 标题

**④ ER 实体关系图** —— `create_er_diagram`
- 实体（表）网格排布、字段行、主键标记、关系连线 + 基数标注（1:1 / 1:N / N:M）
- 标准 crow's foot 关系端标记

### 进阶特性

- **确定性渲染**：同一个场景每次渲染结果完全一致（抖动种子来自元素 id）
- **自动居中**：生成的图在画布上下左右居中
- **文本安全化**：自动剔除 emoji / 特殊符号，避免渲染成乱码问号
- **持久化**：场景自动保存到 `.ai-paint/` 目录，重启服务不丢失

---

## 二、原理介绍

### 2.1 整体架构

```
AI 客户端 (MCP Client)
        │  tools/call { name, arguments }
        ▼
┌─────────────────── ai-paint MCP Server ───────────────────┐
│  src/mcp/   JSON-RPC stdio 协议 · 场景存储 (SceneStore)     │
│  src/tools/ 32 个工具：add_shape / create_diagram / export_scene …   │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  src/core/  纯 TypeScript 绘图引擎（无 DOM 依赖）      │  │
│  │   layout.ts   布局系统：节点坐标计算                    │  │
│  │   connectors.ts  连接线系统：路由 / 避障 / 箭头         │  │
│  │   shapes.ts   21 种形状的几何计算                      │  │
│  │   rough.ts    手绘抖动核心                            │  │
│  │   render.ts   SVG 渲染器                             │  │
│  │   ts-svg.ts   内置类型安全 SVG 构建器                  │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
        │  SVG 字符串 / PNG 文件路径
        ▼
  最终交付：<svg> 文档 或 位图 PNG
```

**设计原则：纯引擎，无 DOM**。`src/core/*` 不依赖浏览器 / canvas，所有渲染都是"算坐标 → 拼 SVG 字符串"。因此在 Node 无头环境（服务器、CI、MCP）中也能稳定运行。

### 2.2 手绘效果是怎么来的？

1. **几何计算**：每个形状先生成精确的多边形（如矩形的 4 个顶点、椭圆的 48 个采样点）。
2. **种子化抖动**：用一个确定性随机数生成器（mulberry32，种子取自元素 `id`），把每个顶点 / 每条边轻微扰动 —— 所以看起来手绘，但同一 `id` 每次画得一模一样。
3. **双线描边**：外轮廓 + 内缩一圈的轮廓各描一次，形成手绘"双笔"效果。
4. **影线填充**：在形状内生成一组平行斜线（hachure），交叉就成 cross-hatch。
5. **圆角处理**：矩形四个尖角用二次贝塞尔圆滑，消除折角。
6. **SVG 拼装**：把所有 line / polygon / path 拼成一个 SVG 字符串返回。

### 2.3 布局系统怎么工作？

布局核心基于 **[@antv/layout](https://www.npmjs.com/package/@antv/layout) 2.x**（AntV 官方图布局算法库，底层 dagre / d3 系列），保证专业算法质量；对 dagre 不适用的**带回边流程图**（迭代 / 回退边）自动回退到内置的手写分层。

| 布局 | 引擎 | 原理 |
|---|---|---|
| `layered` 分层 | DagreLayout（无环）／手写分层（有环） | 按"依赖深度"分列：根节点最左，下游逐列右移；dagre 的 network-simplex 排名 + 交叉减少。检测到环时回退手写（回边视作根，避免 acyclicer 反转破坏主链） |
| `tree` 树形 | DagreLayout | 自上而下（TB）或从左到右（LR），`rankdir` 控制方向，节点间距紧凑 |
| `grid` 网格 | GridLayout | 行列排布，自动列数 / 防重叠 |
| `circular` 环形 | CircularLayout | 节点均匀分布在圆周上（可调半径 / 起始角） |

> 布局 API 是异步的：`computeLayout()` 返回 `Promise<LayoutResult>`，工具层与库调用方均已适配。

生成坐标后，工具层调用 `fitSceneContent` **自动居中**：画布 = 内容外接盒 + 四周留白，元素整体平移到中心。

### 2.4 连接线怎么不打架？

连接线系统（参考 AntV X6 的 edge 概念）做四件事：

1. **锚点选边**：先判断两节点中心连线方向，决定从哪个边（上/下/左/右）出发进入；**菱形判断节点特殊约定** —— 进走 top、出分支走 bottom / left。
2. **槽位错开**：同一节点同一侧的多条连线，从边中心向两侧扇形展开（间距 ≥14px），平行边不会叠在一起。
3. **正交避障**：正交线自动检测障碍节点，绕行（L 型 / U 型）；架构图强制 ≥3 段（禁止 L 型贴边）。
4. **重合升级**：检测到两条边路径共线重叠时，后一条自动升级为**正交或贝塞尔曲线**绕开。

### 2.5 MCP 是怎么暴露的？

MCP（Model Context Protocol）是 AI 客户端与工具之间的标准协议。ai-paint 用 **stdio 传输 + JSON-RPC**：

- `tools/list` → 客户端看到可用的 32 个绘图工具
- `tools/call` → 客户端调用某个工具，传入 JSON 参数，收到结果
- 全程零网络端口，走标准输入输出，天然安全（不对外开 HTTP）

---

## 三、小白安装使用

> 只需要会打开终端、复制粘贴，跟着做就行。

### 3.1 安装 Node.js

ai-paint 需要 **Node.js ≥ 18**。

1. 打开浏览器访问：<https://nodejs.org>
2. 下载 **LTS** 版本（长期支持版）
3. 双击安装包，一路"下一步"完成安装
4. 验证：打开终端（Windows 用 PowerShell，Mac 用"终端"App），输入：

```bash
node --version
```

看到 `v18.x.x` 或更高版本即成功。

### 3.2 全局安装 ai-paint

打开终端，执行：

```bash
npm install -g @bysking/ai-paint
```


### 3.3 接入 AI 客户端

ai-paint 是一个 MCP 服务，需要在你的 AI 客户端（如 Claude Desktop、Cursor、VS Code 的 Claude Code 等）里配置。

以 **Claude Desktop** 为例：

1. 打开 Claude Desktop → 设置 → Developer → Edit Config
2. 在配置文件里加入以下内容：

```json
{
  "mcpServers": {
    "type": "stdio",
    "ai-paint": {
      "command": "ai-paint",
      "args": []
    }
  }
}
```

3. 保存并**重启 Claude Desktop**

> 💡 **如果你没装全局**，也可以用绝对路径指向 npm 安装后的 bin 入口：
> ```json
> { "mcpServers": { "ai-paint": { "command": "node", "args": ["/你的安装路径/node_modules/ai-paint/dist/cli.js"] } } }
> ```

### 3.4 试试看（示例）

接入成功后，直接在对话里说：

> **"画一个用户登录的流程图：开始 → 判断是否合法（菱形）→ 是则处理并完成，否则报错"**

AI 会调用 `create_flow_diagram` 工具生成手绘风格流程图。

你也可以让 AI 生成**架构图**：

> **"画一个微服务架构图：展示层、服务层、数据层三层"**

或者 **ER 图**：

> **"画用户表和订单表的 ER 图，一对多关系"**

或者 **时序图**：

> **"画用户登录的时序图：用户 → 服务 → 数据库"**

### 统一管线（`create_diagram`）示例

AI 端只需要提供节点 / 边数组（字段贴合 perf.md 约定）：

```jsonc
{
  "name": "create_diagram",
  "arguments": {
    "scene": "dev_flow",
    "type": "flow",                        // flow | layered | tree | grid | circular | sequence | er | architecture
    "title": "产品研发流程",
    "nodes": [                             // 节点：name 唯一，type 即形状
      { "name": "需求分析", "type": "process", "description": "收集需求" },
      { "name": "产品设计", "type": "document" },
      { "name": "UI设计", "type": "process" },
      { "name": "开发", "type": "process" },
      { "name": "测试", "type": "process" },
      { "name": "上线", "type": "end" }
    ],
    "edges": [                             // 边：source / target 引用节点 name
      { "source": "需求分析", "target": "产品设计" },
      { "source": "产品设计", "target": "UI设计" },
      { "source": "UI设计", "target": "开发" },
      { "source": "开发", "target": "测试" },
      { "source": "测试", "target": "开发", "label": "回归", "dashed": true },
      { "source": "测试", "target": "上线" }
    ],
    "export_svg_png": true                  // 自动导出 dev_flow.svg + dev_flow.png
  }
}
```

返回 `fingerprint`（缓存指纹）、`nodes`（每个节点的坐标与场景元素 id）、`export`（svg/png 路径）。再次提交相同输入会**命中缓存**（`fromCache: true`），直接复用上一次的最终数据。

---

### 3.5 常见问题

| 问题 | 解决 |
|---|---|
| 提示 `command not found: ai-paint` | 全局安装没成功。确认 `npm install -g ai-paint` 无报错；Windows 可检查 PATH |
| 客户端连不上 | 先在终端 `echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' \| ai-paint` 手动验证：能回 `{}` 说明协议正常；否则确认 MCP 版本已升级（旧版有帧丢失 bug）。再检查配置文件 JSON 格式 |
| 想输出 PNG | 让 AI 调用 `save_scene_png` 工具，指定 `path: "./xxx.png"` |
| 图没居中 / 想加大留白 | 工具参数 `padding` 可调（默认 60） |
| 想清空场景重新画 | 传参 `clear_existing: true` |

---

## 四、MCP 工具一览

### 场景管理

| 工具 | 说明 |
|---|---|
| `new_scene` | 创建场景（宽高 / 背景 / 纸感） |
| `list_scenes` | 列出所有场景 |
| `get_scene` | 查看场景元素与画布信息 |
| `update_scene` | 批量修改画布属性 |
| `clear_scene` / `delete_scene` | 清空 / 删除场景 |

### 基础绘图

| 工具 | 说明 |
|---|---|
| `add_rectangle` / `add_ellipse` / `add_diamond` | 基础形状 |
| `add_shape` | **任意形状**（21 种） |
| `add_line` / `add_arrow` / `add_draw` | 折线 / 箭头 / 自由手绘 |
| `add_text` / `add_image` / `add_frame` | 文本 / 图片 / 分组框 |
| `add_edge` | 连接线（5 种类型 + 箭头 + 虚线 + 标签） |

### 一键生成图表

| 工具 | 说明 |
|---|---|
| `create_diagram` | **统一图表入口（perf.md 流程）**：一次完成布局 → 后处理 → 缓存 → 绘制 → 导出 svg+png。`type` 支持 flow/layered/tree/grid/circular/sequence/er/architecture |
| `create_flow_diagram` | **流程图 / 有向图**（布局 + 多形状 + 连接线 + 标签，一次调用；节点用 `name/type`、边用 `source/target` 契约） |
| `create_architecture_diagram` | **系统架构图**（分层大框 + 子模块 + 正交跨层连线） |
| `create_sequence_diagram` | **时序图** |
| `create_er_diagram` | **ER 实体关系图**（含 crow's foot 基数标记） |
| `plan_flow_layout` | 布局预演（只算坐标不绘制，返回指纹可查缓存） |

### 统一管线与缓存

| 工具 | 说明 |
|---|---|
| `export_scene` | 把场景导出为 **svg + png + excalidraw** 文件。`formats` 可选 `["svg","png","excalidraw"]`；`.excalidraw` 是可编辑的 Excalidraw v2 文件（excalidraw.com 可直接打开编辑） |
| `get_plan` | 读取某条缓存的**最终绘制计划**（FinalPlan：坐标/节点表/边/碰撞统计） |
| `list_plans` | 列出本地缓存的所有绘制计划 |
| `delete_plan` | 删除一条缓存计划 |

### 输出与编辑

| 工具 | 说明 |
|---|---|
| `get_scene_svg` | 返回 SVG 字符串 |
| `save_scene_svg` | SVG 落盘 |
| `save_scene_png` | PNG 落盘（`@resvg/resvg-js` 无头渲染，`scale` 可调），**同时自动生成同名 `.excalidraw` 可编辑文件**（传 `export_excalidraw: false` 关闭） |
| `update_element` / `delete_element` | 按 id 编辑 / 删除元素 |

### 可编辑 .excalidraw 导出

`create_diagram` 传 `export_excalidraw: true`，或 `export_scene` 传 `formats:["excalidraw"]`，即可在 PNG/SVG 之外额外生成 **Excalidraw v2 格式的可编辑文件**：

- 在 **excalidraw.com**（浏览器直接拖入）、Excalidraw 桌面端、Obsidian 等中打开，所有元素可选中 / 拖动 / 改文字 / 改颜色
- 连线（edge）导出为 **arrow 元素，两端绑定**（`startBinding` + `endBinding` + 双向 `boundElements`）——拖动任意一端节点，箭头两端都跟随移动
- 节点内的文字导出为**容器文字**（`containerId` 绑定到所在节点 + 节点 `boundElements` 回引 `{type:'text'}` + 居中坐标）——拖动节点时文字跟着节点走
- **时序图**：participant box + 生命线自动分组（`groupIds`），消息箭头两端绑定参与者，消息标签绑定到箭头
- **架构图**：层标题绑定 frame（左上对齐）、模块标签绑定模块（居中）、跨层链路两端绑定模块
- **ER 图**：每个实体（header + body + 字段 + 分隔线 + 主键图标）自动分组，字段文字保留原位置自由左对齐，标题绑定 header，关系线两端绑定 header
- 图片导出为 `files` 字典 + `fileId` 引用
- 零依赖手写实现（`src/core/excalidraw.ts`），无 `@excalidraw/excalidraw` / `agent-excalidraw` 重量级依赖
- 非 Excalidraw 原生形状（cylinder/note/star/document 等）回退为 rectangle，保持可编辑；视觉形状保留在 PNG/SVG

---

## 五、输出 SVG / PNG

```jsonc
// 取 SVG 字符串
{ "name": "get_scene_svg", "arguments": { "scene": "flow" } }

// 保存 SVG 文件
{ "name": "save_scene_svg", "arguments": { "scene": "flow", "path": "./output/flow.svg" } }

// 保存 PNG（2x 放大）
{ "name": "save_scene_png", "arguments": { "scene": "flow", "path": "./output/flow.png", "scale": 2 } }

// 导出可编辑的 .excalidraw 文件（Excalidraw v2）
{ "name": "export_scene", "arguments": { "scene": "flow", "formats": ["excalidraw"], "dir": "./output" } }
// 或 create_diagram 时一并导出
{ "name": "create_diagram", "arguments": { "scene": "flow", "type": "flow", "nodes": [...], "edges": [...], "export_excalidraw": true } }
```

---

## 六、作为 npm 库使用

除了 MCP 服务，ai-paint 也能作为普通 TypeScript 库引入（无 DOM，Node 环境可用）：

```ts
import { blankScene, createElement } from 'ai-paint'
import { renderSceneSvg } from 'ai-paint'

const scene = blankScene('flow', 1000, 600)
scene.elements.push(
  createElement('shape', {
    x: 100, y: 120, width: 220, height: 90,
    background_color: '#ffd8a8', fill_style: 'hachure', roughness: 1.2,
    data: { shape: 'rounded-rectangle' },
  }),
  createElement('text', {
    x: 200, y: 152, data: { text: '你好', font_size: 22, text_align: 'center', text_stroke_color: '#ffffff', text_stroke_width: 3 },
  }),
)
const svg = renderSceneSvg(scene) // string
```

高级用法 —— 直接调用布局与连接线系统：

```ts
import { computeLayout } from 'ai-paint'
import { routeEdge } from 'ai-paint'

const layout = await computeLayout(nodes, edges, { kind: 'tree', direction: 'TB' })
const edge = routeEdge(fromNode, toNode, { type: 'bezier', arrow: 'triangle' })
```

统一图表管线（perf.md 流程）：

```ts
import { planDiagram, drawFlowScene, blankScene, renderSceneSvg, PlanStore } from 'ai-paint'

// 1. 大模型给出节点 / 边数组
const nodes = [
  { name: '开始', type: 'start' },
  { name: '判断', type: 'decision' },
  { name: '完成', type: 'end' },
]
const edges = [{ source: '开始', target: '判断' }, { source: '判断', target: '完成', label: '是' }]

// 2. 统一规划：归一化 → antv 布局 → 环/碰撞/位置后处理 → 本地缓存
const { plan, fromCache } = await planDiagram(nodes, edges, { kind: 'layered', name: 'login' })
// plan.nodes → 每个节点的坐标；plan.edges → 边；plan.fingerprint → 缓存指纹

// 3. 绘制 + 渲染
const scene = blankScene('login', plan.sceneWidth, plan.sceneHeight)
drawFlowScene(scene, plan)
const svg = renderSceneSvg(scene)

// 4. 缓存管理
PlanStore.list()      // 列出所有缓存计划
PlanStore.read(fp)    // 读某条
PlanStore.delete(fp)  // 删除
```

导出可编辑的 Excalidraw 文件：

```ts
import { sceneToExcalidraw } from 'ai-paint'
import { writeFileSync } from 'node:fs'

const doc = sceneToExcalidraw(scene)             // Scene → Excalidraw v2 JSON
writeFileSync('login.excalidraw', JSON.stringify(doc, null, 2), 'utf8')
// 在 excalidraw.com 打开即可编辑：拖动节点、改文字、改颜色
```

### 开发调试

```bash
git clone <repo> && cd ai-paint
npm install
npm run build        # 编译 TypeScript → dist/
npm run demo         # 生成演示 SVG
npm test             # 单元测试 + 冒烟测试
npm start            # 以 MCP stdio 服务运行
```

### 项目结构

```
src/
  core/
    ts-svg.ts        # 内置 TS 类型安全 SVG 构建器
    geometry.ts      # 几何算法（PRNG、裁剪、多边形）
    rough.ts         # 手绘抖动核心（闭合形状、圆角、影线）
    shapes.ts        # 21 种形状几何
    connectors.ts    # 连接线系统（5 种类型 + 箭头 + 避障）
    layout.ts        # 布局系统（layered/tree/grid/circular，含环回退）
    plan.ts          # 统一图表管线（契约归一化 → 布局 → 环/碰撞/位置 → 缓存）
    excalidraw.ts    # Excalidraw v2 导出器（Scene → 可编辑 .excalidraw JSON）
    sequence.ts      # 时序图规划
    er.ts            # ER 图规划
    arch.ts          # 架构图规划
    scene.ts         # 场景 / 元素模型
    render.ts        # SVG 渲染器
    fit.ts           # 场景自动居中
  mcp/               # JSON-RPC stdio 协议 + 场景存储 + MCP 服务
  tools/             # MCP 工具定义（含 pipeline-tools：create_diagram / export_scene / plan 缓存）
  demo.ts            # 演示场景
test/                # 单元测试 + 冒烟测试
```

## License

MIT
