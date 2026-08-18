const OVERLAY_ID = "fps-overlay";

export class FpsOverlay {
  private el: HTMLElement;
  private valueEl: HTMLElement;
  private statsEl: HTMLElement;

  constructor() {
    const el = document.getElementById(OVERLAY_ID);
    if (!el) {
      throw new Error(`[ui] #${OVERLAY_ID} not found in DOM`);
    }
    this.el = el;
    this.el.textContent = "";
    this.valueEl = document.createElement("span");
    this.valueEl.id = "fps-value";
    this.statsEl = document.createElement("div");
    this.statsEl.id = "fps-stats";
    this.statsEl.className = "fps-stats";
    this.el.append(this.valueEl, this.statsEl);
    this.valueEl.textContent = "FPS: --";
    this.statsEl.textContent = "<60: 0  <50: 0";
  }

  set(fps: number, below60: number, below50: number): void {
    this.valueEl.textContent = `FPS: ${fps}`;
    this.el.classList.remove("fps-good", "fps-mid", "fps-bad");
    this.el.classList.add(fps > 45 ? "fps-good" : fps > 30 ? "fps-mid" : "fps-bad");
    this.statsEl.textContent = `<60: ${below60}  <50: ${below50}`;
  }
}
