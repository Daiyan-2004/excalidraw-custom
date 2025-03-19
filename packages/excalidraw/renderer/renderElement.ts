import {
  getElementAbsoluteCoords,
  getTransformHandlesFromCoords,
  getTransformHandles,
  getCommonBounds,
} from "../element";

import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  NonDeletedExcalidrawElement,
  ExcalidrawFreeDrawElement,
  ExcalidrawImageElement,
  ExcalidrawTextElementWithContainer,
  ExcalidrawFrameLikeElement,
  NonDeletedSceneElementsMap,
  ElementsMap,
} from "../element/types";

import {
  isTextElement,
  isLinearElement,
  isFreeDrawElement,
  isInitializedImageElement,
  isArrowElement,
  hasBoundTextElement,
  isMagicFrameElement,
} from "../element/typeChecks";

import type { RoughCanvas } from "roughjs/bin/canvas";

import type {
  StaticCanvasRenderConfig,
  RenderableElementsMap,
  InteractiveCanvasRenderConfig,
} from "../scene/types";
import { distance, getFontString, isRTL } from "../utils";
import { getCornerRadius, isRightAngle } from "../math";
import rough from "roughjs/bin/rough";
import type {
  AppState,
  StaticCanvasAppState,
  Zoom,
  InteractiveCanvasAppState,
  ElementsPendingErasure,
} from "../types";
import { getDefaultAppState } from "../appState";
import {
  BOUND_TEXT_PADDING,
  ELEMENT_READY_TO_ERASE_OPACITY,
  FRAME_STYLE,
  MIME_TYPES,
  THEME,
} from "../constants";
import type { StrokeOptions } from "perfect-freehand";
import { getStroke } from "perfect-freehand";
import {
  getBoundTextElement,
  getContainerCoords,
  getContainerElement,
  getLineHeightInPx,
  getBoundTextMaxHeight,
  getBoundTextMaxWidth,
  getVerticalOffset,
} from "../element/textElement";
import { LinearElementEditor } from "../element/linearElementEditor";

import { getContainingFrame } from "../frame";
import { ShapeCache } from "../scene/ShapeCache";

// using a stronger invert (100% vs our regular 93%) and saturate
// as a temp hack to make images in dark theme look closer to original
// color scheme (it's still not quite there and the colors look slightly
// desatured, alas...)
export const IMAGE_INVERT_FILTER = "invert(100%) hue-rotate(180deg) saturate(1.25)";

const defaultAppState = getDefaultAppState();

const isPendingImageElement = (element: ExcalidrawElement, renderConfig: StaticCanvasRenderConfig,) => isInitializedImageElement(element) && !renderConfig.imageCache.has(element.fileId);

const shouldResetImageFilter = (element: ExcalidrawElement, renderConfig: StaticCanvasRenderConfig, appState: StaticCanvasAppState,) => {
  return (
    appState.theme === THEME.DARK &&
    isInitializedImageElement(element) &&
    !isPendingImageElement(element, renderConfig) &&
    renderConfig.imageCache.get(element.fileId)?.mimeType !== MIME_TYPES.svg
  );
};

const getCanvasPadding = (element: ExcalidrawElement) => element.type === "freedraw" ? element.strokeWidth * 12 : 20;

export const getRenderOpacity = (element: ExcalidrawElement, containingFrame: ExcalidrawFrameLikeElement | null, elementsPendingErasure: ElementsPendingErasure,) => {
  // multiplying frame opacity with element opacity to combine them
  // (e.g. frame 50% and element 50% opacity should result in 25% opacity)
  let opacity = ((containingFrame?.opacity ?? 100) * element.opacity) / 10000;

  // if pending erasure, multiply again to combine further
  // (so that erasing always results in lower opacity than original)
  if (elementsPendingErasure.has(element.id) || (containingFrame && elementsPendingErasure.has(containingFrame.id))) {
    opacity *= ELEMENT_READY_TO_ERASE_OPACITY / 100;
  }

  return opacity;
};

export interface ExcalidrawElementWithCanvas {
  element: ExcalidrawElement | ExcalidrawTextElement;
  canvas: HTMLCanvasElement;
  theme: AppState["theme"];
  scale: number;
  zoomValue: AppState["zoom"]["value"];
  canvasOffsetX: number;
  canvasOffsetY: number;
  boundTextElementVersion: number | null;
  containingFrameOpacity: number;
}

