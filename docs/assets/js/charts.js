/* Canvas charts: the brushable timeline and the price distribution. */

const PAD = { left: 48, right: 14, top: 10, bottom: 20 };

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function setupCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function niceTimeLabel(ms, spanMs) {
  const date = new Date(ms);
  if (spanMs > 36 * 3600 * 1000) {
    return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  }
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

export class TimelineChart {
  constructor(canvas, { onBrush, onHover, onSelect, onReset } = {}) {
    this.canvas = canvas;
    this.onBrush = onBrush || (() => {});
    this.onHover = onHover || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onReset = onReset || (() => {});
    this.data = { series: [], domain: null, playhead: null, selected: null, brush: null };
    this.drag = null;
    this.hover = null;
    this.bound = false;
    this.bind();
    this.resize();
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.canvas.addEventListener("pointercancel", () => { this.drag = null; this.draw(); });
    this.canvas.addEventListener("pointerleave", () => {
      this.hover = null;
      this.canvas.style.cursor = "crosshair";
      this.onHover(null);
      this.draw();
    });
    this.canvas.addEventListener("dblclick", () => {
      this.drag = null;
      this.onReset();
    });
  }

  resize() {
    const { ctx, width, height } = setupCanvas(this.canvas);
    this.ctx = ctx;
    this.width = width;
    this.height = height;
    this.draw();
  }

  setData(data) {
    this.data = { ...this.data, ...data };
    this.draw();
  }

  setPlayhead(ms) {
    this.data.playhead = ms;
    this.draw();
  }

  pointToX(t) {
    const domain = this.data.domain;
    if (!domain) return 0;
    const inner = this.width - PAD.left - PAD.right;
    return PAD.left + ((t - domain.t0) / Math.max(1, domain.t1 - domain.t0)) * inner;
  }

  xToTime(x) {
    const domain = this.data.domain;
    if (!domain) return 0;
    const inner = this.width - PAD.left - PAD.right;
    return domain.t0 + ((x - PAD.left) / Math.max(1, inner)) * (domain.t1 - domain.t0);
  }

  nearest(x, y) {
    const series = this.data.series || [];
    let best = null;
    let bestDistance = Infinity;
    for (const line of series) {
      for (const point of line.points) {
        const px = this.pointToX(point.t);
        const py = this.valueToY(point.v ?? point.p);
        const distance = Math.hypot(px - x, py - y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = point;
        }
      }
    }
    return bestDistance <= 26 ? best : null;
  }

  valueDomain() {
    let min = Infinity;
    let max = -Infinity;
    for (const line of this.data.series || []) {
      for (const point of line.points) {
        const value = point.v ?? point.p;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    if (!Number.isFinite(min)) return { min: 0, max: 1 };
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.055;
    return { min: min - pad, max: max + pad };
  }

  valueToY(value) {
    const domain = this.data.valueDomain || this.valueDomain();
    const inner = this.height - PAD.top - PAD.bottom;
    return PAD.top + (1 - (value - domain.min) / Math.max(1e-9, domain.max - domain.min)) * inner;
  }

  localPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  onPointerDown(event) {
    if (event.button !== 0) return;
    const { x } = this.localPoint(event);
    this.drag = { startX: x, currentX: x, moved: false };
    this.canvas.setPointerCapture(event.pointerId);
  }

  onPointerMove(event) {
    const { x, y } = this.localPoint(event);
    if (this.drag) {
      this.drag.currentX = x;
      if (Math.abs(x - this.drag.startX) > 5) this.drag.moved = true;
      this.canvas.style.cursor = "col-resize";
      this.draw();
      this.onHover(null);
      return;
    }
    const point = this.nearest(x, y);
    this.hover = point;
    if (point) {
      this.canvas.style.cursor = "pointer";
      this.onHover(point, event.clientX, event.clientY);
    } else {
      this.canvas.style.cursor = "crosshair";
      this.onHover(null);
    }
    this.draw();
  }

  onPointerUp(event) {
    if (!this.drag) return;
    const { x } = this.localPoint(event);
    const drag = this.drag;
    this.drag = null;
    this.canvas.style.cursor = "crosshair";

    if (drag.moved) {
      const t0 = Math.min(this.xToTime(drag.startX), this.xToTime(x));
      const t1 = Math.max(this.xToTime(drag.startX), this.xToTime(x));
      if (t1 - t0 > 1000) this.onBrush({ t0, t1 });
    } else {
      const point = this.nearest(x, PAD.top + 1);
      this.onSelect(point);
    }
    this.draw();
  }

  draw() {
    if (!this.ctx) return;
    const { ctx, width, height } = this;
    const domain = this.data.domain;
    const brush = this.data.brush;
    const foreground = cssVar("--text", "#e9f1ff");
    const muted = cssVar("--muted", "#93a6c2");
    const faint = cssVar("--faint", "#657a99");
    const grid = cssVar("--grid-line", "rgba(120,160,220,.1)");
    const accent = cssVar("--accent", "#4cd7ff");
    const panel = cssVar("--bg-deep", "#03060b");

    ctx.clearRect(0, 0, width, height);

    if (!domain || !this.data.series?.length) {
      ctx.fillStyle = muted;
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No timeline data for this view", width / 2, height / 2);
      return;
    }

    const valueDomain = this.valueDomain();
    this.data.valueDomain = valueDomain;
    const span = domain.t1 - domain.t0;
    const plotBottom = height - PAD.bottom;
    const plotRight = width - PAD.right;

    // Horizontal grid + price labels.
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 2; i += 1) {
      const ratio = i / 2;
      const y = PAD.top + ratio * (plotBottom - PAD.top);
      const value = valueDomain.max - ratio * (valueDomain.max - valueDomain.min);
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y + 0.5);
      ctx.lineTo(plotRight, y + 0.5);
      ctx.stroke();
      ctx.fillStyle = faint;
      ctx.textAlign = "right";
      ctx.fillText(Math.abs(value) >= 1000 ? value.toFixed(0) : value.toFixed(1), PAD.left - 7, y);
    }

    // Time grid + labels.
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const tickCount = width < 560 ? 3 : 5;
    for (let i = 0; i <= tickCount; i += 1) {
      const ratio = i / tickCount;
      const x = PAD.left + ratio * (plotRight - PAD.left);
      const t = domain.t0 + ratio * span;
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, PAD.top);
      ctx.lineTo(x + 0.5, plotBottom);
      ctx.stroke();
      ctx.fillStyle = faint;
      const align = i === 0 ? "left" : i === tickCount ? "right" : "center";
      ctx.textAlign = align;
      ctx.fillText(niceTimeLabel(t, span), x, plotBottom + 4);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top - 2, plotRight - PAD.left, plotBottom - PAD.top + 4);
    ctx.clip();

    // Series fills and lines.
    for (const line of this.data.series) {
      if (line.points.length < 2) {
        for (const point of line.points) {
          ctx.beginPath();
          ctx.arc(this.pointToX(point.t), this.valueToY(point.v ?? point.p), 2.5, 0, Math.PI * 2);
          ctx.fillStyle = line.color;
          ctx.fill();
        }
        continue;
      }

      const gradient = ctx.createLinearGradient(0, PAD.top, 0, plotBottom);
      gradient.addColorStop(0, `${line.color}3d`);
      gradient.addColorStop(1, `${line.color}00`);

      ctx.beginPath();
      line.points.forEach((point, index) => {
        const x = this.pointToX(point.t);
        const y = this.valueToY(point.v ?? point.p);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.lineTo(this.pointToX(line.points[line.points.length - 1].t), plotBottom);
      ctx.lineTo(this.pointToX(line.points[0].t), plotBottom);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      ctx.beginPath();
      line.points.forEach((point, index) => {
        const x = this.pointToX(point.t);
        const y = this.valueToY(point.v ?? point.p);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();

      if (line.points.length <= 48) {
        for (const point of line.points) {
          ctx.beginPath();
          ctx.arc(this.pointToX(point.t), this.valueToY(point.v ?? point.p), 1.8, 0, Math.PI * 2);
          ctx.fillStyle = line.color;
          ctx.fill();
        }
      }
    }

    // Brush shading.
    if (brush) {
      const x0 = this.pointToX(brush.t0);
      const x1 = this.pointToX(brush.t1);
      ctx.fillStyle = panel;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(PAD.left, PAD.top, Math.max(0, x0 - PAD.left), plotBottom - PAD.top);
      ctx.fillRect(x1, PAD.top, Math.max(0, plotRight - x1), plotBottom - PAD.top);
      ctx.globalAlpha = 1;
      ctx.fillStyle = `${accent}24`;
      ctx.fillRect(x0, PAD.top, x1 - x0, plotBottom - PAD.top);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, PAD.top);
      ctx.lineTo(x0, plotBottom);
      ctx.moveTo(x1, PAD.top);
      ctx.lineTo(x1, plotBottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Live drag overlay.
    if (this.drag && this.drag.moved) {
      const x0 = Math.min(this.drag.startX, this.drag.currentX);
      const x1 = Math.max(this.drag.startX, this.drag.currentX);
      ctx.fillStyle = `${accent}26`;
      ctx.fillRect(x0, PAD.top, x1 - x0, plotBottom - PAD.top);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, PAD.top + 0.5, x1 - x0, plotBottom - PAD.top - 1);
    }

    // Playhead.
    if (this.data.playhead != null) {
      const x = this.pointToX(this.data.playhead);
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      for (const line of this.data.series) {
        let best = null;
        for (const point of line.points) {
          if (point.t <= this.data.playhead && (!best || point.t > best.t)) best = point;
        }
        if (!best) continue;
        const px = this.pointToX(best.t);
        const py = this.valueToY(best.v ?? best.p);
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fillStyle = panel;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = line.color;
        ctx.stroke();
      }
    }

    // Selection ring.
    if (this.data.selected) {
      const selected = this.data.selected;
      const x = this.pointToX(selected.t);
      const y = this.valueToY(selected.v ?? selected.p);
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.strokeStyle = foreground;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fillStyle = foreground;
      ctx.fill();
    }

    // Hover crosshair.
    if (this.hover) {
      const x = this.pointToX(this.hover.t);
      const y = this.valueToY(this.hover.v ?? this.hover.p);
      ctx.strokeStyle = `${foreground}55`;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, plotBottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = foreground;
      ctx.fill();
    }

    ctx.restore();
  }
}

export class DistributionChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = null;
    this.data = { series: [], bins: 18 };
    this.resize();
  }

  resize() {
    const { ctx, width, height } = setupCanvas(this.canvas);
    this.ctx = ctx;
    this.width = width;
    this.height = height;
    this.draw();
  }

  setData(data) {
    this.data = { ...this.data, ...data };
    this.draw();
  }

  draw() {
    if (!this.ctx) return;
    const { ctx, width, height } = this;
    const faint = cssVar("--faint", "#657a99");
    const grid = cssVar("--grid-line", "rgba(120,160,220,.1)");
    ctx.clearRect(0, 0, width, height);

    const series = (this.data.series || []).filter((line) => line.points.length);
    if (!series.length) {
      ctx.fillStyle = faint;
      ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No distribution for this view", width / 2, height / 2);
      return;
    }

    let min = Infinity;
    let max = -Infinity;
    for (const line of series) {
      for (const point of line.points) {
        const value = point.v ?? point.p;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.05;
    min -= pad;
    max += pad;

    const bins = Math.max(8, Math.min(this.data.bins || 18, Math.floor(width / 12)));
    const counts = series.map(() => new Array(bins).fill(0));
    const binWidth = (max - min) / bins;
    for (let s = 0; s < series.length; s += 1) {
      for (const point of series[s].points) {
        let index = Math.floor(((point.v ?? point.p) - min) / binWidth);
        if (index < 0) index = 0;
        if (index >= bins) index = bins - 1;
        counts[s][index] += 1;
      }
    }
    const peak = Math.max(1, ...counts.flat());

    const top = 6;
    const bottom = height - 16;
    const left = 2;
    const right = width - 2;
    const plotWidth = right - left;

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, bottom + 0.5);
    ctx.lineTo(right, bottom + 0.5);
    ctx.stroke();

    const barGroup = plotWidth / bins;
    const barWidth = Math.max(1.5, (barGroup - 2) / series.length);
    for (let b = 0; b < bins; b += 1) {
      for (let s = 0; s < series.length; s += 1) {
        const count = counts[s][b];
        if (!count) continue;
        const h = Math.max(1.5, (count / peak) * (bottom - top));
        const x = left + b * barGroup + 1 + s * barWidth;
        const y = bottom - h;
        const gradient = ctx.createLinearGradient(0, y, 0, bottom);
        gradient.addColorStop(0, series[s].color);
        gradient.addColorStop(1, `${series[s].color}22`);
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, Math.max(1, barWidth - 1), h);
      }
    }

    ctx.fillStyle = faint;
    ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    ctx.fillText(min.toFixed(1), left, height);
    ctx.textAlign = "right";
    ctx.fillText(max.toFixed(1), right, height);
  }
}
