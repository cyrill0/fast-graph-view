/** WebGL renderer.
 *
 *  Three instanced draw calls per frame - edges, arrowheads, node discs - plus
 *  a fourth for the highlight ring. What keeps a huge graph fluid:
 *
 *  - one interleaved instance buffer per layer, allocated once and refilled by
 *    a single linear pass that culls off-screen geometry while copying;
 *  - screen-space line width and `size / sqrt(zoom)` node radii, so the picture
 *    reads the same at every zoom level like the native graph does;
 *  - node discs rasterised from a signed distance field - no texture, and no
 *    aliasing staircase when a hub grows large.
 */

import type { CameraState } from "./camera";
import type { Rgba } from "./theme";

export interface RenderScene {
  nodeCount: number;
  edgeCount: number;
  /** interleaved x,y in world units */
  pos: Float32Array;
  /** screen radius in device px at zoom 1, per node */
  radii: Float32Array;
  /** rgba per node, already faded */
  nodeColor: Float32Array;
  /** rgba per edge, already faded */
  edgeColor: Float32Array;
  /** edge endpoints, indices into pos */
  eu: Int32Array;
  ev: Int32Array;
}

export interface RingStyle {
  x: number;
  y: number;
  /** screen radius in device px */
  radius: number;
  /** stroke width in device px */
  stroke: number;
  color: Rgba;
}

export interface ArrowStyle {
  color: Rgba;
  /** screen px length of the arrowhead at unit thickness */
  size: number;
}

export interface RenderStyle {
  lineWidthPx: number;
  ring: RingStyle | null;
  arrows: ArrowStyle | null;
}

const NODE_STRIDE = 7; // ox, oy, size, r, g, b, a
const EDGE_STRIDE = 10; // ax, ay, bx, by, ra, rb, r, g, b, a
const ARROW_STRIDE = 9; // tipx, tipy, dirx, diry, len, r, g, b, a

/** unit quad corners in [-1,1], used for node discs */
const DISC_CORNERS = new Float32Array([-1, -1, -1, 1, 1, -1, 1, 1]);
/** unit quad corners as (t, side) for segment quads */
const SEGMENT_CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]);
/** the native arrow head silhouette: (0,0) (-4,-2) (-3,0) (-4,2) */
const ARROW_CORNERS = new Float32Array([0, 0, -4, -2, -3, 0, -4, 2]);
const QUAD_INDEX = new Uint16Array([0, 1, 3, 0, 3, 2]);

interface DivisorApi {
  divisor(index: number, divisor: number): void;
  draw(mode: number, count: number, type: number, offset: number, instances: number): void;
}

interface CommonLocs {
  uRes: WebGLUniformLocation | null;
  uPan: WebGLUniformLocation | null;
  uScale: WebGLUniformLocation | null;
  uRadiusScale: WebGLUniformLocation | null;
}

interface NodeLocs extends CommonLocs {
  uMode: WebGLUniformLocation | null;
  uBand: WebGLUniformLocation | null;
  uCenter: WebGLUniformLocation | null;
  aCorner: number;
  aOffset: number;
  aSize: number;
  aColor: number;
}

interface EdgeLocs extends CommonLocs {
  uHalfWidth: WebGLUniformLocation | null;
  aTC: number;
  aA: number;
  aB: number;
  aRadii: number;
  aColor: number;
}

interface ArrowLocs extends CommonLocs {
  aShape: number;
  aTip: number;
  aDir: number;
  aLen: number;
  aColor: number;
}

export class GraphRenderer {
  readonly gl: WebGLRenderingContext;
  private canvas: HTMLCanvasElement;
  private api: DivisorApi;
  private nodeProgram: WebGLProgram;
  private edgeProgram: WebGLProgram;
  private arrowProgram: WebGLProgram;
  private nodeLocs: NodeLocs;
  private edgeLocs: EdgeLocs;
  private arrowLocs: ArrowLocs;

  private discBuffer: WebGLBuffer;
  private segmentBuffer: WebGLBuffer;
  private arrowShapeBuffer: WebGLBuffer;
  private indexBuffer: WebGLBuffer;
  private nodeBuffer: WebGLBuffer;
  private edgeBuffer: WebGLBuffer;
  private arrowBuffer: WebGLBuffer;
  private ringBuffer: WebGLBuffer;

