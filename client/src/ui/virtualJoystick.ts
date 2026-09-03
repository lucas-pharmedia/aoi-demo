const ROOT_ID = "virtual-joystick";

export type JoystickAxes = { x: number; y: number };

export type VirtualJoystickOptions = {
  onChange: (axes: JoystickAxes | null) => void;
  /** 死區：相對於 maxRadius 的比例，預設 0.15 */
  deadZone?: number;
  /** knob 最大偏移 px，預設取 base 半徑 * 0.45 */
  maxRadius?: number;
};

/**
 * HTML 虛擬搖桿（左下角 DOM）。輸出正規化向量；死區內 / 放開為 null。
 */
export class VirtualJoystick {
  private readonly root: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly onChange: (axes: JoystickAxes | null) => void;
  private readonly deadZone: number;
  private readonly maxRadius: number;
  private activePointerId: number | null = null;
  private centerX = 0;
  private centerY = 0;

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (this.activePointerId !== null) return;
    if (ev.button !== 0 && ev.pointerType === "mouse") return;
    ev.preventDefault();
    this.activePointerId = ev.pointerId;
    this.root.setPointerCapture(ev.pointerId);
    this.root.classList.add("is-active");
    this.refreshCenter();
    this.applyPointer(ev.clientX, ev.clientY);
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.activePointerId) return;
    ev.preventDefault();
    this.applyPointer(ev.clientX, ev.clientY);
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.activePointerId) return;
    ev.preventDefault();
    this.release();
  };

  constructor(options: VirtualJoystickOptions) {
    const root = document.getElementById(ROOT_ID);
    if (!root) {
      throw new Error(`[ui] #${ROOT_ID} not found in DOM`);
    }
    const knob = root.querySelector<HTMLElement>(".vj-knob");
    if (!knob) {
      throw new Error("[ui] .vj-knob not found in #virtual-joystick");
    }

    this.root = root;
    this.knob = knob;
    this.onChange = options.onChange;
    this.deadZone = options.deadZone ?? 0.15;

    const baseSize = root.clientWidth || 120;
    this.maxRadius = options.maxRadius ?? baseSize * 0.45;

    this.root.addEventListener("pointerdown", this.onPointerDown);
    this.root.addEventListener("pointermove", this.onPointerMove);
    this.root.addEventListener("pointerup", this.onPointerUp);
    this.root.addEventListener("pointercancel", this.onPointerUp);
  }

  /** 是否正被按住（含死區內） */
  get isActive(): boolean {
    return this.activePointerId !== null;
  }

  destroy(): void {
    this.release();
    this.root.removeEventListener("pointerdown", this.onPointerDown);
    this.root.removeEventListener("pointermove", this.onPointerMove);
    this.root.removeEventListener("pointerup", this.onPointerUp);
    this.root.removeEventListener("pointercancel", this.onPointerUp);
  }

  private refreshCenter(): void {
    const rect = this.root.getBoundingClientRect();
    this.centerX = rect.left + rect.width / 2;
    this.centerY = rect.top + rect.height / 2;
  }

  private applyPointer(clientX: number, clientY: number): void {
    let dx = clientX - this.centerX;
    let dy = clientY - this.centerY;
    const dist = Math.hypot(dx, dy);

    if (dist > this.maxRadius && dist > 0) {
      const scale = this.maxRadius / dist;
      dx *= scale;
      dy *= scale;
    }

    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;

    const clampedDist = Math.min(dist, this.maxRadius);
    if (clampedDist < this.maxRadius * this.deadZone) {
      this.onChange(null);
      return;
    }

    this.onChange({
      x: dx / this.maxRadius,
      y: dy / this.maxRadius,
    });
  }

  private release(): void {
    if (this.activePointerId === null) return;
    this.activePointerId = null;
    this.root.classList.remove("is-active");
    this.knob.style.transform = "translate(0px, 0px)";
    this.onChange(null);
  }
}
