import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { boardPointToWorld, getBoardPointFromClient } from "../graph/coordinates";
import { createNodeMap, getNodesBounds, getTopNodeAtPoint } from "../graph/geometry";
import type { RenderMode, ViewportType } from "../types/common";
import type { EdgeType } from "../types/edge";
import type { NodeDragStartHandler, NodeType } from "../types/node";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

const INITIAL_NODES: NodeType[] = [
  { id: "1", width: 100, height: 50, position: { x: 0, y: 0 } },
  { id: "2", width: 100, height: 50, position: { x: 120, y: 0 } },
];

const INITIAL_EDGES: EdgeType[] = [{ id: "1-2", source: "1", target: "2" }];

type PanState = {
  isPanning: boolean;
  pointerId: number;
  startMouse: { x: number; y: number };
  startPan: { panX: number; panY: number };
};

type DragState = {
  isDragging: boolean;
  pointerId: number;
  nodeId: string;
  offsetX: number;
  offsetY: number;
};

export const useGraphController = () => {
  const [nodes, setNodes] = useState<NodeType[]>(INITIAL_NODES);
  const [edges] = useState<EdgeType[]>(INITIAL_EDGES);
  const [viewport, setViewport] = useState<ViewportType>({ panX: 0, panY: 0, zoom: 1 });
  const [renderMode, setRenderMode] = useState<RenderMode>("dom");

  const boardRef = useRef<HTMLDivElement>(null);
  const hasInitialCenterRef = useRef(false);
  const viewportRef = useRef(viewport);
  const nodesRef = useRef(nodes);

  const panRef = useRef<PanState>({
    isPanning: false,
    pointerId: -1,
    startMouse: { x: 0, y: 0 },
    startPan: { panX: 0, panY: 0 },
  });

  const dragRef = useRef<DragState>({
    isDragging: false,
    pointerId: -1,
    nodeId: "",
    offsetX: 0,
    offsetY: 0,
  });

  const webGpuAvailable = typeof navigator !== "undefined" && "gpu" in navigator;

  const nodesMap = useMemo(() => createNodeMap(nodes), [nodes]);
  const nodeById = useCallback((nodeId: string) => nodesMap.get(nodeId), [nodesMap]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const centerSceneOnStart = useCallback(() => {
    if (hasInitialCenterRef.current) return;

    const boardEl = boardRef.current;
    if (!boardEl) return;

    const rect = boardEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const bounds = getNodesBounds(nodesRef.current);
    if (!bounds) return;

    setViewport((current) => ({
      ...current,
      panX: rect.width / 2 - bounds.centerX * current.zoom,
      panY: rect.height / 2 - bounds.centerY * current.zoom,
    }));

    hasInitialCenterRef.current = true;
  }, []);

  useEffect(() => {
    centerSceneOnStart();
  }, [centerSceneOnStart, nodes]);

  useEffect(() => {
    const boardEl = boardRef.current;
    if (!boardEl || hasInitialCenterRef.current) return;

    const observer = new ResizeObserver(() => {
      centerSceneOnStart();
    });

    observer.observe(boardEl);

    return () => {
      observer.disconnect();
    };
  }, [centerSceneOnStart]);

  const getWorldFromClient = useCallback((clientX: number, clientY: number, currentViewport: ViewportType) => {
    const boardEl = boardRef.current;
    if (!boardEl) return null;

    const rect = boardEl.getBoundingClientRect();
    const boardPoint = getBoardPointFromClient(clientX, clientY, rect);
    return boardPointToWorld(boardPoint, currentViewport);
  }, []);

  const onNodeDragStart: NodeDragStartHandler = useCallback(
    (offset, nodeId) => {
      const boardEl = boardRef.current;
      if (!boardEl) return;

      const dragOffsetX = offset[1] / viewportRef.current.zoom;
      const dragOffsetY = offset[0] / viewportRef.current.zoom;

      const changeNodePosition = (event: MouseEvent) => {
        const world = getWorldFromClient(event.clientX, event.clientY, viewportRef.current);
        if (!world) return;

        setNodes((prev) =>
          prev.map((node) =>
            node.id === nodeId ? { ...node, position: { x: world.x - dragOffsetX, y: world.y - dragOffsetY } } : node,
          ),
        );
      };

      const dragEnd = () => {
        boardEl.removeEventListener("mousemove", changeNodePosition);
        boardEl.removeEventListener("mouseup", dragEnd);
      };

      boardEl.addEventListener("mousemove", changeNodePosition);
      boardEl.addEventListener("mouseup", dragEnd);
    },
    [getWorldFromClient],
  );

  const setRenderModeSafe = useCallback(
    (mode: RenderMode) => {
      if (mode === "webgpu" && !webGpuAvailable) {
        setRenderMode("dom");
        return;
      }
      setRenderMode(mode);
    },
    [webGpuAvailable],
  );

  useEffect(() => {
    const boardEl = boardRef.current;
    if (!boardEl) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();

      const rect = boardEl.getBoundingClientRect();
      const boardPoint = getBoardPointFromClient(event.clientX, event.clientY, rect);

      setViewport((prev) => {
        const worldX = (boardPoint.x - prev.panX) / prev.zoom;
        const worldY = (boardPoint.y - prev.panY) / prev.zoom;

        const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev.zoom * Math.exp(-event.deltaY * 0.015)));

        return {
          zoom: newZoom,
          panX: boardPoint.x - worldX * newZoom,
          panY: boardPoint.y - worldY * newZoom,
        };
      });
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-role="toolbar"]')) return;
      if (renderMode === "dom" && target.closest('[data-role="node"]')) return;

      const currentViewport = viewportRef.current;

      if (renderMode === "webgpu") {
        const world = getWorldFromClient(event.clientX, event.clientY, currentViewport);
        if (!world) return;

        const hitNode = getTopNodeAtPoint(nodesRef.current, world.x, world.y);
        if (hitNode) {
          dragRef.current = {
            isDragging: true,
            pointerId: event.pointerId,
            nodeId: hitNode.id,
            offsetX: world.x - hitNode.position.x,
            offsetY: world.y - hitNode.position.y,
          };
          boardEl.setPointerCapture(event.pointerId);
          return;
        }
      }

      panRef.current = {
        isPanning: true,
        pointerId: event.pointerId,
        startMouse: { x: event.clientX, y: event.clientY },
        startPan: {
          panX: currentViewport.panX,
          panY: currentViewport.panY,
        },
      };
      boardEl.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag.isDragging && event.pointerId === drag.pointerId) {
        const world = getWorldFromClient(event.clientX, event.clientY, viewportRef.current);
        if (!world) return;

        setNodes((prev) =>
          prev.map((node) =>
            node.id === drag.nodeId
              ? {
                  ...node,
                  position: { x: world.x - drag.offsetX, y: world.y - drag.offsetY },
                }
              : node,
          ),
        );
        return;
      }

      const pan = panRef.current;
      if (!pan.isPanning || event.pointerId !== pan.pointerId) return;

      const dx = event.clientX - pan.startMouse.x;
      const dy = event.clientY - pan.startMouse.y;

      setViewport((current) => ({
        ...current,
        panX: pan.startPan.panX + dx,
        panY: pan.startPan.panY + dy,
      }));
    };

    const stopInteractions = (event: PointerEvent) => {
      const drag = dragRef.current;
      const pan = panRef.current;
      let handled = false;

      if (event.pointerId === drag.pointerId) {
        dragRef.current = {
          isDragging: false,
          pointerId: -1,
          nodeId: "",
          offsetX: 0,
          offsetY: 0,
        };
        handled = true;
      }

      if (event.pointerId === pan.pointerId) {
        panRef.current = {
          ...panRef.current,
          isPanning: false,
          pointerId: -1,
        };
        handled = true;
      }

      if (handled && boardEl.hasPointerCapture(event.pointerId)) {
        boardEl.releasePointerCapture(event.pointerId);
      }
    };

    boardEl.addEventListener("wheel", onWheel, { passive: false });
    boardEl.addEventListener("pointerdown", onPointerDown);
    boardEl.addEventListener("pointermove", onPointerMove);
    boardEl.addEventListener("pointerup", stopInteractions);
    boardEl.addEventListener("pointercancel", stopInteractions);

    return () => {
      boardEl.removeEventListener("wheel", onWheel);
      boardEl.removeEventListener("pointerdown", onPointerDown);
      boardEl.removeEventListener("pointermove", onPointerMove);
      boardEl.removeEventListener("pointerup", stopInteractions);
      boardEl.removeEventListener("pointercancel", stopInteractions);
    };
  }, [getWorldFromClient, renderMode]);

  return {
    boardRef,
    edges,
    nodeById,
    nodes,
    onNodeDragStart,
    renderMode,
    setRenderMode: setRenderModeSafe,
    viewport,
    webGpuAvailable,
  };
};
