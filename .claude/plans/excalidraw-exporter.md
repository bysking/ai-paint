# 生成可编辑的 .excalidraw 文件

## 目标
在生成 PNG/SVG 的同时，额外产出 **Excalidraw v2 格式的可编辑 `.excalidraw` 文件**（excalidraw.com / Excalidraw 桌面端 / obsidian 等可直接打开编辑）。

## 方案：手写导出器（零新依赖）
用户已确认采用手写方案。`.excalidraw` 文件本质是 Excalidraw v2 JSON：
```json
{ "type":"excalidraw", "version":2, "source":"...", "elements":[...], "appState":{...}, "files":{} }
```
手写此 JSON 即可，无需引入 `@excalidraw/excalidraw` 或 `agent-excalidraw`（后者 285MB/307 包/Proprietary 许可，对本需求是过度工程）。

## 新增文件：src/core/excalidraw.ts
`sceneToExcalidraw(scene)` → 把 `Scene` 转成 Excalidraw v2 JSON。

### 元素映射
| Scene 元素 | Excalidraw 元素 | 备注 |
|---|---|---|
| `shape` / `rectangle` / `ellipse` / `diamond` | 同名元素 | `type` 直接用 shapes 的 shape 名（Excalidraw 支持 rectangle/ellipse/diamond/line/arrow/freedraw/text/image/frame）；`fillStyle` 用 hachure/cross-hatch/solid/none 映射；`roundness` 圆角矩形设 `{type:3}`；`roughness`、`seed`（来自 id） |
| `text` | `text` 元素 | `fontFamily:1`（Virgil）、`textAlign`、`fontSize`、`baseline`、`containerId` 若在 shape 内则绑定 |
| `line` / `draw` | `line` / `freedraw` | `points` 相对坐标（x/y/width/height = 包围盒） |
| `arrow` | `arrow` | 同上 + `endArrowhead:'arrow'` |
| `edge` | `arrow` | 用 `routeEdgeBundle` 预路由（与 SVG 渲染一致），`points` = 路径点相对坐标；`endBinding` 绑定目标节点（`type:'rectangle', elementId, focus, gap`），编辑时箭头跟随节点 |
| `image` | `image` 元素 + `files` 字典 | dataURL → `files[fileId].dataURL`；元素 `fileId` 引用；`scale:[1,1]`, `crop:null` |
| `frame` | `frame` 元素 | `name`, `children`（Excalidraw v2 frame 有 children 数组） |

### 公共字段（每个元素）
`id, type, x, y, width, height, angle, strokeColor, backgroundColor, fillStyle, strokeWidth, strokeStyle, roughness, opacity, groupIds:[], frameId:null, roundness, seed, version:1, versionNonce, isDeleted:false, boundElements:[], updated, link:null, locked:false`

### 输出结构
```ts
{
  type: 'excalidraw',
  version: 2,
  source: 'https://excalidraw.com',
  elements: ExcalidrawElement[],
  appState: { gridSize: null, viewBackgroundColor: scene.background_color },
  files: Record<string, { mimeType, dataURL, createdAt, lastRetrievedAt }>
}
```

## 工具接口变更
### 1. `export_scene` 新增参数
- `formats`: 可选 `["svg","png","excalidraw"]`，默认 `["svg","png"]`
- 传 `["excalidraw"]` 或 `["svg","png","excalidraw"]` 时额外写 `<name>.excalidraw`
- 返回 `{ ...现存字段, excalidrawPath?, excalidrawBytes? }`

### 2. `create_diagram` / `create_flow_diagram` 的 `export_svg_png`
- 保持默认行为（svg+png），但**新增 `export_excalidraw: true` 参数**，默认 `false`
- 为 `true` 时在导出目录同时写 `<scene>.excalidraw`

### 3. 新增库 API
- `sceneToExcalidraw(scene)` 从 `lib.ts` 导出
- `exportSceneFiles` 支持 `formats` 选项

## 测试
- `test/excalidraw.test.mjs`：
  - 流程图的 shape/text/edge → 验证 elements 数组、arrow 有 endBinding、points 相对坐标正确
  - image → 验证 files 字典 + fileId 引用
  - frame → 验证 frame 元素 + children
  - 完整 scene → `JSON.stringify` 输出可解析、含 `type:'excalidraw'`
  - excalidraw.com 可打开性：结构字段齐全（id/type/x/y/seed/version 等）

## 验证
- `npm run build` + `npm test` + `npm run smoke`
- 端到端：`create_diagram` 生成一张图 → 导出 `.excalidraw` → 检查 JSON 有效性 + 元素数
