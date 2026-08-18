const OVERLAY_ID = "fps-overlay";

export class FpsOverlay {
  private el: HTMLElement;

  constructor() {
    const el = document.getElementById(OVERLAY_ID);
    if (!el) {
      throw new Error(`[ui] #${OVERLAY_ID} not found in DOM`);
    }
    this.el = el;
  }

  set(fps: number): void {
    this.el.textContent = `FPS: ${fps}`;
    this.el.classList.remove("fps-good", "fps-mid", "fps-bad");
    this.el.classList.add(fps > 45 ? "fps-good" : fps > 30 ? "fps-mid" : "fps-bad");
  }
}
