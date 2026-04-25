/**
 * DrawingTools.js
 * ─────────────────────────────────────────────────────────────────
 * Herramientas de dibujo técnico sobre Lightweight Charts.
 *
 * Estrategia: canvas overlay sobre el contenedor del chart principal.
 * Convierte coordenadas pixel ↔ precio/tiempo usando las APIs de
 * Lightweight Charts (priceToCoordinate / timeToCoordinate).
 *
 * Herramientas implementadas:
 *   - trendline   → línea entre dos puntos (precio/tiempo)
 *   - hline       → línea horizontal (nivel precio fijo)
 *   - fibonacci   → retroceso de Fibonacci entre dos puntos
 *   - text        → anotación de texto
 *
 * Uso:
 *   const dt = new DrawingTools(mainChart, chartContainer, symbol);
 *   dt.setTool('trendline');   // activa herramienta
 *   dt.setTool(null);          // modo selección/pan
 *   dt.clear();                // borra todos los dibujos del símbolo
 * ─────────────────────────────────────────────────────────────────
 */

class DrawingTools {
  /**
   * @param {IChartApi} chart       - instancia de Lightweight Charts
   * @param {HTMLElement} container - div contenedor del chart principal
   * @param {string} symbol         - símbolo activo (para persistencia)
   */
  constructor(chart, container, symbol) {
    this.chart     = chart;
    this.container = container;
    this.symbol    = symbol;
    this.activeTool = null;   // 'trendline' | 'hline' | 'fibonacci' | 'text' | null

    this.drawings  = [];      // Array de objetos Drawing
    this.drawing   = false;   // true mientras se está dibujando
    this.startPt   = null;    // punto inicial del dibujo en curso
    this.hoveredId = null;    // id del dibujo bajo el cursor
    this.selectedId = null;   // id del dibujo seleccionado (para eliminar)

    this._initCanvas();
    this._bindEvents();
    this._loadFromStorage();
  }

  /* ──────────────────────────────────────────────────────────────
     CANVAS OVERLAY
  ────────────────────────────────────────────────────────────── */

