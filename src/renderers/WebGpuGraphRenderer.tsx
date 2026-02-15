import { useCallback, useEffect, useRef, useState } from "react";
import { worldPointToBoard } from "../graph/coordinates";
import { createNodeMap, cubicBezierPoint, getEdgeCurve } from "../graph/geometry";
import type { ViewportType } from "../types/common";
import type { EdgeType } from "../types/edge";
import type { NodeType } from "../types/node";
import styles from "../App.module.css";

const FLOATS_PER_VERTEX = 6;
const BYTES_PER_FLOAT = 4;
const STRIDE_BYTES = FLOATS_PER_VERTEX * BYTES_PER_FLOAT;
const EDGE_SEGMENTS = 28;

const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_BUFFER_USAGE_VERTEX = 0x0020;
const GPU_BUFFER_USAGE_UNIFORM = 0x0040;
const GPU_SHADER_STAGE_VERTEX = 0x1;
const GPU_COLOR_WRITE_ALL = 0xf;

const NODE_COLOR: [number, number, number, number] = [0.14, 0.21, 0.31, 0.94];
const EDGE_COLOR: [number, number, number, number] = [0.33, 0.89, 0.84, 0.95];

const SHADER = `
struct Uniforms {
  resolution: vec2f,
  _pad: vec2f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec2f,
  @location(1) color: vec4f,
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) color: vec4f,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let clipX = (input.position.x / uniforms.resolution.x) * 2.0 - 1.0;
  let clipY = 1.0 - (input.position.y / uniforms.resolution.y) * 2.0;
  output.clipPosition = vec4f(clipX, clipY, 0.0, 1.0);
  output.color = input.color;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return input.color;
}
`;

type GpuBufferLike = {
  destroy?: () => void;
};

type GpuQueueLike = {
  submit: (commands: unknown[]) => void;
  writeBuffer: (
    buffer: GpuBufferLike,
    bufferOffset: number,
    data: BufferSource,
    dataOffset?: number,
    size?: number,
  ) => void;
};

type GpuRenderPassLike = {
  draw: (vertexCount: number) => void;
  end: () => void;
  setBindGroup: (index: number, bindGroup: unknown) => void;
  setPipeline: (pipeline: unknown) => void;
  setVertexBuffer: (slot: number, buffer: GpuBufferLike) => void;
};

type GpuCommandEncoderLike = {
  beginRenderPass: (descriptor: {
    colorAttachments: Array<{
      clearValue: { r: number; g: number; b: number; a: number };
      loadOp: "clear";
      storeOp: "store";
      view: unknown;
    }>;
  }) => GpuRenderPassLike;
  finish: () => unknown;
};

type GpuDeviceLike = {
  createBindGroup: (descriptor: {
    layout: unknown;
    entries: Array<{ binding: number; resource: { buffer: GpuBufferLike } }>;
  }) => unknown;
  createBindGroupLayout: (descriptor: {
    entries: Array<{ binding: number; visibility: number; buffer: { type: "uniform" } }>;
  }) => unknown;
  createBuffer: (descriptor: { size: number; usage: number }) => GpuBufferLike;
  createCommandEncoder: () => GpuCommandEncoderLike;
  createPipelineLayout: (descriptor: { bindGroupLayouts: unknown[] }) => unknown;
  createRenderPipeline: (descriptor: unknown) => unknown;
  createShaderModule: (descriptor: { code: string }) => unknown;
  destroy?: () => void;
  queue: GpuQueueLike;
};

type GpuCanvasContextLike = {
  configure: (options: { device: GpuDeviceLike; format: string; alphaMode: "premultiplied" }) => void;
  getCurrentTexture: () => { createView: () => unknown };
};

type GpuAdapterLike = {
  requestDevice: () => Promise<GpuDeviceLike>;
};

type GpuNavigatorLike = {
  getPreferredCanvasFormat: () => string;
  requestAdapter: () => Promise<GpuAdapterLike | null>;
};

type Runtime = {
  bindGroup: unknown;
  context: GpuCanvasContextLike;
  device: GpuDeviceLike;
  linePipeline: unknown;
  trianglePipeline: unknown;
  uniformBuffer: GpuBufferLike;
};

type DynamicVertexBuffer = {
  buffer: GpuBufferLike | null;
  capacityBytes: number;
  vertexCount: number;
};

type Props = {
  edges: EdgeType[];
  nodes: NodeType[];
  viewport: ViewportType;
};

