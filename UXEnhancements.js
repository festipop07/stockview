/**
 * UXEnhancements.js
 * ─────────────────────────────────────────────────────────────────
 * Mejoras de UX para la plataforma bursátil:
 *
 *   1. ExportManager   → captura la gráfica como PNG descargable
 *   2. FullscreenManager → pantalla completa del área de gráfica
 *   3. KeyboardManager  → atajos de teclado globales
 *   4. CompareManager   → superponer un segundo símbolo en la gráfica
 *   5. TooltipCrosshair → panel de datos OHLCV mejorado en hover
 * ─────────────────────────────────────────────────────────────────
 */

/* ════════════════════════════════════════════════════════════════
   1. EXPORT MANAGER
   Captura el área de gráfica como PNG usando html2canvas o
   el método nativo de Lightweight Charts (takeScreenshot).
   ════════════════════════════════════════════════════════════════ */
class ExportManager {
  /**
   * @param {IChartApi} chart     - instancia principal de Lightweight Charts
   * @param {string}    symbol    - símbolo activo (para nombre del archivo)
   * @param {string}    timeframe - timeframe activo
   */
  constructor(chart, getSymbol, getTimeframe) {
    this.chart        = chart;
    this.getSymbol    = getSymbol;
    this.getTimeframe = getTimeframe;
  }

  /** Descarga la gráfica como PNG */
  exportPNG() {
    try {
      // Lightweight Charts tiene takeScreenshot() nativo
      const canvas = this.chart.takeScreenshot();
      const symbol = this.getSymbol();
      const tf     = this.getTimeframe();
      const date   = new Date().toISOString().slice(0, 10);
      const name   = `${symbol}_${tf}_${date}.png`;

      // Convertir ImageData a canvas descargable
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width  = canvas.width;
      tmpCanvas.height = canvas.height;
      const ctx = tmpCanvas.getContext('2d');
      ctx.putImageData(canvas, 0, 0);

      const link = document.createElement('a');
      link.download = name;
      link.href = tmpCanvas.toDataURL('image/png');
      link.click();

      return true;
    } catch (e) {
      console.error('Export error:', e);
      return false;
    }
  }
}


/* ════════════════════════════════════════════════════════════════
   2. FULLSCREEN MANAGER
   Alterna pantalla completa en el área de gráfica.
   Maneja el evento fullscreenchange para actualizar el ícono.
   ════════════════════════════════════════════════════════════════ */
class FullscreenManager {
  /**
   * @param {HTMLElement} target    - elemento a maximizar (#chart-area)
   * @param {HTMLElement} btnEl     - botón de toggle (para cambiar ícono)
   * @param {function}    onResize  - callback para re-calcular tamaños de chart
   */
  constructor(target, btnEl, onResize) {
    this.target   = target;
    this.btnEl    = btnEl;
    this.onResize = onResize;
    this._active  = false;

    // Escuchar cambios de pantalla completa del navegador
    document.addEventListener('fullscreenchange',      () => this._onChange());
    document.addEventListener('webkitfullscreenchange',() => this._onChange());
    document.addEventListener('mozfullscreenchange',   () => this._onChange());
  }

  toggle() {
    if (!this._active) {
      (this.target.requestFullscreen ||
       this.target.webkitRequestFullscreen ||
       this.target.mozRequestFullScreen).call(this.target);
    } else {
      (document.exitFullscreen ||
       document.webkitExitFullscreen ||
       document.mozCancelFullScreen).call(document);
    }
  }

  _onChange() {
    this._active = !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement
    );
    if (this.btnEl) {
      this.btnEl.title = this._active ? 'Salir de pantalla completa (F)' : 'Pantalla completa (F)';
      this.btnEl.querySelector('.fs-icon').textContent = this._active ? '⛶' : '⛶';
      this.btnEl.classList.toggle('active', this._active);
    }
    // Esperar un frame para que el DOM se actualice
    requestAnimationFrame(() => { if (this.onResize) this.onResize(); });
  }

  get isActive() { return this._active; }
}