const cappedElementCanvasSize = (element: NonDeletedExcalidrawElement, elementsMap: ElementsMap, zoom: Zoom,): {width: number; height: number; scale: number;} => {
  // these limits are ballpark, they depend on specific browsers and device.
  // We've chosen lower limits to be safe. We might want to change these limits
  // based on browser/device type, if we get reports of low quality rendering
  // on zoom.
  //
  // ~ safari mobile canvas area limit
  const AREA_LIMIT = 16777216;
  // ~ safari width/height limit based on developer.mozilla.org.
  const WIDTH_HEIGHT_LIMIT = 32767;

  const padding = getCanvasPadding(element);

  const [x1, y1, x2, y2] = getElementAbsoluteCoords(element, elementsMap);
  const elementWidth = isLinearElement(element) || isFreeDrawElement(element) ? distance(x1, x2) : element.width;
  const elementHeight = isLinearElement(element) || isFreeDrawElement(element) ? distance(y1, y2) : element.height;

  let width = elementWidth * window.devicePixelRatio + padding * 2;
  let height = elementHeight * window.devicePixelRatio + padding * 2;

  let scale: number = zoom.value;

  // rescale to ensure width and height is within limits
  if (width * scale > WIDTH_HEIGHT_LIMIT || height * scale > WIDTH_HEIGHT_LIMIT) {
    scale = Math.min(WIDTH_HEIGHT_LIMIT / width, WIDTH_HEIGHT_LIMIT / height);
  }

  // rescale to ensure canvas area is within limits
  if (width * height * scale * scale > AREA_LIMIT) {
    scale = Math.sqrt(AREA_LIMIT / (width * height));
  }

  width = Math.floor(width * scale);
  height = Math.floor(height * scale);

  return { width, height, scale };
};

const generateElementCanvas = (element: NonDeletedExcalidrawElement, elementsMap: RenderableElementsMap, zoom: Zoom, renderConfig: StaticCanvasRenderConfig, appState: StaticCanvasAppState,): ExcalidrawElementWithCanvas => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  const padding = getCanvasPadding(element);

  const { width, height, scale } = cappedElementCanvasSize(element, elementsMap, zoom,);

  canvas.width = width;
  canvas.height = height;

  let canvasOffsetX = 0;
  let canvasOffsetY = 0;

  if (isLinearElement(element) || isFreeDrawElement(element)) {
    const [x1, y1] = getElementAbsoluteCoords(element, elementsMap);

    canvasOffsetX = element.x > x1 ? distance(element.x, x1) * window.devicePixelRatio * scale : 0;
    canvasOffsetY = element.y > y1 ? distance(element.y, y1) * window.devicePixelRatio * scale : 0;

    context.translate(canvasOffsetX, canvasOffsetY);
  }

  context.save();
  context.translate(padding * scale, padding * scale);
  context.scale(
    window.devicePixelRatio * scale,
    window.devicePixelRatio * scale,
  );

  const rc = rough.canvas(canvas);

  // in dark theme, revert the image color filter
  if (shouldResetImageFilter(element, renderConfig, appState)) {
    context.filter = IMAGE_INVERT_FILTER;
  }

  drawElementOnCanvas(element, rc, context, renderConfig, appState);
  context.restore();

  return {
    element,
    canvas,
    theme: appState.theme,
    scale,
    zoomValue: zoom.value,
    canvasOffsetX,
    canvasOffsetY,
    boundTextElementVersion: getBoundTextElement(element, elementsMap)?.version || null,
    containingFrameOpacity: getContainingFrame(element, elementsMap)?.opacity || 100,
  };
};

export const DEFAULT_LINK_SIZE = 14;