type SceneSnapshot = {
  edges: EdgeType[];
  nodes: NodeType[];
  viewport: ViewportType;
};

const appendVertex = (vertices: number[], x: number, y: number, color: [number, number, number, number]) => {
  vertices.push(x, y, color[0], color[1], color[2], color[3]);
};

const ensureVertexBuffer = (device: GpuDeviceLike, state: DynamicVertexBuffer, requiredBytes: number) => {
  if (state.buffer && state.capacityBytes >= requiredBytes) return;

  state.buffer?.destroy?.();
  state.capacityBytes = Math.max(4096, Math.max(requiredBytes, state.capacityBytes * 2));
  state.buffer = device.createBuffer({
    size: state.capacityBytes,
    usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
  });
};

const uploadVertices = (device: GpuDeviceLike, state: DynamicVertexBuffer, data: number[]) => {
  state.vertexCount = data.length / FLOATS_PER_VERTEX;
  if (data.length === 0) return;

  const floatData = new Float32Array(data);
  ensureVertexBuffer(device, state, floatData.byteLength);
  if (!state.buffer) return;

  device.queue.writeBuffer(state.buffer, 0, floatData, 0, floatData.length);
};

const resolveGpuNavigator = (): GpuNavigatorLike | null => {
  const nav = navigator as Navigator & { gpu?: unknown };
  const gpu = nav.gpu as GpuNavigatorLike | undefined;
  return gpu ?? null;
};

