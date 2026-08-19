const OVERLAY_ID = "fps-overlay";

export class FpsOverlay {
  private el: HTMLElement;
  private valueEl: HTMLElement;

  constructor() {
    const el = document.getElementById(OVERLAY_ID);
    if (!el) {
      throw new Error(`[ui] #${OVERLAY_ID} not found in DOM`);
    }
    this.el = el;
    this.el.textContent = "";
    this.valueEl = document.createElement("span");
    this.valueEl.id = "fps-value";
    this.el.append(this.valueEl);
    this.valueEl.textContent = "FPS: --";
  }

  set(fps: number): void {
    this.valueEl.textContent = `FPS: ${fps}`;
    this.el.classList.remove("fps-good", "fps-mid", "fps-bad");
    this.el.classList.add(fps > 45 ? "fps-good" : fps > 30 ? "fps-mid" : "fps-bad");
  }
}
