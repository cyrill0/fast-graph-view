/** Pan / zoom camera.
 *
 *  The numbers are the native ones: wheel multiplies the zoom by
 *  `1.5^(-deltaY/120)`, the result is clamped to 1/128 … 8, zooming in anchors
 *  on the cursor while zooming out anchors on the centre, the applied value
 *  eases toward the target by 15 % a frame, and a released pan keeps gliding.
 */

export interface CameraState {
  /** device px */
  panX: number;
  panY: number;
  /** device px per world unit */
  scale: number;
  /** CSS px per world unit, i.e. the zoom the size formulas use */
  zoom: number;
  /** device px */
  width: number;
  height: number;
}

export const MIN_ZOOM = 1 / 128;
export const MAX_ZOOM = 8;
const ZOOM_EASE = 0.85;
const GLIDE_DECAY = 0.9;
const GLIDE_EPSILON = 1e-4;
const FRAME_MS = 1000 / 60;
/** a pointer gap longer than this is a stall, not a slow drag */
const STALL_MS = 100;
/** the whole released glide travels at most this many pane widths */
const MAX_GLIDE_PANES = 1;

export class Camera {
  panX = 0;
  panY = 0;
  zoom = 1;
  targetZoom = 1;
  /** CSS px per ms, sampled while dragging */
  private velocityX = 0;
  private velocityY = 0;
  private lastMoveTime = 0;
  private gliding = false;
  /** while a zoom animation runs, world point under this CSS-px anchor is kept still */
  private anchorX = 0;
  private anchorY = 0;
  private hasAnchor = false;
  dpr = 1;
  width = 0;
  height = 0;

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const first = this.width === 0;
    this.width = cssWidth;
    this.height = cssHeight;
    this.dpr = dpr;
    if (first) this.resetPan();
  }

  /** native `resetPan()` puts world 0 at the centre of the pane */
  resetPan(): void {
    this.panX = this.width / 2;
    this.panY = this.height / 2;
    this.velocityX = 0;
    this.velocityY = 0;
    this.gliding = false;
  }

  get moving(): boolean {
    return (
      Math.abs(this.zoom - this.targetZoom) > this.zoom * 0.01 ||
      this.gliding ||
      Math.abs(this.velocityX) > GLIDE_EPSILON ||
      Math.abs(this.velocityY) > GLIDE_EPSILON
    );
  }

  wheel(deltaY: number, deltaMode: number, clientX: number, clientY: number): void {
    let dy = deltaY;
    if (deltaMode === 1) dy *= 40;
    else if (deltaMode === 2) dy *= 800;
    const next = this.targetZoom * Math.pow(1.5, -dy / 120);
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    const zoomingIn = clamped > this.targetZoom;
    this.targetZoom = clamped;
    if (zoomingIn) this.anchorAt(clientX, clientY);
    else this.anchorAt(this.width / 2, this.height / 2);
  }

  private anchorAt(cssX: number, cssY: number): void {
    this.anchorX = cssX;
    this.anchorY = cssY;
    this.hasAnchor = true;
  }

  zoomAtCenter(factor: number): void {
    const target = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.targetZoom * factor));
    this.targetZoom = target;
    this.anchorAt(this.width / 2, this.height / 2);
  }

  /** Zoom toward a touch/pointer anchor, keeping that screen point in place. */
  zoomAt(factor: number, cssX: number, cssY: number): void {
    this.targetZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.targetZoom * factor));
    this.anchorAt(cssX, cssY);
  }

  /** A new direct-manipulation gesture should not inherit an old inertial pan. */
  stopGlide(): void {
    this.velocityX = 0;
    this.velocityY = 0;
    this.gliding = false;
  }

  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
  }

  /** feed pointer deltas while dragging; keeps the glide velocity honest */
  trackPan(dx: number, dy: number, timeMs: number): void {
    const elapsed = this.lastMoveTime ? timeMs - this.lastMoveTime : FRAME_MS;
    if (elapsed > STALL_MS) {
      this.velocityX = 0;
      this.velocityY = 0;
    }
    const dt = Math.max(1, elapsed);
    this.velocityX = this.velocityX * 0.8 + (dx / dt) * 0.2;
    this.velocityY = this.velocityY * 0.8 + (dy / dt) * 0.2;
    // a stalled compositor delivers a whole drag step inside one millisecond, and pricing
    // that per millisecond flings the view tens of thousands of px - observed live. Cap the
    // velocity so the sum of the decay series stays inside MAX_GLIDE_PANES pane widths.
    const cap = (this.width * MAX_GLIDE_PANES * (1 - GLIDE_DECAY)) / FRAME_MS;
    this.velocityX = Math.max(-cap, Math.min(cap, this.velocityX));
    this.velocityY = Math.max(-cap, Math.min(cap, this.velocityY));
    this.lastMoveTime = timeMs;
    this.panBy(dx, dy);
  }

  releasePan(): void {
    this.gliding =
      Math.abs(this.velocityX) > 0.02 || Math.abs(this.velocityY) > 0.02;
  }

  /** advance easing + inertia one frame; returns true while something moved */
  tick(): boolean {
    let moved = false;
    if (Math.abs(this.zoom - this.targetZoom) > this.zoom * 0.01) {
      const next = this.zoom + (this.targetZoom - this.zoom) * (1 - ZOOM_EASE);
      const cx = this.hasAnchor ? this.anchorX : this.width / 2;
      const cy = this.hasAnchor ? this.anchorY : this.height / 2;
      const worldX = (cx - this.panX) / this.zoom;
      const worldY = (cy - this.panY) / this.zoom;
      this.zoom = next;
      this.panX = cx - worldX * this.zoom;
      this.panY = cy - worldY * this.zoom;
      moved = true;
    } else {
      this.zoom = this.targetZoom;
      this.hasAnchor = false;
    }
    if (this.gliding) {
      this.panX += this.velocityX * (1000 / 60);
      this.panY += this.velocityY * (1000 / 60);
      this.velocityX *= GLIDE_DECAY;
      this.velocityY *= GLIDE_DECAY;
      if (Math.abs(this.velocityX) < GLIDE_EPSILON && Math.abs(this.velocityY) < GLIDE_EPSILON) {
        this.gliding = false;
        this.velocityX = 0;
        this.velocityY = 0;
      }
      moved = true;
    }
    return moved;
  }

  state(): CameraState {
    return {
      panX: this.panX * this.dpr,
      panY: this.panY * this.dpr,
      scale: this.zoom * this.dpr,
      zoom: this.zoom,
      width: this.width * this.dpr,
      height: this.height * this.dpr,
    };
  }

  screenToWorldX(cssX: number): number {
    return (cssX - this.panX) / this.zoom;
  }

  screenToWorldY(cssY: number): number {
    return (cssY - this.panY) / this.zoom;
  }

  worldToScreenX(x: number): number {
    return x * this.zoom + this.panX;
  }

  worldToScreenY(y: number): number {
    return y * this.zoom + this.panY;
  }

  /** node radius in CSS px at the current zoom - the native `size * sqrt(zoom)` */
  screenRadius(size: number): number {
    return size * Math.sqrt(this.zoom);
  }

  /** Restore a persisted scale: no glide, no anchor, clamped like the wheel. */
  setZoom(zoom: number): void {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    this.zoom = clamped;
    this.targetZoom = clamped;
    this.hasAnchor = false;
  }
}
