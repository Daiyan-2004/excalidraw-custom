import type { RoughCanvas } from "roughjs/bin/canvas";
import type { Drawable } from "roughjs/bin/core";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  NonDeletedElementsMap,
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
} from "../element/types";
import type {
  AppClassProperties,
  AppState,
  EmbedsValidationStatus,
  ElementsPendingErasure,
  InteractiveCanvasAppState,
  StaticCanvasAppState,
  SocketId,
  UserIdleState,
  Device,
} from "../types";
import type { MakeBrand } from "../utility-types";

export type RenderableElementsMap = NonDeletedElementsMap &
  MakeBrand<"RenderableElementsMap">;

export type StaticCanvasRenderConfig = {
  canvasBackgroundColor: AppState["viewBackgroundColor"];
  // extra options passed to the renderer
  // ---------------------------------------------------------------------------
  imageCache: AppClassProperties["imageCache"];
  renderGrid: boolean;
  /** when exporting the behavior is slightly different (e.g. we can't use
   CSS filters), and we disable render optimizations for best output */
  isExporting: boolean;
  embedsValidationStatus: EmbedsValidationStatus;
  elementsPendingErasure: ElementsPendingErasure;
};

export type SVGRenderConfig = {
  offsetX: number;
  offsetY: number;
  isExporting: boolean;
  exportWithDarkMode: boolean;
  renderEmbeddables: boolean;
  frameRendering: AppState["frameRendering"];
  canvasBackgroundColor: AppState["viewBackgroundColor"];
  embedsValidationStatus: EmbedsValidationStatus;
};

export type InteractiveCanvasRenderConfig = {
  // collab-related state
  // ---------------------------------------------------------------------------
  remoteSelectedElementIds: Map<ExcalidrawElement["id"], SocketId[]>;
  remotePointerViewportCoords: Map<SocketId, { x: number; y: number }>;
  remotePointerUserStates: Map<SocketId, UserIdleState>;
  remotePointerUsernames: Map<SocketId, string>;
  remotePointerButton: Map<SocketId, string | undefined>;
  selectionColor: string;
  // extra options passed to the renderer
  // ---------------------------------------------------------------------------
  renderScrollbars?: boolean;
};

export type RenderInteractiveSceneCallback = {
  atLeastOneVisibleElement: boolean;
  elementsMap: RenderableElementsMap;
  scrollBars?: ScrollBars;
};

export type StaticSceneRenderConfig = {
  canvas: HTMLCanvasElement;
  rc: RoughCanvas;
  elementsMap: RenderableElementsMap;
  allElementsMap: NonDeletedSceneElementsMap;
  visibleElements: readonly NonDeletedExcalidrawElement[];
  scale: number;
  appState: StaticCanvasAppState;
  renderConfig: StaticCanvasRenderConfig;
};

export type InteractiveSceneRenderConfig = {
  canvas: HTMLCanvasElement | null;
  elementsMap: RenderableElementsMap;
  visibleElements: readonly NonDeletedExcalidrawElement[];
  selectedElements: readonly NonDeletedExcalidrawElement[];
  allElementsMap: NonDeletedSceneElementsMap;
  scale: number;
  appState: InteractiveCanvasAppState;
  renderConfig: InteractiveCanvasRenderConfig;
  staticRenderConfig: StaticCanvasRenderConfig,

  device: Device;
  callback: (data: RenderInteractiveSceneCallback) => void;
};

export type SceneScroll = {
  scrollX: number;
  scrollY: number;
};

export interface Scene {
  elements: ExcalidrawTextElement[];
}

export type ExportType =
  | "png"
  | "clipboard"
  | "clipboard-svg"
  | "backend"
  | "svg";

export type ScrollBars = {
  horizontal: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  vertical: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
};

export type ElementShape = Drawable | Drawable[] | null;

export type ElementShapes = {
  rectangle: Drawable;
  ellipse: Drawable;
  diamond: Drawable;
  iframe: Drawable;
  embeddable: Drawable;
  freedraw: Drawable | null;
  arrow: Drawable[];
  line: Drawable[];
  text: null;
  image: null;
  frame: null;
  magicframe: null;
};