/* ════════════════════════════════════════════════════════════════
   3. KEYBOARD MANAGER
   Atajos de teclado globales para la plataforma.
   No activa shortcuts cuando el foco está en un input.
   ════════════════════════════════════════════════════════════════ */
class KeyboardManager {
  /**
   * @param {object} actions - mapa de { key: fn } con las acciones
   * Ejemplo: { 'f': () => fullscreen.toggle(), '1': () => setTF('1') }
   */
  constructor(actions) {
    this.actions = actions;
    this._handler = this._onKey.bind(this);
    document.addEventListener('keydown', this._handler);
  }

  _onKey(e) {
    // Ignorar si el foco está en un input/textarea
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const fn = this.actions[e.key.toLowerCase()];
    if (fn) { e.preventDefault(); fn(e); }
  }

  /** Actualizar o agregar un atajo */
  set(key, fn) { this.actions[key.toLowerCase()] = fn; }

  destroy() { document.removeEventListener('keydown', this._handler); }
}


/* ════════════════════════════════════════════════════════════════
   4. COMPARE MANAGER
   Superpone un segundo símbolo en la gráfica principal como
   línea porcentual (base 0 = precio de inicio del rango visible).
   ════════════════════════════════════════════════════════════════ */
class CompareManager {
  /**
   * @param {IChartApi}  chart       - instancia principal
   * @param {function}   fetchFn     - async (symbol, tf) => candles[]
   * @param {function}   getTimeframe
   */
  constructor(chart, fetchFn, getTimeframe) {
    this.chart        = chart;
    this.fetchFn      = fetchFn;
    this.getTimeframe = getTimeframe;
    this.series       = null;   // LineSeries del símbolo comparado
    this.symbol       = null;   // símbolo comparado activo
    this.basePrice    = null;   // precio base del símbolo primario
  }

  /**
   * Agrega o reemplaza el símbolo de comparación.
   * @param {string}   compareSymbol   - símbolo a superponer
   * @param {number}   primaryBase     - precio de cierre inicial del símbolo primario
   */
  async add(compareSymbol, primaryBase) {
    this.remove(); // limpiar anterior
    this.symbol    = compareSymbol;
    this.basePrice = primaryBase;

    try {
      const candles = await this.fetchFn(compareSymbol, this.getTimeframe());
      if (!candles.length) return false;

      const base = candles[0].close;
      // Normalizar: cada punto = % cambio respecto al primer cierre
      const data = candles.map(c => ({
        time:  c.time,
        value: ((c.close - base) / base) * 100,
      }));

      this.series = this.chart.addLineSeries({
        color:     '#f97316',
        lineWidth: 1.5,
        priceFormat: { type: 'percent', precision: 2 },
        lastValueVisible: true,
        priceScaleId: 'compare',
        title: compareSymbol,
      });
      this.chart.priceScale('compare').applyOptions({
        scaleMargins: { top: 0.1, bottom: 0.1 },
        visible: true,
        borderColor: 'rgba(255,255,255,0.07)',
      });
      this.series.setData(data);
      return true;
    } catch (e) {
      console.error('CompareManager.add:', e);
      return false;
    }
  }

  /** Elimina la serie de comparación */
  remove() {
    if (this.series) {
      try { this.chart.removeSeries(this.series); } catch {}
      this.series  = null;
      this.symbol  = null;
    }
  }

  /** Actualiza el precio en tiempo real del símbolo comparado */
  updateRealtime(price, time) {
    if (!this.series || !this.basePrice) return;
    try {
      this.series.update({
        time,
        value: ((price - this.basePrice) / this.basePrice) * 100,
      });
    } catch {}
  }

  get isActive() { return !!this.series; }
}


/* ════════════════════════════════════════════════════════════════
   5. SHORTCUTS HELP PANEL
   Panel flotante con la lista de atajos de teclado.
   ════════════════════════════════════════════════════════════════ */