  private nodeData = new Float32Array(0);
  private edgeData = new Float32Array(0);
  private arrowData = new Float32Array(0);
  private ringData = new Float32Array(NODE_STRIDE);
  private nodeCapacity = 0;
  private edgeCapacity = 0;
  private arrowCapacity = 0;

  framesRendered = 0;
  lastFrameMs = 0;

  constructor(canvas: HTMLCanvasElement, mobile = false) {
    this.canvas = canvas;
    const options: WebGLContextAttributes = {
      alpha: true,
      premultipliedAlpha: false,
      // MSAA costs a lot of fill and memory bandwidth on mobile GPUs. Nodes and
      // lines are already shader-antialiased, so it is not needed there.
      antialias: !mobile,
      preserveDrawingBuffer: false,
    };
    const gl =
      (canvas.getContext("webgl2", options) as WebGLRenderingContext | null) ||
      (canvas.getContext("webgl", options));
    if (!gl) throw new Error("WebGL is not available");
    this.gl = gl;
    this.api = createDivisorApi(gl);

    this.nodeProgram = link(gl, NODE_VS, NODE_FS);
    this.edgeProgram = link(gl, EDGE_VS, EDGE_FS);
    this.arrowProgram = link(gl, ARROW_VS, ARROW_FS);
    this.nodeLocs = {
      ...commonLocs(gl, this.nodeProgram),
      uMode: gl.getUniformLocation(this.nodeProgram, "uMode"),
      uBand: gl.getUniformLocation(this.nodeProgram, "uBand"),
      uCenter: gl.getUniformLocation(this.nodeProgram, "uCenter"),
      aCorner: gl.getAttribLocation(this.nodeProgram, "aCorner"),
      aOffset: gl.getAttribLocation(this.nodeProgram, "aOffset"),
      aSize: gl.getAttribLocation(this.nodeProgram, "aSize"),
      aColor: gl.getAttribLocation(this.nodeProgram, "aColor"),
    };
    this.edgeLocs = {
      ...commonLocs(gl, this.edgeProgram),
      uHalfWidth: gl.getUniformLocation(this.edgeProgram, "uHalfWidth"),
      aTC: gl.getAttribLocation(this.edgeProgram, "aTC"),
      aA: gl.getAttribLocation(this.edgeProgram, "aA"),
      aB: gl.getAttribLocation(this.edgeProgram, "aB"),
      aRadii: gl.getAttribLocation(this.edgeProgram, "aRadii"),
      aColor: gl.getAttribLocation(this.edgeProgram, "aColor"),
    };
    this.arrowLocs = {
      ...commonLocs(gl, this.arrowProgram),
      aShape: gl.getAttribLocation(this.arrowProgram, "aShape"),
      aTip: gl.getAttribLocation(this.arrowProgram, "aTip"),
      aDir: gl.getAttribLocation(this.arrowProgram, "aDir"),
      aLen: gl.getAttribLocation(this.arrowProgram, "aLen"),
      aColor: gl.getAttribLocation(this.arrowProgram, "aColor"),
    };

    this.discBuffer = staticBuffer(gl, DISC_CORNERS);
    this.segmentBuffer = staticBuffer(gl, SEGMENT_CORNERS);
    this.arrowShapeBuffer = staticBuffer(gl, ARROW_CORNERS);
    this.indexBuffer = staticIndexBuffer(gl, QUAD_INDEX);
    this.nodeBuffer = dynamic(gl, 512 * NODE_STRIDE);
    this.edgeBuffer = dynamic(gl, 512 * EDGE_STRIDE);
    this.arrowBuffer = dynamic(gl, 512 * ARROW_STRIDE);
    this.ringBuffer = dynamic(gl, NODE_STRIDE);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const gl = this.gl;
    const w = Math.max(1, Math.floor(cssWidth));
    const h = Math.max(1, Math.floor(cssHeight));
    const bw = Math.max(1, Math.floor(w * dpr));
    const bh = Math.max(1, Math.floor(h * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    gl.viewport(0, 0, bw, bh);
  }

  render(scene: RenderScene, camera: CameraState, style: RenderStyle): void {
    const started = performance.now();
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (scene.nodeCount > 0) {
      const view = visibleBounds(camera);
      const radiusScale = 1 / Math.sqrt(camera.zoom);
      const edges = this.packEdges(scene, view);
      if (edges > 0) {
        this.drawEdges(edges, camera, radiusScale, style.lineWidthPx);
        if (style.arrows) {
          const arrows = this.packArrows(scene, view, radiusScale, style.arrows);
          if (arrows > 0) this.drawArrows(arrows, camera);
        }
      }
      const nodes = this.packNodes(scene, view);
      if (nodes > 0) this.drawNodeBatch(this.nodeBuffer, nodes, camera, radiusScale, 0, 0, 0);
      if (style.ring) this.drawRing(style.ring, camera, radiusScale);
    }
    this.framesRendered++;
    this.lastFrameMs = performance.now() - started;
  }

  /**
   * Read back the current frame as a PNG data url (pane menu "Copy screenshot").
   * Labels are drawn on their own canvas, so they are composited in here; this
   * must be called in the same task as the render, with `preserveDrawingBuffer`
   * off the buffer is gone once the frame is presented.
   */
  snapshot(labels: HTMLCanvasElement | null): string {
    if (!labels) return this.canvas.toDataURL("image/png");
    const out = createEl("canvas");
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    const ctx = out.getContext("2d");
    if (!ctx) return this.canvas.toDataURL("image/png");
    ctx.drawImage(this.canvas, 0, 0);
    ctx.drawImage(labels, 0, 0);
    return out.toDataURL("image/png");
  }

  dispose(): void {
    const gl = this.gl;
    for (const buf of [
      this.discBuffer,
      this.segmentBuffer,
      this.arrowShapeBuffer,
      this.indexBuffer,
      this.nodeBuffer,
      this.edgeBuffer,
      this.arrowBuffer,
      this.ringBuffer,
    ]) {
      gl.deleteBuffer(buf);
    }
    gl.deleteProgram(this.nodeProgram);
    gl.deleteProgram(this.edgeProgram);
    gl.deleteProgram(this.arrowProgram);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  // ---------------------------------------------------------------- packing

  private packNodes(scene: RenderScene, view: Bounds): number {
    if (this.nodeData.length < scene.nodeCount * NODE_STRIDE) {
      this.nodeData = new Float32Array(scene.nodeCount * NODE_STRIDE);
    }
    const out = this.nodeData;
    const pos = scene.pos;
    const radii = scene.radii;
    const colors = scene.nodeColor;
    let count = 0;
    let offset = 0;
    for (let i = 0; i < scene.nodeCount; i++) {
      const x = pos[i * 2];
      const y = pos[i * 2 + 1];
      const r = radii[i];
      if (x + r < view.left || x - r > view.right || y + r < view.top || y - r > view.bottom) continue;
      const c = i * 4;
      if (colors[c + 3] <= 0.002) continue;
      out[offset] = x;
      out[offset + 1] = y;
      out[offset + 2] = r;
      out[offset + 3] = colors[c];
      out[offset + 4] = colors[c + 1];
      out[offset + 5] = colors[c + 2];
      out[offset + 6] = colors[c + 3];
      offset += NODE_STRIDE;
      count++;
    }
    this.upload(this.nodeBuffer, out, offset, NODE_STRIDE, "node");
    return count;
  }

  private packEdges(scene: RenderScene, view: Bounds): number {
    if (this.edgeData.length < scene.edgeCount * EDGE_STRIDE) {
      this.edgeData = new Float32Array(scene.edgeCount * EDGE_STRIDE);
    }
    const out = this.edgeData;
    const pos = scene.pos;
    const colors = scene.edgeColor;
    let count = 0;
    let offset = 0;
    for (let i = 0; i < scene.edgeCount; i++) {
      const c = i * 4;
      if (colors[c + 3] <= 0.002) continue;
      const u = scene.eu[i];
      const v = scene.ev[i];
      const ax = pos[u * 2];
      const ay = pos[u * 2 + 1];
      const bx = pos[v * 2];
      const by = pos[v * 2 + 1];
      const minX = ax < bx ? ax : bx;
      const maxX = ax > bx ? ax : bx;
      const minY = ay < by ? ay : by;
      const maxY = ay > by ? ay : by;
      if (maxX < view.left || minX > view.right || maxY < view.top || minY > view.bottom) continue;
      out[offset] = ax;
      out[offset + 1] = ay;
      out[offset + 2] = bx;
      out[offset + 3] = by;
      out[offset + 4] = scene.radii[u];
      out[offset + 5] = scene.radii[v];
      out[offset + 6] = colors[c];
      out[offset + 7] = colors[c + 1];
      out[offset + 8] = colors[c + 2];
      out[offset + 9] = colors[c + 3];
      offset += EDGE_STRIDE;
      count++;
    }
    this.upload(this.edgeBuffer, out, offset, EDGE_STRIDE, "edge");
    return count;
  }

  private packArrows(scene: RenderScene, view: Bounds, radiusScale: number, arrows: ArrowStyle): number {
    if (this.arrowData.length < scene.edgeCount * ARROW_STRIDE) {
      this.arrowData = new Float32Array(scene.edgeCount * ARROW_STRIDE);
    }
    const out = this.arrowData;
    const pos = scene.pos;
    const colors = scene.edgeColor;
    let count = 0;
    let offset = 0;
    for (let i = 0; i < scene.edgeCount; i++) {
      const c = i * 4;
      if (colors[c + 3] <= 0.02) continue;
      const u = scene.eu[i];
      const v = scene.ev[i];
      const bx = pos[v * 2];
      const by = pos[v * 2 + 1];
      if (bx < view.left || bx > view.right || by < view.top || by > view.bottom) continue;
      const ax = pos[u * 2];
      const ay = pos[u * 2 + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-4) continue;
      const ux = dx / len;
      const uy = dy / len;
      const trim = Math.min(scene.radii[v] * radiusScale, len * 0.45);
      out[offset] = bx - ux * trim;
      out[offset + 1] = by - uy * trim;
      out[offset + 2] = ux;
      out[offset + 3] = uy;
      out[offset + 4] = arrows.size;
      out[offset + 5] = arrows.color.r;
      out[offset + 6] = arrows.color.g;
      out[offset + 7] = arrows.color.b;
      out[offset + 8] = arrows.color.a * colors[c + 3];
      offset += ARROW_STRIDE;
      count++;
    }
    this.upload(this.arrowBuffer, out, offset, ARROW_STRIDE, "arrow");
    return count;
  }

  private upload(
    buffer: WebGLBuffer,
    data: Float32Array,
    floats: number,
    stride: number,
    kind: "node" | "edge" | "arrow",
  ): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const capacity =
      kind === "node" ? this.nodeCapacity : kind === "edge" ? this.edgeCapacity : this.arrowCapacity;
    const needed = floats / stride;
    if (needed > capacity) {
      gl.bufferData(gl.ARRAY_BUFFER, Math.max(needed, capacity * 2) * stride * 4, gl.DYNAMIC_DRAW);
      if (kind === "node") this.nodeCapacity = Math.max(needed, capacity * 2);
      else if (kind === "edge") this.edgeCapacity = Math.max(needed, capacity * 2);
      else this.arrowCapacity = Math.max(needed, capacity * 2);
    }
    if (floats > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, floats));
  }

  // ---------------------------------------------------------------- drawing

  private commonUniforms(locs: CommonLocs, camera: CameraState, radiusScale: number): void {
    const gl = this.gl;
    gl.uniform2f(locs.uRes, camera.width, camera.height);
    gl.uniform2f(locs.uPan, camera.panX, camera.panY);
    gl.uniform1f(locs.uScale, camera.scale);
    gl.uniform1f(locs.uRadiusScale, radiusScale);
  }

  private drawNodeBatch(
    instanceBuffer: WebGLBuffer,
    count: number,
    camera: CameraState,
    radiusScale: number,
    mode: number,
    band: number,
    center: number,
  ): void {
    const gl = this.gl;
    const L = this.nodeLocs;
    gl.useProgram(this.nodeProgram);
    this.commonUniforms(L, camera, radiusScale);
    gl.uniform1f(L.uMode, mode);
    gl.uniform1f(L.uBand, band);
    gl.uniform1f(L.uCenter, center);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.discBuffer);
    const aCorner = bindAttrib(gl, L.aCorner, 2, 0, 0);
    this.api.divisor(aCorner, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    const b = NODE_STRIDE * 4;
    const aOffset = bindAttrib(gl, L.aOffset, 2, b, 0);
    const aSize = bindAttrib(gl, L.aSize, 1, b, 8);
    const aColor = bindAttrib(gl, L.aColor, 4, b, 12);
    this.api.divisor(aOffset, 1);
    this.api.divisor(aSize, 1);
    this.api.divisor(aColor, 1);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    this.api.draw(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
    this.api.divisor(aOffset, 0);
    this.api.divisor(aSize, 0);
    this.api.divisor(aColor, 0);
  }

  /** The ring lives in its own buffer so it cannot clobber the node batch. */
  private drawRing(ring: RingStyle, camera: CameraState, radiusScale: number): void {
    const outer = ring.radius + ring.stroke;
    const size = outer * radiusScale;
    const data = this.ringData;
    data[0] = ring.x;
    data[1] = ring.y;
    data[2] = size;
    data[3] = ring.color.r;
    data[4] = ring.color.g;
    data[5] = ring.color.b;
    data[6] = ring.color.a;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ringBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    // band and centre are fractions of the quad radius
    this.drawNodeBatch(
      this.ringBuffer,
      1,
      camera,
      radiusScale,
      1,
      ring.stroke / 2 / outer,
      ring.radius / outer,
    );
  }

  private drawEdges(count: number, camera: CameraState, radiusScale: number, lineWidthPx: number): void {
    const gl = this.gl;
    const L = this.edgeLocs;
    gl.useProgram(this.edgeProgram);
    this.commonUniforms(L, camera, radiusScale);
    gl.uniform1f(L.uHalfWidth, lineWidthPx * 0.5);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.segmentBuffer);
    const aTC = bindAttrib(gl, L.aTC, 2, 0, 0);
    this.api.divisor(aTC, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer);
    const b = EDGE_STRIDE * 4;
    const aA = bindAttrib(gl, L.aA, 2, b, 0);
    const aB = bindAttrib(gl, L.aB, 2, b, 8);
    const aR = bindAttrib(gl, L.aRadii, 2, b, 16);
    const aC = bindAttrib(gl, L.aColor, 4, b, 24);
    this.api.divisor(aA, 1);
    this.api.divisor(aB, 1);
    this.api.divisor(aR, 1);
    this.api.divisor(aC, 1);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    this.api.draw(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
    this.api.divisor(aA, 0);
    this.api.divisor(aB, 0);
    this.api.divisor(aR, 0);
    this.api.divisor(aC, 0);
  }

  private drawArrows(count: number, camera: CameraState): void {
    const gl = this.gl;
    const L = this.arrowLocs;
    gl.useProgram(this.arrowProgram);
    this.commonUniforms(L, camera, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowShapeBuffer);
    const aShape = bindAttrib(gl, L.aShape, 2, 0, 0);
    this.api.divisor(aShape, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowBuffer);
    const b = ARROW_STRIDE * 4;
    const aTip = bindAttrib(gl, L.aTip, 2, b, 0);
    const aDir = bindAttrib(gl, L.aDir, 2, b, 8);
    const aLen = bindAttrib(gl, L.aLen, 1, b, 16);
    const aC = bindAttrib(gl, L.aColor, 4, b, 20);
    this.api.divisor(aTip, 1);
    this.api.divisor(aDir, 1);
    this.api.divisor(aLen, 1);
    this.api.divisor(aC, 1);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    this.api.draw(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
    this.api.divisor(aTip, 0);
    this.api.divisor(aDir, 0);
    this.api.divisor(aLen, 0);
    this.api.divisor(aC, 0);
  }
}

interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function visibleBounds(camera: CameraState): Bounds {
  const margin = 96 / camera.scale;
  return {
    left: -camera.panX / camera.scale - margin,
    right: (camera.width - camera.panX) / camera.scale + margin,
    top: -camera.panY / camera.scale - margin,
    bottom: (camera.height - camera.panY) / camera.scale + margin,
  };
}

function commonLocs(gl: WebGLRenderingContext, program: WebGLProgram): CommonLocs {
  return {
    uRes: gl.getUniformLocation(program, "uRes"),
    uPan: gl.getUniformLocation(program, "uPan"),
    uScale: gl.getUniformLocation(program, "uScale"),
    uRadiusScale: gl.getUniformLocation(program, "uRadiusScale"),
  };
}

function bindAttrib(
  gl: WebGLRenderingContext,
  location: number,
  size: number,
  stride: number,
  offset: number,
): number {
  if (location < 0) return -1;
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
  return location;
}

function dynamic(gl: WebGLRenderingContext, floats: number): WebGLBuffer {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, floats * 4, gl.DYNAMIC_DRAW);
  return b;
}

function staticBuffer(gl: WebGLRenderingContext, data: Float32Array): WebGLBuffer {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return b;
}

function staticIndexBuffer(gl: WebGLRenderingContext, data: Uint16Array): WebGLBuffer {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return b;
}

function createDivisorApi(gl: WebGLRenderingContext): DivisorApi {
  const gl2 = gl as WebGL2RenderingContext;
  if (typeof gl2.vertexAttribDivisor === "function" && typeof gl2.drawElementsInstanced === "function") {
    return {
      divisor: (index, divisor) => gl2.vertexAttribDivisor(index, divisor),
      draw: (mode, count, type, offset, instances) => gl2.drawElementsInstanced(mode, count, type, offset, instances),
    };
  }
  const ext = gl.getExtension("ANGLE_instanced_arrays");
  if (!ext) throw new Error("This GPU cannot draw instanced geometry");
  return {
    divisor: (index, divisor) => ext.vertexAttribDivisorANGLE(index, divisor),
    draw: (mode, count, type, offset, instances) => ext.drawElementsInstancedANGLE(mode, count, type, offset, instances),
  };
}

function link(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("Could not create a WebGL program");
  attach(gl, program, gl.VERTEX_SHADER, vs);
  attach(gl, program, gl.FRAGMENT_SHADER, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`WebGL link failed: ${log}`);
  }
  return program;
}

function attach(gl: WebGLRenderingContext, program: WebGLProgram, type: number, source: string): void {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create a WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL compile failed: ${log}`);
  }
  gl.attachShader(program, shader);
  gl.deleteShader(shader);
}

const PROJECTION = `
uniform vec2 uRes;
uniform vec2 uPan;
uniform float uScale;
uniform float uRadiusScale;
vec2 toClip(vec2 world) {
  vec2 screen = world * uScale + uPan;
  return vec2(screen.x / uRes.x * 2.0 - 1.0, 1.0 - screen.y / uRes.y * 2.0);
}
`;

const NODE_VS = `
precision mediump float;
attribute vec2 aCorner;
attribute vec2 aOffset;
attribute float aSize;
attribute vec4 aColor;
${PROJECTION}
varying vec2 vP;
varying vec4 vColor;
void main() {
  vec2 world = aOffset + aCorner * aSize * uRadiusScale;
  gl_Position = vec4(toClip(world), 0.0, 1.0);
  vP = aCorner;
  vColor = aColor;
}
`;

const NODE_FS = `
precision mediump float;
varying vec2 vP;
varying vec4 vColor;
uniform float uMode;
uniform float uBand;
uniform float uCenter;
void main() {
  float d = length(vP);
  float alpha;
  if (uMode < 0.5) {
    if (d > 1.0) discard;
    alpha = 1.0 - smoothstep(0.90, 1.0, d);
  } else {
    if (abs(d - uCenter) > uBand * 3.0) discard;
    alpha = 1.0 - smoothstep(0.0, uBand, abs(d - uCenter));
  }
  gl_FragColor = vec4(vColor.rgb, vColor.a * alpha);
}
`;

const EDGE_VS = `
precision mediump float;
attribute vec2 aTC;
attribute vec2 aA;
attribute vec2 aB;
attribute vec2 aRadii;
attribute vec4 aColor;
${PROJECTION}
uniform float uHalfWidth;
varying vec4 vColor;
void main() {
  vec2 d = aB - aA;
  float len = length(d);
  vec2 u = len > 0.0001 ? d / len : vec2(1.0, 0.0);
  vec2 p = vec2(-u.y, u.x);
  float ta = min(aRadii.x * uRadiusScale, len * 0.45);
  float tb = min(aRadii.y * uRadiusScale, len * 0.45);
  vec2 a = aA + u * ta;
  vec2 b = aB - u * tb;
  float w = uHalfWidth / uScale;
  vec2 world = mix(a, b, aTC.x) + p * aTC.y * w;
  gl_Position = vec4(toClip(world), 0.0, 1.0);
  vColor = aColor;
}
`;

const EDGE_FS = `
precision mediump float;
varying vec4 vColor;
void main() {
  gl_FragColor = vColor;
}
`;

const ARROW_VS = `
precision mediump float;
attribute vec2 aShape;
attribute vec2 aTip;
attribute vec2 aDir;
attribute float aLen;
attribute vec4 aColor;
${PROJECTION}
varying vec4 vColor;
void main() {
  float s = aLen / uScale;
  vec2 offset = aDir * aShape.x * s + vec2(-aDir.y, aDir.x) * aShape.y * s;
  gl_Position = vec4(toClip(aTip + offset), 0.0, 1.0);
  vColor = aColor;
}
`;

const ARROW_FS = `
precision mediump float;
varying vec4 vColor;
void main() {
  gl_FragColor = vColor;
}
`;
