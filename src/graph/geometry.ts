import type { NodeType } from "../types/node";

export type EdgeCurve = {
  sx: number;
  sy: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  tx: number;
  ty: number;
};

export type NodeBounds = {
  centerX: number;
  centerY: number;
  height: number;
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
  width: number;
};

export const createNodeMap = (nodes: NodeType[]) => {
  const map = new Map<string, NodeType>();
  nodes.forEach((node) => map.set(node.id, node));
  return map;
};

export const getNodesBounds = (nodes: NodeType[]): NodeBounds | undefined => {
  if (nodes.length === 0) return undefined;

  let minX = nodes[0].position.x;
  let minY = nodes[0].position.y;
  let maxX = nodes[0].position.x + nodes[0].width;
  let maxY = nodes[0].position.y + nodes[0].height;

  for (let i = 1; i < nodes.length; i += 1) {
    const node = nodes[i];
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + node.width);
    maxY = Math.max(maxY, node.position.y + node.height);
  }

  const width = maxX - minX;
  const height = maxY - minY;

  return {
    centerX: minX + width / 2,
    centerY: minY + height / 2,
    height,
    maxX,
    maxY,
    minX,
    minY,
    width,
  };
};

export const getEdgeCurve = (sourceNode: NodeType, targetNode: NodeType): EdgeCurve => {
  const sx = sourceNode.position.x + sourceNode.width / 2;
  const sy = sourceNode.position.y + sourceNode.height / 2;

  const tx = targetNode.position.x + targetNode.width / 2;
  const ty = targetNode.position.y + targetNode.height / 2;

  const dx = tx - sx;
  const k = 0.35;

  return {
    sx,
    sy,
    x1: sx + dx * k,
    y1: sy,
    x2: tx - dx * k,
    y2: ty,
    tx,
    ty,
  };
};

export const isPointInsideNode = (worldX: number, worldY: number, node: NodeType) =>
  worldX >= node.position.x &&
  worldX <= node.position.x + node.width &&
  worldY >= node.position.y &&
  worldY <= node.position.y + node.height;

export const getTopNodeAtPoint = (nodes: NodeType[], worldX: number, worldY: number): NodeType | undefined => {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    if (isPointInsideNode(worldX, worldY, nodes[i])) {
      return nodes[i];
    }
  }

  return undefined;
};

export const cubicBezierPoint = (
  t: number,
  curve: Pick<EdgeCurve, "sx" | "sy" | "x1" | "y1" | "x2" | "y2" | "tx" | "ty">,
) => {
  const omt = 1 - t;
  const omt2 = omt * omt;
  const omt3 = omt2 * omt;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: omt3 * curve.sx + 3 * omt2 * t * curve.x1 + 3 * omt * t2 * curve.x2 + t3 * curve.tx,
    y: omt3 * curve.sy + 3 * omt2 * t * curve.y1 + 3 * omt * t2 * curve.y2 + t3 * curve.ty,
  };
};