class ShortcutsPanel {
  constructor() {
    this._el = null;
    this._visible = false;
  }

  _build() {
    const shortcuts = [
      { keys: ['1','2','3','4','5','6','7'], desc: 'Timeframes (1m, 5m, 15m, 1h, 1D, 1W, 1M)' },
      { keys: ['C'],   desc: 'Tipo de gráfica → Velas' },
      { keys: ['L'],   desc: 'Tipo de gráfica → Línea' },
      { keys: ['A'],   desc: 'Tipo de gráfica → Área' },
      { keys: ['F'],   desc: 'Pantalla completa' },
      { keys: ['P'],   desc: 'Exportar PNG' },
      { keys: ['R'],   desc: 'Indicador RSI' },
      { keys: ['M'],   desc: 'Indicador MACD' },
      { keys: ['B'],   desc: 'Bandas de Bollinger' },
      { keys: ['T'],   desc: 'Herramienta: Línea de tendencia' },
      { keys: ['H'],   desc: 'Herramienta: Línea horizontal' },
      { keys: ['Z'],   desc: 'Herramienta: Fibonacci' },
      { keys: ['Esc'], desc: 'Cancelar herramienta / Deseleccionar' },
      { keys: ['Del'], desc: 'Eliminar dibujo seleccionado' },
      { keys: ['?'],   desc: 'Mostrar/ocultar esta ayuda' },
    ];

    const el = document.createElement('div');
    el.id = 'shortcuts-panel';
    el.innerHTML = `
      <div class="sp-header">
        <span>Atajos de teclado</span>
        <button onclick="document.getElementById('shortcuts-panel').remove()" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:16px;">✕</button>
      </div>
      <div class="sp-body">
        ${shortcuts.map(s => `
          <div class="sp-row">
            <div class="sp-keys">${s.keys.map(k => `<kbd>${k}</kbd>`).join(' ')}</div>
            <div class="sp-desc">${s.desc}</div>
          </div>`).join('')}
      </div>
    `;
    // Estilos inline para no depender de CSS externo
    Object.assign(el.style, {
      position: 'fixed', bottom: '24px', right: '24px',
      background: 'var(--bg2)', border: '1px solid var(--border2)',
      borderRadius: '12px', zIndex: '999', width: '360px',
      boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
      fontFamily: 'var(--sans)', fontSize: '12px', color: 'var(--text0)',
      animation: 'slideIn 0.2s ease',
    });
    document.body.appendChild(el);

    // Estilos de los elementos internos via <style> dinámico
    if (!document.getElementById('sp-styles')) {
      const style = document.createElement('style');
      style.id = 'sp-styles';
      style.textContent = `
        #shortcuts-panel .sp-header {
          display:flex; align-items:center; justify-content:space-between;
          padding:12px 16px; border-bottom:1px solid var(--border);
          font-weight:600; font-size:13px;
        }
        #shortcuts-panel .sp-body { padding:8px 0; max-height:60vh; overflow-y:auto; }
        #shortcuts-panel .sp-row {
          display:flex; align-items:center; gap:12px;
          padding:5px 16px; transition:background 0.1s;
        }
        #shortcuts-panel .sp-row:hover { background:var(--bg3); }
        #shortcuts-panel .sp-keys { display:flex; gap:4px; min-width:80px; }
        #shortcuts-panel .sp-desc { color:var(--text1); }
        #shortcuts-panel kbd {
          background:var(--bg4); border:1px solid var(--border2);
          border-radius:4px; padding:1px 6px; font-family:var(--mono);
          font-size:10px; color:var(--text0); white-space:nowrap;
        }
      `;
      document.head.appendChild(style);
    }
    return el;
  }

  toggle() {
    const existing = document.getElementById('shortcuts-panel');
    if (existing) { existing.remove(); this._visible = false; }
    else { this._build(); this._visible = true; }
  }
}