const IMAGE_PLACEHOLDER_IMG = document.createElement("img");
IMAGE_PLACEHOLDER_IMG.src = `data:${MIME_TYPES.svg},${encodeURIComponent(
  `<svg aria-hidden="true" focusable="false" data-prefix="fas" data-icon="image" class="svg-inline--fa fa-image fa-w-16" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#888" d="M464 448H48c-26.51 0-48-21.49-48-48V112c0-26.51 21.49-48 48-48h416c26.51 0 48 21.49 48 48v288c0 26.51-21.49 48-48 48zM112 120c-30.928 0-56 25.072-56 56s25.072 56 56 56 56-25.072 56-56-25.072-56-56-56zM64 384h384V272l-87.515-87.515c-4.686-4.686-12.284-4.686-16.971 0L208 320l-55.515-55.515c-4.686-4.686-12.284-4.686-16.971 0L64 336v48z"></path></svg>`,
)}`;

const IMAGE_ERROR_PLACEHOLDER_IMG = document.createElement("img");
IMAGE_ERROR_PLACEHOLDER_IMG.src = `data:${MIME_TYPES.svg},${encodeURIComponent(
  `<svg viewBox="0 0 668 668" xmlns="http://www.w3.org/2000/svg" xml:space="preserve" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2"><path d="M464 448H48c-26.51 0-48-21.49-48-48V112c0-26.51 21.49-48 48-48h416c26.51 0 48 21.49 48 48v288c0 26.51-21.49 48-48 48ZM112 120c-30.928 0-56 25.072-56 56s25.072 56 56 56 56-25.072 56-56-25.072-56-56-56ZM64 384h384V272l-87.515-87.515c-4.686-4.686-12.284-4.686-16.971 0L208 320l-55.515-55.515c-4.686-4.686-12.284-4.686-16.971 0L64 336v48Z" style="fill:#888;fill-rule:nonzero" transform="matrix(.81709 0 0 .81709 124.825 145.825)"/><path d="M256 8C119.034 8 8 119.033 8 256c0 136.967 111.034 248 248 248s248-111.034 248-248S392.967 8 256 8Zm130.108 117.892c65.448 65.448 70 165.481 20.677 235.637L150.47 105.216c70.204-49.356 170.226-44.735 235.638 20.676ZM125.892 386.108c-65.448-65.448-70-165.481-20.677-235.637L361.53 406.784c-70.203 49.356-170.226 44.736-235.638-20.676Z" style="fill:#888;fill-rule:nonzero" transform="matrix(.30366 0 0 .30366 506.822 60.065)"/></svg>`,
)}`;

const drawImagePlaceholder = (element: ExcalidrawImageElement, context: CanvasRenderingContext2D,) => {
  context.fillStyle = "#E7E7E7";
  context.fillRect(0, 0, element.width, element.height);

  const imageMinWidthOrHeight = Math.min(element.width, element.height);

  const size = Math.min(
    imageMinWidthOrHeight,
    Math.min(imageMinWidthOrHeight * 0.4, 100),
  );

  context.drawImage(
    element.status === "error" ? IMAGE_ERROR_PLACEHOLDER_IMG : IMAGE_PLACEHOLDER_IMG,
    element.width / 2 - size / 2,
    element.height / 2 - size / 2,
    size,
    size,
  );
};

const drawClipRect = (x: number, y: number, width: number, height: number, context: CanvasRenderingContext2D) => {
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x + width, y);
  context.lineTo(x + width, y + height);
  context.lineTo(x, y + height);
  context.closePath();
  context.stroke();
  context.fill();
}

const drawElementOnCanvas = (element: NonDeletedExcalidrawElement, rc: RoughCanvas, context: CanvasRenderingContext2D, renderConfig: StaticCanvasRenderConfig, appState: StaticCanvasAppState,) => {
  // console.log(element);
  
  switch (element.type) {
    case "rectangle":{
      if (element.isPathElement) {
        var pathProperties = element.pathObjects;
        var scaleXcoor = element.width/element.constWidth;
        var scaleYcoor = element.height/element.constHeight;
        var myPath = new Path2D(LinearElementEditor.generatesvgPropToPath(pathProperties,scaleXcoor,scaleYcoor));

        context.save();
        context.translate(-(element.constx*scaleXcoor), -(element.consty*scaleYcoor));
        context.lineJoin = "round";
        context.lineCap = "round";
        context.fillStyle = element.backgroundColor;
        context.strokeStyle = element.strokeColor;
        context.lineWidth = element.strokeWidth;
        if (element.strokeColor != "none" && element.strokeColor != "transparent") {
          context.stroke(myPath);
        }
        if (element.backgroundColor != "none") {
          context.fill(myPath);
        }
        context.restore();
      }else{
        context.lineJoin = "round";
        context.lineCap = "round";
        rc.draw(ShapeCache.get(element)!);
      }
      break;
    }

    case "iframe":
    case "embeddable":
    case "diamond":
    case "ellipse": {
      context.lineJoin = "round";
      context.lineCap = "round";
      rc.draw(ShapeCache.get(element)!);
      break;
    }

    case "arrow":
    case "line": {
      context.lineJoin = "round";
      context.lineCap = "round";

      ShapeCache.get(element)!.forEach((shape) => {
        rc.draw(shape);
      });
      break;
    }

    case "freedraw": {
      // Draw directly to canvas
      context.save();
      context.fillStyle = element.strokeColor;

      const path = getFreeDrawPath2D(element) as Path2D;
      const fillShape = ShapeCache.get(element);

      if (fillShape) {
        rc.draw(fillShape);
      }

      context.fillStyle = element.strokeColor;
      context.fill(path);

      context.restore();
      break;
    }

    case "image": {
      const img = isInitializedImageElement(element) ? renderConfig.imageCache.get(element.fileId)?.image : undefined;
      if (img != null && !(img instanceof Promise)) {
        if (element && 'id' in element && 'width' in element && 'height' in element) {
          if (element.roundness && context.roundRect) {
            if ('isCroppedImage' in element && 'cropProperties' in element && element.isCroppedImage) {
              const cropProperties: { x: number; y: number; width: number; height: number } = element.cropProperties as {x: number; y: number; width: number; height: number;};
              context.beginPath();
              context.roundRect(cropProperties.x, cropProperties.y, cropProperties.width, cropProperties.height, getCornerRadius(Math.min(cropProperties.width, cropProperties.height), element),);
              context.clip();

            } else {
              context.beginPath();
              context.roundRect(0, 0, element.width, element.height, getCornerRadius(Math.min(element.width, element.height), element),);
              context.clip();
            }
          } else if('isCroppedImage' in element && 'cropProperties' in element && element.isCroppedImage) {
            const cropProperties: { x: number; y: number; width: number; height: number } = element.cropProperties as {x: number; y: number; width: number; height: number;};
            context.save();
            context.fillStyle = 'transparent';
            context.strokeStyle = 'transparent';
            context.lineJoin = "round";
            context.lineCap = "round";
            context.lineWidth = 0 / appState.zoom.value;
            drawClipRect(cropProperties.x, cropProperties.y, cropProperties.width, cropProperties.height, context);
            context.restore();
            context.clip();
          }
        }

        /* hardcoded for the selection box*/
        context.drawImage(img, 0, 0, element.width, element.height,);
      } else {
        drawImagePlaceholder(element, context);
      }
      
      break;
    }

    default: {
      if (isTextElement(element)) {
        const rtl = isRTL(element.text);
        const shouldTemporarilyAttach = rtl && !context.canvas.isConnected;
        if (shouldTemporarilyAttach) {
          // to correctly render RTL text mixed with LTR, we have to append it
          // to the DOM
          document.body.appendChild(context.canvas);
        }
        context.canvas.setAttribute("dir", rtl ? "rtl" : "ltr");
        context.save();
        context.font = getFontString(element);
        context.fillStyle = element.strokeColor;
        context.textAlign = element.textAlign as CanvasTextAlign;

        // Canvas does not support multiline text by default
        const lines = element.text.replace(/\r\n?/g, "\n").split("\n");

        const horizontalOffset = element.textAlign === "center" ? element.width / 2 : element.textAlign === "right" ? element.width : 0;

        const lineHeightPx = getLineHeightInPx(
          element.fontSize,
          element.lineHeight,
        );

        const verticalOffset = getVerticalOffset(
          element.fontFamily,
          element.fontSize,
          lineHeightPx,
        );

        for (let index = 0; index < lines.length; index++) {
          context.fillText(
            lines[index],
            horizontalOffset,
            index * lineHeightPx + verticalOffset,
          );
        }
        context.restore();
        if (shouldTemporarilyAttach) {
          context.canvas.remove();
        }
      } else {
        throw new Error(`Unimplemented type ${element.type}`);
      }
    }
  }
};

export const elementWithCanvasCache = new WeakMap<ExcalidrawElement,ExcalidrawElementWithCanvas>();

const generateElementWithCanvas = (element: NonDeletedExcalidrawElement, elementsMap: RenderableElementsMap, renderConfig: StaticCanvasRenderConfig, appState: StaticCanvasAppState,) => {
  const zoom: Zoom = renderConfig ? appState.zoom : defaultAppState.zoom;
  const prevElementWithCanvas = elementWithCanvasCache.get(element);
  const shouldRegenerateBecauseZoom = prevElementWithCanvas && prevElementWithCanvas.zoomValue !== zoom.value && !appState?.shouldCacheIgnoreZoom;
  const boundTextElementVersion = getBoundTextElement(element, elementsMap)?.version || null;
  const containingFrameOpacity = getContainingFrame(element, elementsMap)?.opacity || 100;

  function akhonRenderKoraUchit(element: any) {
    if ('akhonRenderKoraUchit' in element) {
      return element.akhonRenderKoraUchit ? true : false;
    }
  }

  if (akhonRenderKoraUchit(element) || !prevElementWithCanvas || shouldRegenerateBecauseZoom || prevElementWithCanvas.theme !== appState.theme || prevElementWithCanvas.boundTextElementVersion !== boundTextElementVersion || prevElementWithCanvas.containingFrameOpacity !== containingFrameOpacity ) {
    const elementWithCanvas = generateElementCanvas(element, elementsMap, zoom, renderConfig, appState,);
    elementWithCanvasCache.set(element, elementWithCanvas);
    return elementWithCanvas;
  }

  return prevElementWithCanvas;
};

const drawElementFromCanvas = (elementWithCanvas: ExcalidrawElementWithCanvas, context: CanvasRenderingContext2D, renderConfig: StaticCanvasRenderConfig, appState: StaticCanvasAppState, allElementsMap: NonDeletedSceneElementsMap,) => {
  const element = elementWithCanvas.element;
  const padding = getCanvasPadding(element);
  const zoom = elementWithCanvas.scale;
  let [x1, y1, x2, y2] = getElementAbsoluteCoords(element, allElementsMap);

  // Free draw elements will otherwise "shuffle" as the min x and y change
  if (isFreeDrawElement(element)) {
    x1 = Math.floor(x1);
    x2 = Math.ceil(x2);
    y1 = Math.floor(y1);
    y2 = Math.ceil(y2);
  }

  const cx = ((x1 + x2) / 2 + appState.scrollX) * window.devicePixelRatio;
  const cy = ((y1 + y2) / 2 + appState.scrollY) * window.devicePixelRatio;

  context.save();
  context.scale(1 / window.devicePixelRatio, 1 / window.devicePixelRatio);

  const boundTextElement = getBoundTextElement(element, allElementsMap);

  if (isArrowElement(element) && boundTextElement) {
    const tempCanvas = document.createElement("canvas");
    const tempCanvasContext = tempCanvas.getContext("2d")!;

    // Take max dimensions of arrow canvas so that when canvas is rotated
    // the arrow doesn't get clipped
    const maxDim = Math.max(distance(x1, x2), distance(y1, y2));
    tempCanvas.width = maxDim * window.devicePixelRatio * zoom + padding * elementWithCanvas.scale * 10;
    tempCanvas.height = maxDim * window.devicePixelRatio * zoom + padding * elementWithCanvas.scale * 10;
    const offsetX = (tempCanvas.width - elementWithCanvas.canvas!.width) / 2;
    const offsetY = (tempCanvas.height - elementWithCanvas.canvas!.height) / 2;

    tempCanvasContext.translate(tempCanvas.width / 2, tempCanvas.height / 2);
    tempCanvasContext.rotate(element.angle);

    tempCanvasContext.drawImage(
      elementWithCanvas.canvas!,
      -elementWithCanvas.canvas.width / 2,
      -elementWithCanvas.canvas.height / 2,
      elementWithCanvas.canvas.width,
      elementWithCanvas.canvas.height,
    );

    const [, , , , boundTextCx, boundTextCy] = getElementAbsoluteCoords(boundTextElement, allElementsMap,);

    tempCanvasContext.rotate(-element.angle);

    // Shift the canvas to the center of the bound text element
    const shiftX = tempCanvas.width / 2 - (boundTextCx - x1) * window.devicePixelRatio * zoom - offsetX - padding * zoom;
    const shiftY = tempCanvas.height / 2 - (boundTextCy - y1) * window.devicePixelRatio * zoom - offsetY - padding * zoom;

    tempCanvasContext.translate(-shiftX, -shiftY);
    // Clear the bound text area
    tempCanvasContext.clearRect(
      -(boundTextElement.width / 2 + BOUND_TEXT_PADDING) * window.devicePixelRatio * zoom,
      -(boundTextElement.height / 2 + BOUND_TEXT_PADDING) * window.devicePixelRatio * zoom,
      (boundTextElement.width + BOUND_TEXT_PADDING * 2) * window.devicePixelRatio * zoom,
      (boundTextElement.height + BOUND_TEXT_PADDING * 2) * window.devicePixelRatio * zoom,
    );

    context.translate(cx, cy);
    context.drawImage(
      tempCanvas,
      (-(x2 - x1) / 2) * window.devicePixelRatio - offsetX / zoom - padding,
      (-(y2 - y1) / 2) * window.devicePixelRatio - offsetY / zoom - padding,
      tempCanvas.width / zoom,
      tempCanvas.height / zoom,
    );
  } else {
    // we translate context to element center so that rotation and scale
    // originates from the element center
    context.translate(cx, cy);
    context.rotate(element.angle);

    if ("scale" in elementWithCanvas.element && !isPendingImageElement(element, renderConfig)) {
      context.scale(
        elementWithCanvas.element.scale[0],
        elementWithCanvas.element.scale[1],
      );
    }

    // revert afterwards we don't have account for it during drawing
    context.translate(-cx, -cy);

    context.drawImage(
      elementWithCanvas.canvas!,
      (x1 + appState.scrollX) * window.devicePixelRatio - (padding * elementWithCanvas.scale) / elementWithCanvas.scale,
      (y1 + appState.scrollY) * window.devicePixelRatio - (padding * elementWithCanvas.scale) / elementWithCanvas.scale,
      elementWithCanvas.canvas!.width / elementWithCanvas.scale,
      elementWithCanvas.canvas!.height / elementWithCanvas.scale,
    );

    if (import.meta.env.VITE_APP_DEBUG_ENABLE_TEXT_CONTAINER_BOUNDING_BOX === "true" && hasBoundTextElement(element)) {
      const textElement = getBoundTextElement(element, allElementsMap,) as ExcalidrawTextElementWithContainer;
      const coords = getContainerCoords(element);
      context.strokeStyle = "#c92a2a";
      context.lineWidth = 3;
      context.strokeRect(
        (coords.x + appState.scrollX) * window.devicePixelRatio,
        (coords.y + appState.scrollY) * window.devicePixelRatio,
        getBoundTextMaxWidth(element, textElement) * window.devicePixelRatio,
        getBoundTextMaxHeight(element, textElement) * window.devicePixelRatio,
      );
    }
  }
  context.restore();

  // Clear the nested element we appended to the DOM
};

export const renderSelectionElement = (element: NonDeletedExcalidrawElement, context: CanvasRenderingContext2D, appState: InteractiveCanvasAppState, selectionColor: InteractiveCanvasRenderConfig["selectionColor"],) => {
  context.save();
  context.translate(element.x + appState.scrollX, element.y + appState.scrollY);
  context.fillStyle = "rgba(0, 0, 200, 0.04)";

  // render from 0.5px offset  to get 1px wide line
  // https://stackoverflow.com/questions/7530593/html5-canvas-and-line-width/7531540#7531540
  // TODO can be be improved by offseting to the negative when user selects
  // from right to left
  const offset = 0.5 / appState.zoom.value;

  context.fillRect(offset, offset, element.width, element.height);
  context.lineWidth = 1 / appState.zoom.value;
  context.strokeStyle = selectionColor;
  context.strokeRect(offset, offset, element.width, element.height);

  context.restore();
};

const unconditionalRenderElement = (element: NonDeletedExcalidrawElement, elementsMap: RenderableElementsMap, allElementsMap: NonDeletedSceneElementsMap, rc: RoughCanvas, context: CanvasRenderingContext2D, renderConfig: StaticCanvasRenderConfig, appState: StaticCanvasAppState,) => {
  context.globalAlpha = getRenderOpacity(element, getContainingFrame(element, elementsMap), renderConfig.elementsPendingErasure,);

  // console.log({renderConfig: renderConfig.isExporting});
  
  switch (element.type) {
    case "magicframe":
    case "frame": {
      if (appState.frameRendering.enabled && appState.frameRendering.outline) {

        context.save();
        context.translate(element.x + appState.scrollX, element.y + appState.scrollY,);
        context.fillStyle = "rgba(0, 0, 200, 0.04)";
        context.lineWidth = FRAME_STYLE.strokeWidth / appState.zoom.value;
        context.strokeStyle = FRAME_STYLE.strokeColor;

        // TODO change later to only affect AI frames
        if (isMagicFrameElement(element)) {
          context.strokeStyle = appState.theme === THEME.LIGHT ? "#7affd7" : "#1d8264";
        }

        if (FRAME_STYLE.radius && context.roundRect) {
          context.beginPath();
          context.roundRect(0, 0, element.width, element.height, FRAME_STYLE.radius / appState.zoom.value,);
          context.stroke();
          context.closePath();
        } else {
          context.strokeRect(0, 0, element.width, element.height);
        }

        context.restore();
      }
      
      break;
    }

    case "freedraw": {
      // TODO investigate if we can do this in situ. Right now we need to call
      // beforehand because math helpers (such as getElementAbsoluteCoords)
      // rely on existing shapes
      ShapeCache.generateElementShape(element, null);

      const elementWithCanvas = generateElementWithCanvas(element, elementsMap, renderConfig, appState,);
      drawElementFromCanvas(elementWithCanvas, context, renderConfig, appState, allElementsMap,);

      break;
    }

    case "rectangle":
    case "diamond":
    case "ellipse":
    case "line":
    case "arrow":
    case "image":
    case "text":
    case "iframe":
    case "embeddable": {
      // TODO investigate if we can do this in situ. Right now we need to call
      // beforehand because math helpers (such as getElementAbsoluteCoords)
      // rely on existing shapes
      ShapeCache.generateElementShape(element, renderConfig);
      const elementWithCanvas = generateElementWithCanvas(element, elementsMap, renderConfig, appState,);

      const currentImageSmoothingStatus = context.imageSmoothingEnabled;
      // do not disable smoothing during zoom as blurry shapes look better
      // on low resolution (while still zooming in) than sharp ones
      // angle is 0 -> always disable smoothing
      // or check if angle is a right angle in which case we can still
      // disable smoothing without adversely affecting the result

      if (!appState?.shouldCacheIgnoreZoom && (!element.angle || isRightAngle(element.angle))) {
        // Disabling smoothing makes output much sharper, especially for
        // text. Unless for non-right angles, where the aliasing is really
        // terrible on Chromium.
        //
        // Note that `context.imageSmoothingQuality="high"` has almost
        // zero effect.
        //
        context.imageSmoothingEnabled = false;
      }

      drawElementFromCanvas(elementWithCanvas, context, renderConfig, appState, allElementsMap,);

      // reset
      context.imageSmoothingEnabled = currentImageSmoothingStatus;
      break;
    }

    default: {
      // @ts-ignore
      throw new Error(`Unimplemented type ${element.type}`);
    }
  }

  context.globalAlpha = 1;
};

const maskedElementsMap = new Map() as any;
export const renderElement = (element: NonDeletedExcalidrawElement, elementsMap: RenderableElementsMap, allElementsMap: NonDeletedSceneElementsMap, rc: RoughCanvas, context: CanvasRenderingContext2D, renderConfig: StaticCanvasRenderConfig, appState: StaticCanvasAppState,) => {
  // console.log({width: appState.width, height: appState.height});
  // console.log(element);
  // console.log({maskedElementsMap: maskedElementsMap});
  

  const myelement = element as any;
  if (myelement.isMakeClippingMask && myelement.clippingMaskId && myelement.cmGroupLength && myelement.cmeIndex) {

    if (!maskedElementsMap.has(myelement.clippingMaskId)) {
      maskedElementsMap.set(myelement.clippingMaskId, []);
    }

    maskedElementsMap.get(myelement.clippingMaskId).push(myelement);

    if (maskedElementsMap.get(myelement.clippingMaskId).length && maskedElementsMap.get(myelement.clippingMaskId).length === myelement.cmGroupLength) {
      
      let maskedElements = maskedElementsMap.get(myelement.clippingMaskId);

      // Create a temporary canvas to handle compositing
      const tempCanvas = document.createElement('canvas');
      const tempCtx = tempCanvas.getContext('2d')!;
      const winw = Math.floor(window.innerWidth/appState.zoom.value);
      const winh = Math.floor(window.innerHeight/appState.zoom.value);
      const dpr = window.devicePixelRatio || 1;

      // console.log({dpr:dpr});
      
      tempCanvas.width = winw * dpr;
      tempCanvas.height = winh * dpr;
      tempCanvas.style.width = `${winw}px`;
      tempCanvas.style.height = `${winh}px`;
      tempCtx.scale(dpr, dpr);
  
      maskedElements = maskedElements.sort((a: any, b: any) => {return a.index.localeCompare(b.index);});

      maskedElements.forEach((maskedElement: any, index: number) => {
        if (index === myelement.cmGroupLength-1) { tempCtx.globalCompositeOperation = "destination-in"; }
        unconditionalRenderElement(maskedElement, elementsMap, allElementsMap, rc, tempCtx, renderConfig, appState);
      });

      if (document.getElementById(myelement.clippingMaskId)) {
        document.getElementById(myelement.clippingMaskId)?.remove();
      }
      if (!document.getElementById(myelement.clippingMaskId)) {
        const maskedImg = document.createElement('img');
        maskedImg.src = tempCanvas.toDataURL();
        maskedImg.id = myelement.clippingMaskId;
        maskedImg.style.display = "none";
        document.body.appendChild(maskedImg);
      }
      
      // console.log(maskedElements);

      context.drawImage(tempCanvas, 0, 0, winw, winh);
      
      maskedElementsMap.delete(myelement.clippingMaskId);
    }
  } else {
    unconditionalRenderElement(element, elementsMap, allElementsMap, rc, context, renderConfig, appState);
  }
};

export const pathsCache = new WeakMap<ExcalidrawFreeDrawElement, Path2D>([]);

export function generateFreeDrawShape(element: ExcalidrawFreeDrawElement) {
  const svgPathData = getFreeDrawSvgPath(element);
  const path = new Path2D(svgPathData);
  pathsCache.set(element, path);
  return path;
}

export function getFreeDrawPath2D(element: ExcalidrawFreeDrawElement) {
  return pathsCache.get(element);
}

export function getFreeDrawSvgPath(element: ExcalidrawFreeDrawElement) {
  // If input points are empty (should they ever be?) return a dot
  const inputPoints = element.simulatePressure ? element.points : element.points.length ? element.points.map(([x, y], i) => [x, y, element.pressures[i]]) : [[0, 0, 0.5]];

  // Consider changing the options for simulated pressure vs real pressure
  const options: StrokeOptions = {
    simulatePressure: element.simulatePressure,
    size: element.strokeWidth * 4.25,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    easing: (t) => Math.sin((t * Math.PI) / 2), // https://easings.net/#easeOutSine
    last: !!element.lastCommittedPoint, // LastCommittedPoint is added on pointerup
  };

  return getSvgPathFromStroke(getStroke(inputPoints as number[][], options));
}

function med(A: number[], B: number[]) {
  return [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
}

// Trim SVG path data so number are each two decimal points. This
// improves SVG exports, and prevents rendering errors on points
// with long decimals.
const TO_FIXED_PRECISION = /(\s?[A-Z]?,?-?[0-9]*\.[0-9]{0,2})(([0-9]|e|-)*)/g;

function getSvgPathFromStroke(points: number[][]): string {
  if (!points.length) { return ""; }

  const max = points.length - 1;

  return points.reduce((acc, point, i, arr) => {
    if (i === max) {
      acc.push(point, med(point, arr[0]), "L", arr[0], "Z");
    } else {
      acc.push(point, med(point, arr[i + 1]));
    }
    return acc;
  },
  ["M", points[0], "Q"],
  ).join(" ").replace(TO_FIXED_PRECISION, "$1");
}
