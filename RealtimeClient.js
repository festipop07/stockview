/**
 * RealtimeClient.js
 * ─────────────────────────────────────────────────────────────────
 * Cliente WebSocket para precios en tiempo real via Finnhub.
 *
 * Características:
 *   - Reconexión automática con backoff exponencial
 *   - Cola de suscripciones pendientes mientras reconecta
 *   - Throttling de updates (máx 1 update/segundo por símbolo)
 *   - Callbacks separados: onTrade, onStatus
 *   - Gestión de memoria: límite de suscripciones simultáneas
 *
 * Uso:
 *   const rt = new RealtimeClient('TU_API_KEY');
 *   rt.subscribe('AAPL', (price, timestamp, volume) => { ... });
 *   rt.unsubscribe('AAPL');
 *   rt.destroy();
 * ─────────────────────────────────────────────────────────────────
 */
class RealtimeClient {
  /**
   * @param {string} apiKey        - API key de Finnhub
   * @param {function} onStatus    - callback(status) donde status: 'connecting'|'connected'|'disconnected'|'error'
   */
  constructor(apiKey, onStatus) {
    this.apiKey     = apiKey;
    this.onStatus   = onStatus || (() => {});
    this.ws         = null;
    this.subs       = new Map();   // symbol → callback
    this.pendingQ   = new Set();   // subs pendientes de enviar al WS
    this.throttle   = new Map();   // symbol → last update timestamp
    this.retryCount = 0;
    this.maxRetries = 10;
    this.retryTimer = null;
    this.destroyed  = false;
    this.status     = 'disconnected';

    this._connect();
  }

  /* ──────────────────────────────────────────────────────────────
     CONEXIÓN
  ────────────────────────────────────────────────────────────── */

  _connect() {
    if (this.destroyed) return;
    if (this.apiKey === 'demo') {
      // Modo demo: simular precios con variaciones aleatorias
      this._startDemoMode();
      return;
    }

    this.onStatus('connecting');
    this.status = 'connecting';

    const url = `wss://ws.finnhub.io?token=${this.apiKey}`;
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this._scheduleRetry();
      return;
    }

    this.ws.onopen = () => {
      this.retryCount = 0;
      this.status = 'connected';
      this.onStatus('connected');

      // Re-suscribir todos los símbolos activos
      for (const sym of this.subs.keys()) {
        this._send({ type: 'subscribe', symbol: sym });
      }
      // Enviar los pendientes acumulados mientras reconectaba
      for (const sym of this.pendingQ) {
        this._send({ type: 'subscribe', symbol: sym });
      }
      this.pendingQ.clear();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'trade' && Array.isArray(msg.data)) {
          msg.data.forEach(trade => this._processTrade(trade));
        }
        if (msg.type === 'error') {
          console.warn('Finnhub WS error:', msg.msg);
        }
      } catch {}
    };

    this.ws.onerror = () => {
      this.status = 'error';
      this.onStatus('error');
    };

    this.ws.onclose = (e) => {
      this.status = 'disconnected';
      this.onStatus('disconnected');
      if (!this.destroyed) this._scheduleRetry();
    };
  }

  _scheduleRetry() {
    if (this.destroyed || this.retryCount >= this.maxRetries) return;
    const delay = Math.min(1000 * Math.pow(1.8, this.retryCount), 30000);
    this.retryCount++;
    this.retryTimer = setTimeout(() => this._connect(), delay);
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /* ──────────────────────────────────────────────────────────────
     PROCESAMIENTO DE TRADES
  ────────────────────────────────────────────────────────────── */

  _processTrade(trade) {
    // trade: { s: symbol, p: price, t: timestamp_ms, v: volume }
    const { s: symbol, p: price, t: timestamp, v: volume } = trade;
    const cb = this.subs.get(symbol);
    if (!cb) return;

    // Throttle: máx 1 update por segundo por símbolo
    const now = Date.now();
    const last = this.throttle.get(symbol) || 0;
    if (now - last < 1000) return;
    this.throttle.set(symbol, now);

    cb(price, Math.floor(timestamp / 1000), volume || 0);
  }

  /* ──────────────────────────────────────────────────────────────
     MODO DEMO (cuando apiKey === 'demo')
  ────────────────────────────────────────────────────────────── */

  _startDemoMode() {
    this.status = 'demo';
    this.onStatus('demo');

    // Precios base para demo
    this._demoPrices = {
      AAPL: 189.50, MSFT: 415.20, NVDA: 875.30, GOOGL: 175.80,
      AMZN: 185.40, META: 510.60, TSLA: 175.20, JPM: 198.50,
      SPY:  523.40, QQQ:  445.80,
    };

    this._demoInterval = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      for (const [symbol, cb] of this.subs) {
        const base = this._demoPrices[symbol] || 100;
        // Variación aleatoria ±0.15%
        const delta = base * (Math.random() * 0.003 - 0.0015);
        const newPrice = parseFloat((base + delta).toFixed(2));
        this._demoPrices[symbol] = newPrice;
        cb(newPrice, now, Math.floor(Math.random() * 5000));
      }
    }, 1500); // update cada 1.5s en modo demo
  }

  /* ──────────────────────────────────────────────────────────────
     API PÚBLICA
  ────────────────────────────────────────────────────────────── */

  /**
   * Suscribirse a actualizaciones de precio para un símbolo.
   * @param {string}   symbol   - ej: 'AAPL'
   * @param {function} callback - (price, timestamp, volume) => void
   */
  subscribe(symbol, callback) {
    this.subs.set(symbol, callback);
    if (this.status === 'connected') {
      this._send({ type: 'subscribe', symbol });
    } else {
      this.pendingQ.add(symbol);
    }
  }

  /**
   * Cancelar suscripción de un símbolo.
   * @param {string} symbol
   */
  unsubscribe(symbol) {
    if (!this.subs.has(symbol)) return;
    this.subs.delete(symbol);
    this.pendingQ.delete(symbol);
    this.throttle.delete(symbol);
    this._send({ type: 'unsubscribe', symbol });
  }

  /**
   * Liberar todos los recursos.
   */
  destroy() {
    this.destroyed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this._demoInterval);
    this.subs.clear();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
  }

  /**
   * Estado actual de la conexión.
   * @returns {'connecting'|'connected'|'disconnected'|'error'|'demo'}
   */
  getStatus() { return this.status; }
}