  _initCanvas() {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      pointer-events: none;
      z-index: 10;
    `;
    this.container.style.position = 'relative';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // Ajustar tamaño al container
    this._resizeCanvas();
    this._ro = new ResizeObserver(() => { this._resizeCanvas(); this.redraw(); });
    this._ro.observe(this.container);
  }

  _resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.offsetWidth;
    const h = this.container.offsetHeight;
    this.canvas.width  = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width  = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ──────────────────────────────────────────────────────────────
     EVENTOS DE MOUSE
  ────────────────────────────────────────────────────────────── */

  _bindEvents() {
    // El canvas tiene pointer-events:none, escuchamos en el container
    this._onMouseDown = this._mouseDown.bind(this);
    this._onMouseMove = this._mouseMove.bind(this);
    this._onMouseUp   = this._mouseUp.bind(this);
    this._onDblClick  = this._dblClick.bind(this);
    this._onKeyDown   = this._keyDown.bind(this);

    this.container.addEventListener('mousedown',  this._onMouseDown);
    this.container.addEventListener('mousemove',  this._onMouseMove);
    this.container.addEventListener('mouseup',    this._onMouseUp);
    this.container.addEventListener('dblclick',   this._onDblClick);
    document.addEventListener('keydown', this._onKeyDown);

    // Re-dibujar cuando el chart se desplaza/escala
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.redraw());
    this.chart.subscribeCrosshairMove(() => this.redraw());
  }

  _getMousePriceTime(e) {
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const price = this._yToPrice(y);
    const time  = this._xToTime(x);
    return { x, y, price, time };
  }

  _mouseDown(e) {
    if (!this.activeTool) {
      // Modo selección: detectar dibujo bajo cursor
      const { x, y } = this._getMousePriceTime(e);
      this.selectedId = this._hitTest(x, y);
      this.redraw();
      return;
    }

    const pt = this._getMousePriceTime(e);
    if (!pt.price || !pt.time) return;

    if (this.activeTool === 'hline') {
      // Una sola pulsación define la línea horizontal
      this._addDrawing({
        type: 'hline',
        price: pt.price,
        color: this._toolColor(),
      });
      this.redraw();
      return;
    }

    if (this.activeTool === 'text') {
      const label = prompt('Texto de la anotación:');
      if (!label) return;
      this._addDrawing({
        type: 'text',
        price: pt.price,
        time:  pt.time,
        label,
        color: this._toolColor(),
      });
      this.redraw();
      return;
    }

    // trendline / fibonacci — primer clic
    this.drawing = true;
    this.startPt = pt;
  }

  _mouseMove(e) {
    const pt = this._getMousePriceTime(e);

    if (this.activeTool) {
      this.canvas.style.pointerEvents = 'none';
      // Cambiar cursor del container
      this.container.style.cursor = 'crosshair';
    } else {
      this.container.style.cursor = 'default';
    }

    if (this.drawing && this.startPt) {
      this._endPt = pt;
      this.redraw();
      // Dibujar preview
      this._drawPreview(this.startPt, pt);
    } else {
      // Hover hit-test
      const hovered = this._hitTest(pt.x, pt.y);
      if (hovered !== this.hoveredId) {
        this.hoveredId = hovered;
        this.container.style.cursor = hovered && !this.activeTool ? 'pointer' : (this.activeTool ? 'crosshair' : 'default');
        this.redraw();
      }
    }
  }

  _mouseUp(e) {
    if (!this.drawing || !this.startPt) return;
    const pt = this._getMousePriceTime(e);
    if (!pt.price || !pt.time) { this.drawing = false; return; }

    // No guardar si es el mismo punto
    const dx = Math.abs(pt.x - this.startPt.x);
    const dy = Math.abs(pt.y - this.startPt.y);
    if (dx < 5 && dy < 5) { this.drawing = false; return; }

    if (this.activeTool === 'trendline') {
      this._addDrawing({
        type:   'trendline',
        p1:     { price: this.startPt.price, time: this.startPt.time },
        p2:     { price: pt.price, time: pt.time },
        color:  this._toolColor(),
        extend: false,
      });
    } else if (this.activeTool === 'fibonacci') {
      this._addDrawing({
        type:  'fibonacci',
        p1:    { price: this.startPt.price, time: this.startPt.time },
        p2:    { price: pt.price, time: pt.time },
        color: this._toolColor(),
      });
    }

    this.drawing = false;
    this.startPt = null;
    this._endPt  = null;
    this.redraw();
    this._saveToStorage();
  }

  _dblClick(e) {
    if (this.selectedId !== null) {
      this.drawings = this.drawings.filter(d => d.id !== this.selectedId);
      this.selectedId = null;
      this.redraw();
      this._saveToStorage();
    }
  }

  _keyDown(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId !== null) {
      this.drawings = this.drawings.filter(d => d.id !== this.selectedId);
      this.selectedId = null;
      this.redraw();
      this._saveToStorage();
    }
    if (e.key === 'Escape') {
      this.drawing = false;
      this.startPt = null;
      this.selectedId = null;
      this.redraw();
    }
  }

  /* ──────────────────────────────────────────────────────────────
     CONVERSIÓN COORDENADAS
  ────────────────────────────────────────────────────────────── */

  _priceToY(price) {
    try {
      const series = this.chart.series ? this.chart.series()[0] : null;
      // Lightweight Charts v4: usar priceToCoordinate de la primera serie
      // Accedemos via la serie principal guardada externamente
      if (window._mainSeriesRef) {
        return window._mainSeriesRef.priceToCoordinate(price);
      }
      return null;
    } catch { return null; }
  }

  _yToPrice(y) {
    try {
      if (window._mainSeriesRef) {
        return window._mainSeriesRef.coordinateToPrice(y);
      }
      return null;
    } catch { return null; }
  }

  _timeToX(time) {
    try {
      return this.chart.timeScale().timeToCoordinate(time);
    } catch { return null; }
  }

  _xToTime(x) {
    try {
      return this.chart.timeScale().coordinateToTime(x);
    } catch { return null; }
  }

  /* ──────────────────────────────────────────────────────────────
     HIT-TEST (detectar dibujo bajo el cursor)
  ────────────────────────────────────────────────────────────── */

  _hitTest(mx, my) {
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];
      if (this._drawingContainsPoint(d, mx, my)) return d.id;
    }
    return null;
  }

  _drawingContainsPoint(d, mx, my) {
    const TOLERANCE = 8;
    if (d.type === 'hline') {
      const y = this._priceToY(d.price);
      if (y == null) return false;
      return Math.abs(my - y) < TOLERANCE;
    }
    if (d.type === 'trendline' || d.type === 'fibonacci') {
      const x1 = this._timeToX(d.p1.time), y1 = this._priceToY(d.p1.price);
      const x2 = this._timeToX(d.p2.time), y2 = this._priceToY(d.p2.price);
      if (x1 == null || x2 == null) return false;
      return this._pointNearSegment(mx, my, x1, y1, x2, y2, TOLERANCE);
    }
    if (d.type === 'text') {
      const x = this._timeToX(d.time), y = this._priceToY(d.price);
      if (x == null || y == null) return false;
      return Math.abs(mx - x) < 60 && Math.abs(my - y) < 16;
    }
    return false;
  }

  _pointNearSegment(px, py, x1, y1, x2, y2, tol) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx*dx + dy*dy;
    if (len2 === 0) return Math.hypot(px-x1, py-y1) < tol;
    let t = ((px-x1)*dx + (py-y1)*dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const nx = x1 + t*dx, ny = y1 + t*dy;
    return Math.hypot(px-nx, py-ny) < tol;
  }

  /* ──────────────────────────────────────────────────────────────
     DIBUJO EN CANVAS
  ────────────────────────────────────────────────────────────── */

  redraw() {
    const ctx = this.ctx;
    const w = this.canvas.offsetWidth;
    const h = this.canvas.offsetHeight;
    ctx.clearRect(0, 0, w, h);

    for (const d of this.drawings) {
      const isSelected = d.id === this.selectedId;
      const isHovered  = d.id === this.hoveredId;
      this._renderDrawing(d, isSelected, isHovered);
    }
  }

  _renderDrawing(d, selected, hovered) {
    const ctx = this.ctx;
    const alpha = selected ? 1 : hovered ? 0.9 : 0.75;
    const lw    = selected ? 2 : 1.5;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = d.color || '#3b82f6';
    ctx.lineWidth   = lw;
    ctx.setLineDash([]);

    if (d.type === 'hline') {
      const y = this._priceToY(d.price);
      if (y == null) { ctx.restore(); return; }
      ctx.beginPath();
      ctx.setLineDash([6, 4]);
      ctx.moveTo(0, y);
      ctx.lineTo(this.canvas.offsetWidth, y);
      ctx.stroke();
      // Etiqueta precio
      this._drawLabel(ctx, '$' + d.price.toFixed(2), this.canvas.offsetWidth - 70, y - 6, d.color);

    } else if (d.type === 'trendline') {
      const x1 = this._timeToX(d.p1.time), y1 = this._priceToY(d.p1.price);
      const x2 = this._timeToX(d.p2.time), y2 = this._priceToY(d.p2.price);
      if (x1 == null || x2 == null) { ctx.restore(); return; }
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      // Puntos en extremos
      this._drawDot(ctx, x1, y1, d.color, selected);
      this._drawDot(ctx, x2, y2, d.color, selected);

    } else if (d.type === 'fibonacci') {
      this._renderFibonacci(d, ctx, selected);

    } else if (d.type === 'text') {
      const x = this._timeToX(d.time), y = this._priceToY(d.price);
      if (x == null || y == null) { ctx.restore(); return; }
      ctx.fillStyle = d.color;
      ctx.font = 'bold 11px "Space Mono", monospace';
      ctx.fillText(d.label, x + 6, y - 6);
      this._drawDot(ctx, x, y, d.color, selected);
    }

    ctx.restore();
  }

  _renderFibonacci(d, ctx, selected) {
    const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const FIB_COLORS = [
      'rgba(229,72,77,0.8)',   // 0%
      'rgba(251,146,60,0.8)',  // 23.6%
      'rgba(250,204,21,0.8)',  // 38.2%
      'rgba(74,222,128,0.8)',  // 50%
      'rgba(59,130,246,0.8)',  // 61.8%
      'rgba(167,139,250,0.8)', // 78.6%
      'rgba(229,72,77,0.8)',   // 100%
    ];

    const x1 = this._timeToX(d.p1.time), y1 = this._priceToY(d.p1.price);
    const x2 = this._timeToX(d.p2.time), y2 = this._priceToY(d.p2.price);
    if (x1 == null || x2 == null) return;

    const priceDiff = d.p2.price - d.p1.price;
    const xMin = Math.min(x1, x2);
    const xMax = Math.max(x1, x2);
    const W = this.canvas.offsetWidth;

    FIB_LEVELS.forEach((level, i) => {
      const price = d.p2.price - priceDiff * level;
      const y = this._priceToY(price);
      if (y == null) return;

      ctx.save();
      ctx.strokeStyle = FIB_COLORS[i];
      ctx.lineWidth   = selected ? 1.5 : 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.restore();

      // Etiqueta
      ctx.save();
      ctx.font = '10px "Space Mono", monospace';
      ctx.fillStyle = FIB_COLORS[i];
      ctx.globalAlpha = 0.9;
      ctx.fillText(`${(level * 100).toFixed(1)}%  $${price.toFixed(2)}`, 8, y - 4);
      ctx.restore();
    });

    // Línea diagonal de referencia
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();

    this._drawDot(ctx, x1, y1, '#fff', selected);
    this._drawDot(ctx, x2, y2, '#fff', selected);
  }

  _drawPreview(p1, p2) {
    if (!p1 || !p2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = this._toolColor();
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([5, 3]);

    if (this.activeTool === 'trendline') {
      const x1 = this._timeToX(p1.time) || p1.x;
      const y1 = this._priceToY(p1.price) || p1.y;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    } else if (this.activeTool === 'fibonacci') {
      const x1 = this._timeToX(p1.time) || p1.x;
      const y1 = this._priceToY(p1.price) || p1.y;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      // Mostrar niveles fib en preview
      const priceDiff = (p2.price || 0) - p1.price;
      const W = this.canvas.offsetWidth;
      [0.236, 0.382, 0.5, 0.618].forEach(lvl => {
        const price = p1.price + priceDiff * lvl;
        const y = this._priceToY(price);
        if (!y) return;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      });
    }
    ctx.restore();
  }

  _drawLabel(ctx, text, x, y, color) {
    ctx.save();
    ctx.font = '10px "Space Mono", monospace';
    ctx.fillStyle = color || '#3b82f6';
    ctx.globalAlpha = 0.85;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  _drawDot(ctx, x, y, color, filled = false) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, filled ? 5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = filled ? color : 'var(--bg0, #0d0e11)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /* ──────────────────────────────────────────────────────────────
     GESTIÓN DE DIBUJOS
  ────────────────────────────────────────────────────────────── */

  _addDrawing(data) {
    const id = Date.now() + Math.random();
    this.drawings.push({ id, ...data });
    this._saveToStorage();
    return id;
  }

  _toolColor() {
    const colors = {
      trendline: '#3b82f6',
      hline:     '#26a876',
      fibonacci: '#a78bfa',
      text:      '#f97316',
    };
    return colors[this.activeTool] || '#3b82f6';
  }

  /* ──────────────────────────────────────────────────────────────
     HERRAMIENTA ACTIVA
  ────────────────────────────────────────────────────────────── */

  setTool(tool) {
    this.activeTool = tool;
    this.drawing    = false;
    this.startPt    = null;
    this.container.style.cursor = tool ? 'crosshair' : 'default';
  }

  /* ──────────────────────────────────────────────────────────────
     PERSISTENCIA EN LOCALSTORAGE
  ────────────────────────────────────────────────────────────── */

  _storageKey() { return `drawings_${this.symbol}`; }

  _saveToStorage() {
    try {
      localStorage.setItem(this._storageKey(), JSON.stringify(this.drawings));
    } catch (e) { console.warn('DrawingTools: no se pudo guardar en localStorage', e); }
  }

  _loadFromStorage() {
    try {
      const raw = localStorage.getItem(this._storageKey());
      if (raw) {
        this.drawings = JSON.parse(raw);
        setTimeout(() => this.redraw(), 300); // esperar a que el chart cargue datos
      }
    } catch {}
  }

  /* ──────────────────────────────────────────────────────────────
     API PÚBLICA
  ────────────────────────────────────────────────────────────── */

  /** Borra todos los dibujos del símbolo activo */
  clear() {
    this.drawings = [];
    this.selectedId = null;
    this.redraw();
    this._saveToStorage();
  }

  /** Carga dibujos para un símbolo diferente (al cambiar símbolo) */
  setSymbol(symbol) {
    this.symbol   = symbol;
    this.drawings = [];
    this.selectedId = null;
    this._loadFromStorage();
  }

  /** Destruye el módulo y limpia event listeners */
  destroy() {
    this.container.removeEventListener('mousedown',  this._onMouseDown);
    this.container.removeEventListener('mousemove',  this._onMouseMove);
    this.container.removeEventListener('mouseup',    this._onMouseUp);
    this.container.removeEventListener('dblclick',   this._onDblClick);
    document.removeEventListener('keydown', this._onKeyDown);
    this._ro.disconnect();
    this.canvas.remove();
  }
}