export const WebGpuGraphRenderer = ({ edges, nodes, viewport }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const dprRef = useRef(1);
  const sceneRef = useRef<SceneSnapshot>({ edges, nodes, viewport });
  const edgeBufferRef = useRef<DynamicVertexBuffer>({ buffer: null, capacityBytes: 0, vertexCount: 0 });
  const nodeBufferRef = useRef<DynamicVertexBuffer>({ buffer: null, capacityBytes: 0, vertexCount: 0 });
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const syncCanvasSize = useCallback(() => {
    const runtime = runtimeRef.current;
    const canvas = canvasRef.current;
    if (!runtime || !canvas) return;

    const host = canvas.parentElement ?? canvas;
    const rect = host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    dprRef.current = dpr;
    runtime.device.queue.writeBuffer(runtime.uniformBuffer, 0, new Float32Array([width, height, 0, 0]), 0, 4);
  }, []);

  const draw = useCallback(() => {
    const runtime = runtimeRef.current;
    const canvas = canvasRef.current;
    if (!runtime || !canvas || canvas.width === 0 || canvas.height === 0) return;

    const dpr = dprRef.current;
    const { edges: sceneEdges, nodes: sceneNodes, viewport: sceneViewport } = sceneRef.current;
    const nodeMap = createNodeMap(sceneNodes);

    const edgeVertices: number[] = [];
    const nodeVertices: number[] = [];

    sceneEdges.forEach((edge) => {
      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode || !targetNode) return;

      const curve = getEdgeCurve(sourceNode, targetNode);
      let previous = cubicBezierPoint(0, curve);

      for (let i = 1; i <= EDGE_SEGMENTS; i += 1) {
        const t = i / EDGE_SEGMENTS;
        const next = cubicBezierPoint(t, curve);

        const p0 = worldPointToBoard(previous, sceneViewport);
        const p1 = worldPointToBoard(next, sceneViewport);

        appendVertex(edgeVertices, p0.x * dpr, p0.y * dpr, EDGE_COLOR);
        appendVertex(edgeVertices, p1.x * dpr, p1.y * dpr, EDGE_COLOR);

        previous = next;
      }
    });

    sceneNodes.forEach((node) => {
      const topLeft = worldPointToBoard(node.position, sceneViewport);
      const x = topLeft.x * dpr;
      const y = topLeft.y * dpr;
      const width = node.width * sceneViewport.zoom * dpr;
      const height = node.height * sceneViewport.zoom * dpr;

      appendVertex(nodeVertices, x, y, NODE_COLOR);
      appendVertex(nodeVertices, x + width, y, NODE_COLOR);
      appendVertex(nodeVertices, x, y + height, NODE_COLOR);

      appendVertex(nodeVertices, x + width, y, NODE_COLOR);
      appendVertex(nodeVertices, x + width, y + height, NODE_COLOR);
      appendVertex(nodeVertices, x, y + height, NODE_COLOR);
    });

    uploadVertices(runtime.device, edgeBufferRef.current, edgeVertices);
    uploadVertices(runtime.device, nodeBufferRef.current, nodeVertices);

    const encoder = runtime.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: runtime.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    pass.setBindGroup(0, runtime.bindGroup);

    if (nodeBufferRef.current.vertexCount > 0 && nodeBufferRef.current.buffer) {
      pass.setPipeline(runtime.trianglePipeline);
      pass.setVertexBuffer(0, nodeBufferRef.current.buffer);
      pass.draw(nodeBufferRef.current.vertexCount);
    }

    if (edgeBufferRef.current.vertexCount > 0 && edgeBufferRef.current.buffer) {
      pass.setPipeline(runtime.linePipeline);
      pass.setVertexBuffer(0, edgeBufferRef.current.buffer);
      pass.draw(edgeBufferRef.current.vertexCount);
    }

    pass.end();
    runtime.device.queue.submit([encoder.finish()]);
  }, []);

  useEffect(() => {
    sceneRef.current = { edges, nodes, viewport };
    draw();
  }, [draw, edges, nodes, viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gpu = resolveGpuNavigator();
    if (!gpu) return;

    let disposed = false;

    const initialize = async () => {
      try {
        const adapter = await gpu.requestAdapter();
        if (!adapter) {
          if (!disposed) setRuntimeError("WebGPU adapter is unavailable.");
          return;
        }

        const device = await adapter.requestDevice();
        if (disposed) return;

        const context = canvas.getContext("webgpu") as GpuCanvasContextLike | null;
        if (!context) {
          if (!disposed) setRuntimeError("Failed to acquire WebGPU context.");
          return;
        }

        const format = gpu.getPreferredCanvasFormat();
        context.configure({
          device,
          format,
          alphaMode: "premultiplied",
        });

        const shaderModule = device.createShaderModule({ code: SHADER });

        const bindGroupLayout = device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPU_SHADER_STAGE_VERTEX,
              buffer: { type: "uniform" },
            },
          ],
        });

        const pipelineLayout = device.createPipelineLayout({
          bindGroupLayouts: [bindGroupLayout],
        });

        const vertexState = {
          module: shaderModule,
          entryPoint: "vs_main",
          buffers: [
            {
              arrayStride: STRIDE_BYTES,
              attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x2" },
                { shaderLocation: 1, offset: 2 * BYTES_PER_FLOAT, format: "float32x4" },
              ],
            },
          ],
        };

        const fragmentState = {
          module: shaderModule,
          entryPoint: "fs_main",
          targets: [{ format, writeMask: GPU_COLOR_WRITE_ALL }],
        };

        const trianglePipeline = device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: vertexState,
          fragment: fragmentState,
          primitive: { topology: "triangle-list", cullMode: "none" },
        });

        const linePipeline = device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: vertexState,
          fragment: fragmentState,
          primitive: { topology: "line-list" },
        });

        const uniformBuffer = device.createBuffer({
          size: 16,
          usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        });

        const bindGroup = device.createBindGroup({
          layout: bindGroupLayout,
          entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        });

        runtimeRef.current = {
          bindGroup,
          context,
          device,
          linePipeline,
          trianglePipeline,
          uniformBuffer,
        };

        if (!disposed) {
          setRuntimeError(null);
          syncCanvasSize();
          draw();
        }
      } catch {
        if (!disposed) {
          setRuntimeError("Failed to initialize WebGPU device.");
        }
      }
    };

    void initialize();

    return () => {
      disposed = true;

      edgeBufferRef.current.buffer?.destroy?.();
      nodeBufferRef.current.buffer?.destroy?.();
      runtimeRef.current?.uniformBuffer?.destroy?.();
      runtimeRef.current?.device?.destroy?.();

      edgeBufferRef.current = { buffer: null, capacityBytes: 0, vertexCount: 0 };
      nodeBufferRef.current = { buffer: null, capacityBytes: 0, vertexCount: 0 };
      runtimeRef.current = null;
    };
  }, [draw, syncCanvasSize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleResize = () => {
      syncCanvasSize();
      draw();
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(canvas.parentElement ?? canvas);
    window.addEventListener("resize", handleResize);
    handleResize();

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [draw, syncCanvasSize]);

  const browserHasWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
  const statusText = !browserHasWebGpu ? "WebGPU is unavailable in this browser." : runtimeError;

  return (
    <div className={styles.webGpuLayer}>
      <canvas ref={canvasRef} className={styles.webGpuCanvas} />
      {statusText ? <p className={styles.webGpuFallback}>{statusText}</p> : null}
    </div>
  );
};
