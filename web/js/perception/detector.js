// Main-thread handle on the detector worker. One frame in flight at a time:
// if the phone is slow, FIELD analyses fewer frames rather than queueing stale
// ones, so what it reasons about is always close to what the camera sees now.

export class Detector {
  constructor() {
    this.worker = null;
    this.info = null;
    this.busy = false;
    this.nextId = 1;
    this.pending = new Map();
    this.onProgress = null;
  }

  async load({ prefer = "auto", onProgress } = {}) {
    this.onProgress = onProgress ?? null;
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev) => this.#receive(ev.data);
    this.worker.onerror = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(ev.message || "detector worker failed"));
      this.pending.clear();
    };
    this.info = await this.#call({ type: "load", prefer });
    return this.info;
  }

  get ready() {
    return this.info != null;
  }

  /**
   * source: an ImageBitmap-able thing (video, canvas, image). Returns null if a
   * frame is already being analysed.
   */
  async detect(source, { scoreThreshold = 0.2 } = {}) {
    if (!this.ready || this.busy) return null;
    this.busy = true;
    try {
      const bitmap = await createImageBitmap(source);
      return await this.#call({ type: "detect", bitmap, scoreThreshold }, [bitmap]);
    } finally {
      this.busy = false;
    }
  }

  #call(msg, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  #receive(msg) {
    if (msg.type === "progress") {
      this.onProgress?.(msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg);
  }
}
