/**
 * ai-paint 库入口（无 DOM，Node / 浏览器均可）。
 *
 * 用法：
 *   import { blankScene, createElement, renderSceneSvg, computeLayout, routeEdge } from 'ai-paint'
 *
 * 说明：MCP 服务 CLI 入口在 index.ts / cli.ts（`ai-paint` 命令）。
 */

// 场景 / 元素模型
export { createElement, blankScene } from './core/scene.js'
export type {
  Scene,
  SceneElement,
  RectangleElement,
  EllipseElement,
  DiamondElement,
  ShapeElement,
  LineElement,
  ArrowElement,
  EdgeElement,
  TextElement,
  DrawElement,
  ImageElement,
  FrameElement,
} from './core/scene.js'

// SVG 渲染
export { renderSceneSvg } from './core/render.js'
export type { RenderOptions } from './core/render.js'

// Excalidraw 导出
export { sceneToExcalidraw } from './core/excalidraw.js'
export type {
  ExcalidrawDocument,
  ExcalidrawElement,
  ExcalidrawBinding,
} from './core/excalidraw.js'

// 布局系统
export { computeLayout } from './core/layout.js'
export type { LayoutNodeSpec, LayoutEdgeSpec, LayoutKind, LayoutOptions, LayoutResult } from './core/layout.js'

// 连接线系统
export {
  routeEdge,
  pickSide,
  pickSideForShape,
  anchorPoint,
  contactPoint,
  sideCenters,
  edgeMidpoint,
  edgeLabelAnchor,
  needsSeparation,
  EDGE_SPACING,
  ARROW_GAP,
} from './core/connectors.js'
export type {
  ConnectorNode,
  Connector,
  RoutedEdge,
  EdgeType,
  ArrowHead,
  Side,
} from './core/connectors.js'
export { routeEdgeBundle, edgesOverlap } from './core/edge-bundle.js'

// 图表规划器
export { planSequenceDiagram } from './core/sequence.js'
export type { SeqParticipant, SeqMessage, SeqOptions } from './core/sequence.js'
export { planErDiagram } from './core/er.js'
export type { ErEntity, ErRelation, ErOptions } from './core/er.js'
export { planArchitectureDiagram } from './core/arch.js'
export type { ArchLayer, ArchLink, ArchOptions } from './core/arch.js'

// 统一图表管线（perf.md 流程）
export { planDiagram, normalizePlan, normalizeNodes, normalizeEdges, resolveCollisions, normalizeOrigin, PlanStore } from './core/plan.js'
export type {
  PlanNode,
  PlanEdge,
  FinalPlan,
  NormalizedNode,
  NormalizedEdge,
  PlanOptions,
  PlanResult,
} from './core/plan.js'

// 绘制层
export { drawFlowScene, drawSequenceScene, drawErScene, drawArchScene, drawPlanScene } from './tools/draw.js'
export type { DrawStyle, FlowSceneResult } from './tools/draw.js'
export { exportSceneFiles } from './tools/pipeline-tools.js'
export type { ExportResult, ExportFormat } from './tools/pipeline-tools.js'

// 场景居中
export { fitSceneContent, centerScene, contentBounds } from './core/fit.js'
export type { FitOptions } from './core/fit.js'

// 形状几何
export { shapeGeometry, SHAPE_TYPES } from './core/shapes.js'
export type { ShapeType } from './core/shapes.js'

// MCP 服务
export { McpServer } from './mcp/server.js'
export { SceneStore } from './mcp/store.js'
export { ToolRegistry } from './tools/registry.js'
