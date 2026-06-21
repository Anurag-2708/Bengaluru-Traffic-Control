/* ═══════════════════════════════════════════════════════════
   GridGuard · Traffic Incident & Event Co-Pilot
   Premium Dark Operational Dashboard — Application Logic
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────
  const state = {
    map: null,
    hotspots: [],
    trendingHotspots: [],
    markerLayer: null,
    trendingLayer: null,
    highlightLayer: null,
    currentChart: null,
    currentDetailChart: null,
    activeClusterId: null,
    minSamples: 20,
    stations: [],
    stationChart: null,
    heatmapLayer: null,
    heatmapData: [],
    chatHistory: [],
    isSending: false,
  };

  // ── Helpers ───────────────────────────────────────────
  function scoreTier(score) {
    if (score >= 75) return 'critical';
    if (score >= 50) return 'high';
    return 'moderate';
  }

  function interpolateColor(color1, color2, factor) {
    const r1 = parseInt(color1.substring(1, 3), 16);
    const g1 = parseInt(color1.substring(3, 5), 16);
    const b1 = parseInt(color1.substring(5, 7), 16);

    const r2 = parseInt(color2.substring(1, 3), 16);
    const g2 = parseInt(color2.substring(3, 5), 16);
    const b2 = parseInt(color2.substring(5, 7), 16);

    const r = Math.round(r1 + factor * (r2 - r1));
    const g = Math.round(g1 + factor * (g2 - g1));
    const b = Math.round(b1 + factor * (b2 - b1));

    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
  }

  function tierColor(score) {
    const s = Math.max(0, Math.min(100, score));
    if (s < 50) {
      return interpolateColor('#4FA0D9', '#F2A33B', s / 50);
    } else {
      return interpolateColor('#F2A33B', '#E0594A', (s - 50) / 50);
    }
  }

  function tierLabel(tier) {
    const map = { critical: 'CRITICAL', high: 'HIGH', moderate: 'MODERATE' };
    return map[tier] || 'MODERATE';
  }

  function formatNum(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString('en-IN');
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // ── Clock Module ──────────────────────────────────────
  function startClock() {
    const el = document.getElementById('clock');
    if (!el) return;
    function tick() {
      const now = new Date();
      el.textContent = now.toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
    }
    tick();
    setInterval(tick, 1000);
  }

  // ── Map Module ────────────────────────────────────────
  function initMap() {
    state.map = L.map('map', {
      center: [12.97, 77.59],
      zoom: 12,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '© <a href="https://carto.com/">CARTO</a> · © <a href="https://www.openstreetmap.org/">OSM</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(state.map);

    state.markerLayer = L.layerGroup().addTo(state.map);
    state.trendingLayer = L.layerGroup().addTo(state.map);
    state.highlightLayer = L.layerGroup().addTo(state.map);
  }

  async function fetchHotspots() {
    try {
      const res = await fetch(`/api/hotspots?min_samples=${state.minSamples}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.hotspots = Array.isArray(data) ? data : (data.hotspots || []);
      renderMapMarkers();
      fetchAndRenderQueue();
    } catch (e) {
      console.error('fetchHotspots:', e);
    }
  }

  function renderMapMarkers() {
    state.markerLayer.clearLayers();

    state.hotspots.forEach(h => {
      const lat = h.latitude || h.lat;
      const lon = h.longitude || h.lon || h.lng;
      if (!lat || !lon) return;

      const score = h.composite_score || h.score || 0;
      const tier = scoreTier(score);
      const color = tierColor(score);
      const count = h.violation_count || h.violations || 0;
      const radius = 12;

      const circle = L.circleMarker([lat, lon], {
        radius: radius,
        fillColor: color,
        fillOpacity: 0.55,
        color: color,
        weight: 1.5,
        opacity: 0.8,
      });

      const name = h.label || h.name || h.location || h.hotspot_name || 'Unknown';
      const station = h.police_station || h.station || '—';
      const domType = h.dominant_violation_type || h.dominant_type || h.top_violation || '—';
      const domVehicle = h.dominant_vehicle_type || h.dominant_vehicle || h.top_vehicle || '—';
      const peakHour = h.peak_hour != null ? `${String(h.peak_hour).padStart(2, '0')}:00` : '—';

      circle.bindPopup(`
        <div class="popup-content">
          <div class="popup-title">
            <span>${esc(name)}</span>
          </div>
          <span class="popup-score" style="background:${color}22; color:${color}; border:1px solid ${color}44;">
            ${score.toFixed(1)} · ${tierLabel(tier)}
          </span>
          <div class="popup-meta">
            <span><span class="meta-label">Events</span><span class="meta-value">${formatNum(count)}</span></span>
            <span><span class="meta-label">Cause</span><span class="meta-value">${esc(domType)}</span></span>
            <span><span class="meta-label">Vehicle</span><span class="meta-value">${esc(domVehicle)}</span></span>
            <span><span class="meta-label">Peak Hour</span><span class="meta-value">${peakHour}</span></span>
            <span><span class="meta-label">Station</span><span class="meta-value">${esc(station)}</span></span>
          </div>
        </div>
      `, { maxWidth: 280 });

      circle.on('click', () => {
        showHotspotDetail(h);
      });

      circle.hotspotData = h;
      state.markerLayer.addLayer(circle);
    });
  }

  async function fetchTrendingHotspots() {
    try {
      const res = await fetch(`/api/hotspots/trending?min_samples=${state.minSamples}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.trendingHotspots = Array.isArray(data) ? data : (data.trending || data.hotspots || []);
      renderTrendingMarkers();
    } catch (e) {
      console.warn('fetchTrendingHotspots:', e);
    }
  }

  function renderTrendingMarkers() {
    state.trendingLayer.clearLayers();

    state.trendingHotspots.forEach(h => {
      const lat = h.latitude || h.lat;
      const lon = h.longitude || h.lon || h.lng;
      if (!lat || !lon) return;

      const pulseIcon = L.divIcon({
        className: '',
        html: `<div class="pulse-marker">
                 <div class="pulse-ring"></div>
                 <div class="pulse-ring-inner"></div>
               </div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });

      const marker = L.marker([lat, lon], { icon: pulseIcon });
      marker.on('click', () => {
        panToHotspot(lat, lon);
        const hs = state.hotspots.find(item => item.cluster_id === h.cluster_id);
        if (hs) {
          showHotspotDetail(hs);
        }
      });
      state.trendingLayer.addLayer(marker);
    });
  }

  function panToHotspot(lat, lon) {
    state.map.flyTo([lat, lon], 14.5, { duration: 1.2 });

    // Try to open the popup of the nearest marker
    state.markerLayer.eachLayer(layer => {
      const ll = layer.getLatLng();
      if (Math.abs(ll.lat - lat) < 0.001 && Math.abs(ll.lng - lon) < 0.001) {
        setTimeout(() => layer.openPopup(), 600);
      }
    });
  }

  function highlightHotspots(hotspotList) {
    state.highlightLayer.clearLayers();
    if (!hotspotList || !hotspotList.length) return;

    const bounds = [];
    hotspotList.forEach(h => {
      const lat = h.latitude || h.lat;
      const lon = h.longitude || h.lon || h.lng;
      if (!lat || !lon) return;

      bounds.push([lat, lon]);

      const ring = L.circleMarker([lat, lon], {
        radius: 18,
        fillColor: '#E0594A',
        fillOpacity: 0.15,
        color: '#E0594A',
        weight: 2,
        opacity: 0.6,
        dashArray: '4 4',
      });
      state.highlightLayer.addLayer(ring);
    });

    if (bounds.length) {
      state.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 14, duration: 1 });
    }
  }

  // ── Queue Module ──────────────────────────────────────
  function fetchAndRenderQueue() {
    const list = document.getElementById('queueList');
    const countBadge = document.getElementById('queueCount');
    if (!list) return;

    const sorted = [...state.hotspots].sort((a, b) => {
      return (b.composite_score || b.score || 0) - (a.composite_score || a.score || 0);
    });

    if (countBadge) countBadge.textContent = sorted.length;

    list.innerHTML = '';

    sorted.forEach((h, i) => {
      const score = h.composite_score || h.score || 0;
      const color = tierColor(score);
      const name = h.label || h.name || h.location || h.hotspot_name || 'Unknown';
      const station = h.police_station || h.station || '';
      const count = h.violation_count || h.violations || 0;
      const lat = h.latitude || h.lat;
      const lon = h.longitude || h.lon || h.lng;

      const row = document.createElement('div');
      row.className = 'queue-row fade-in';
      row.style.animationDelay = `${i * 30}ms`;
      row.innerHTML = `
        <div class="queue-rank">${i + 1}</div>
        <div class="queue-info">
          <div class="queue-name">${esc(name)}</div>
          <div class="queue-meta">${esc(station)}${station && count ? ' · ' : ''}${count ? formatNum(count) + ' events' : ''}</div>
          <div class="queue-bar-wrap">
            <div class="queue-bar" style="width:${Math.min(score, 100)}%; background:${color}"></div>
          </div>
        </div>
        <div class="queue-score" style="color:${color}">${score.toFixed(1)}</div>
      `;

      if (lat && lon) {
        row.addEventListener('click', () => {
          panToHotspot(lat, lon);
          showHotspotDetail(h);
        });
      }

      list.appendChild(row);
    });
  }

  // ── Charts Module ─────────────────────────────────────
  const CHART_TYPES = [
    { key: 'violations_by_type', label: 'By Cause' },
    { key: 'violations_by_month', label: 'Monthly' },
    { key: 'violations_by_station', label: 'By Station' },
    { key: 'violations_by_vehicle', label: 'By Vehicle' },
    { key: 'violations_by_hour', label: 'By Hour' },
    { key: 'violations_by_day_of_week', label: 'By Day' },
  ];

  const CHART_COLORS = [
    '#E0594A', '#F2A33B', '#4FA0D9', '#4FBE8E', '#9B6DD7',
    '#E87A6E', '#F4BD6E', '#7BB8E0', '#78D4AF', '#B694E5',
    '#D94F7A', '#52C5D9', '#E8B84A', '#6BBF6E', '#D97B4F',
  ];

  function initChartTypeSelector() {
    const container = document.getElementById('chartTypeSelector');
    if (!container) return;

    container.innerHTML = '';
    CHART_TYPES.forEach((ct, i) => {
      const btn = document.createElement('button');
      btn.className = 'chart-type-btn' + (i === 0 ? ' active' : '');
      btn.textContent = ct.label;
      btn.dataset.chartType = ct.key;
      btn.addEventListener('click', () => {
        container.querySelectorAll('.chart-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fetchChartData(ct.key);
      });
      container.appendChild(btn);
    });
  }

  async function fetchChartData(chartType) {
    try {
      const res = await fetch(`/api/data/charts/${chartType}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderChart(chartType, data);
    } catch (e) {
      console.error('fetchChartData:', e);
    }
  }

  function renderChart(chartType, data) {
    if (state.currentChart) {
      state.currentChart.destroy();
      state.currentChart = null;
    }

    const canvas = document.getElementById('chartCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Chart.js global defaults
    Chart.defaults.color = '#8B94A1';
    Chart.defaults.font.family = "'IBM Plex Sans', sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.padding = 14;

    const labels = data.labels || [];
    const values = data.values || data.data || [];

    let config;

    switch (chartType) {
      case 'violations_by_type':
        config = {
          type: 'doughnut',
          data: {
            labels: labels.slice(0, 10),
            datasets: [{
              data: values.slice(0, 10),
              backgroundColor: CHART_COLORS.slice(0, 10),
              borderColor: '#161B22',
              borderWidth: 2,
              hoverBorderColor: '#E7EAEE',
              hoverBorderWidth: 2,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '55%',
            plugins: {
              legend: { position: 'right', labels: { font: { size: 10 }, boxWidth: 12 } },
            },
          },
        };
        break;

      case 'violations_by_month':
        config = {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: 'Events',
              data: values,
              borderColor: '#F2A33B',
              backgroundColor: 'rgba(242,163,59,0.08)',
              borderWidth: 2.5,
              pointBackgroundColor: '#F2A33B',
              pointBorderColor: '#161B22',
              pointBorderWidth: 2,
              pointRadius: 4,
              pointHoverRadius: 6,
              fill: true,
              tension: 0.35,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { grid: { color: 'rgba(255,255,255,0.05)' } },
              y: { grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
            },
            plugins: { legend: { display: false } },
          },
        };
        break;

      case 'violations_by_station':
        config = {
          type: 'bar',
          data: {
            labels: labels.slice(0, 10),
            datasets: [{
              label: 'Events',
              data: values.slice(0, 10),
              backgroundColor: CHART_COLORS.slice(0, 10).map(c => c + 'CC'),
              borderColor: CHART_COLORS.slice(0, 10),
              borderWidth: 1,
              borderRadius: 4,
              barPercentage: 0.7,
            }],
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
              y: { grid: { display: false } },
            },
            plugins: { legend: { display: false } },
          },
        };
        break;

      case 'violations_by_vehicle':
        config = {
          type: 'polarArea',
          data: {
            labels,
            datasets: [{
              data: values,
              backgroundColor: CHART_COLORS.slice(0, labels.length).map(c => c + '99'),
              borderColor: CHART_COLORS.slice(0, labels.length),
              borderWidth: 1.5,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              r: {
                grid: { color: 'rgba(255,255,255,0.08)' },
                ticks: { display: false },
              },
            },
            plugins: {
              legend: { position: 'right', labels: { font: { size: 10 }, boxWidth: 12 } },
            },
          },
        };
        break;

      case 'violations_by_hour':
        config = {
          type: 'radar',
          data: {
            labels,
            datasets: [{
              label: 'Events',
              data: values,
              borderColor: '#4FA0D9',
              backgroundColor: 'rgba(79,160,217,0.12)',
              borderWidth: 2,
              pointBackgroundColor: '#4FA0D9',
              pointBorderColor: '#161B22',
              pointBorderWidth: 2,
              pointRadius: 3,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              r: {
                grid: { color: 'rgba(255,255,255,0.08)' },
                angleLines: { color: 'rgba(255,255,255,0.06)' },
                ticks: { display: false },
                beginAtZero: true,
              },
            },
            plugins: { legend: { display: false } },
          },
        };
        break;

      case 'violations_by_day_of_week':
        config = {
          type: 'bar',
          data: {
            labels,
            datasets: [{
              label: 'Events',
              data: values,
              backgroundColor: values.map((_, i) => CHART_COLORS[i % CHART_COLORS.length] + 'BB'),
              borderColor: values.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
              borderWidth: 1,
              borderRadius: 6,
              barPercentage: 0.65,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { grid: { display: false } },
              y: { grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
            },
            plugins: { legend: { display: false } },
          },
        };
        break;

      default:
        return;
    }

    state.currentChart = new Chart(ctx, config);
  }

  // ── Chat Module ───────────────────────────────────────
  const QUICK_CHIPS = [
    'Top 5 hotspots',
    'Trending zones',
    'Vehicle breakdown',
    'Worst station',
    'Monthly trend',
    'Events by hour',
  ];

  function renderChips() {
    const container = document.getElementById('chipsContainer');
    if (!container) return;
    container.innerHTML = '';

    QUICK_CHIPS.forEach(text => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = text;
      chip.addEventListener('click', () => sendMessage(text));
      container.appendChild(chip);
    });
  }

  function appendMessage(role, text) {
    const log = document.getElementById('chatLog');
    if (!log) return;

    const msg = document.createElement('div');
    msg.className = `chat-msg ${role}`;

    if (role === 'assistant') {
      msg.innerHTML = `
        <div class="msg-label">GridGuard</div>
        <div class="msg-text">${formatAssistantText(text)}</div>
      `;
    } else {
      msg.textContent = text;
    }

    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
  }

  function formatAssistantText(text) {
    let html = esc(text);
    // Bold: **text**
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Line breaks
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function showTyping() {
    const log = document.getElementById('chatLog');
    if (!log) return;

    const el = document.createElement('div');
    el.className = 'typing-indicator';
    el.id = 'typingIndicator';
    el.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function setChatOverlay(open) {
    const overlay = document.getElementById('chatOverlay');
    const launchBtn = document.getElementById('chatLaunchBtn');
    if (!overlay) return;

    overlay.classList.toggle('is-open', open);
    overlay.setAttribute('aria-hidden', open ? 'false' : 'true');
    document.body.classList.toggle('chat-overlay-open', open);

    if (open) {
      const input = document.getElementById('chatInput');
      if (input) setTimeout(() => input.focus(), 0);
    } else if (launchBtn) {
      setTimeout(() => launchBtn.focus(), 0);
    }
  }

  function initChatOverlay() {
    const launchBtn = document.getElementById('chatLaunchBtn');
    const closeBtn = document.getElementById('chatCloseBtn');
    const backdrop = document.getElementById('chatBackdrop');
    const overlay = document.getElementById('chatOverlay');

    if (launchBtn) {
      launchBtn.addEventListener('click', () => setChatOverlay(true));
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => setChatOverlay(false));
    }

    if (backdrop) {
      backdrop.addEventListener('click', () => setChatOverlay(false));
    }

    if (overlay) {
      overlay.setAttribute('tabindex', '-1');
      overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          setChatOverlay(false);
        }
      });
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        setChatOverlay(false);
      }
    });
  }

  function hideTyping() {
    const el = document.getElementById('typingIndicator');
    if (el) el.remove();
  }

  async function sendMessage(text) {
    if (!text || !text.trim() || state.isSending) return;
    text = text.trim();

    state.isSending = true;
    const askBtn = document.getElementById('askBtn');
    const input = document.getElementById('chatInput');
    if (askBtn) askBtn.disabled = true;
    if (input) input.value = '';

    state.chatHistory.push({ role: 'user', content: text });
    appendMessage('user', text);
    showTyping();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: state.chatHistory.slice(-20),
        }),
      });

      hideTyping();

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const reply = data.response || data.reply || data.message || data.answer || 'No response received.';

      state.chatHistory.push({ role: 'assistant', content: reply });
      appendMessage('assistant', reply);

      if (data.hotspots && Array.isArray(data.hotspots)) {
        highlightHotspots(data.hotspots);
      }
    } catch (e) {
      hideTyping();
      appendMessage('assistant', 'Sorry, I encountered an error connecting to the server. Please try again.');
      console.error('sendMessage:', e);
    } finally {
      state.isSending = false;
      if (askBtn) askBtn.disabled = false;
      if (input) input.focus();
    }
  }

  function showWelcome() {
    appendMessage('assistant',
      'Welcome, operator. I\'m GridGuard — your traffic incident and event intelligence co-pilot.\n\n' +
      'I can help you analyze hotspots, identify trends, and prioritize patrol deployment across Bengaluru. ' +
      'Try asking me about the top event zones, trending areas, or specific stations.'
    );
  }

  function switchTab(tabName) {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const queueSection = document.getElementById('queueSection');
    const chartsSection = document.getElementById('chartsSection');
    const detailSection = document.getElementById('detailSection');
    const heatmapSection = document.getElementById('heatmapSection');
    const detailTabBtn = document.getElementById('tabBtnDetail');

    if (tabName === 'detail') {
      if (detailTabBtn) detailTabBtn.style.display = 'flex';
    } else {
      if (state.activeClusterId === null && detailTabBtn) {
        detailTabBtn.style.display = 'none';
      }
    }

    tabBtns.forEach(btn => {
      if (btn.dataset.tab === tabName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    [queueSection, chartsSection, detailSection, heatmapSection].forEach(sec => {
      if (sec) {
        if (sec.id === `${tabName}Section`) {
          sec.classList.add('active');
          sec.style.display = 'flex';
        } else {
          sec.classList.remove('active');
          sec.style.display = 'none';
        }
      }
    });

    if (state.map) {
      if (tabName === 'heatmap') {
        if (state.markerLayer && state.map.hasLayer(state.markerLayer)) {
          state.map.removeLayer(state.markerLayer);
        }
        if (state.trendingLayer && state.map.hasLayer(state.trendingLayer)) {
          state.map.removeLayer(state.trendingLayer);
        }
        if (state.highlightLayer && state.map.hasLayer(state.highlightLayer)) {
          state.map.removeLayer(state.highlightLayer);
        }

        if (state.heatmapData.length === 0) {
          fetchHeatmapData();
        } else {
          renderHeatmap();
        }
      } else {
        if (state.heatmapLayer && state.map.hasLayer(state.heatmapLayer)) {
          state.map.removeLayer(state.heatmapLayer);
          state.heatmapLayer = null;
        }

        if (state.markerLayer && !state.map.hasLayer(state.markerLayer)) {
          state.map.addLayer(state.markerLayer);
        }
        if (state.trendingLayer && !state.map.hasLayer(state.trendingLayer)) {
          state.map.addLayer(state.trendingLayer);
        }
        if (state.highlightLayer && !state.map.hasLayer(state.highlightLayer)) {
          state.map.addLayer(state.highlightLayer);
        }
      }
    }
  }

  function initTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.tab);
      });
    });
  }

  // ── Zone Details Module ────────────────────────────────
  function showHotspotDetail(h) {
    if (!h) return;

    state.activeClusterId = h.cluster_id;

    const detailTabBtn = document.getElementById('tabBtnDetail');
    if (detailTabBtn) {
      detailTabBtn.style.display = 'flex';
    }

    const score = h.composite_score || h.score || 0;
    const color = tierColor(score);
    const tier = scoreTier(score);
    const labelText = tierLabel(tier);
    const name = h.label || h.name || h.location || h.hotspot_name || 'Unknown';
    const station = h.police_station || h.station || '—';
    const count = h.violation_count || h.violations || 0;
    const peakHour = h.peak_hour != null ? `${String(h.peak_hour).padStart(2, '0')}:00` : '—';
    const domType = h.dominant_violation_type || h.dominant_type || h.top_violation || '—';
    const domVehicle = h.dominant_vehicle_type || h.dominant_vehicle || h.top_vehicle || '—';

    const detailName = document.getElementById('detailName');
    const detailStation = document.getElementById('detailStation');
    const detailViolations = document.getElementById('detailViolations');
    const detailPeakHour = document.getElementById('detailPeakHour');
    const detailDominantType = document.getElementById('detailDominantType');
    const detailDominantVehicle = document.getElementById('detailDominantVehicle');
    const detailScore = document.getElementById('detailScore');
    const detailHeaderCard = document.getElementById('detailHeaderCard');

    if (detailName) detailName.textContent = name;
    if (detailStation) detailStation.textContent = station;
    if (detailViolations) detailViolations.textContent = formatNum(count);
    if (detailPeakHour) detailPeakHour.textContent = peakHour;
    if (detailDominantType) detailDominantType.textContent = domType;
    if (detailDominantVehicle) detailDominantVehicle.textContent = domVehicle;

    if (detailScore) {
      detailScore.textContent = `${score.toFixed(1)} · ${labelText}`;
      detailScore.style.backgroundColor = `${color}22`;
      detailScore.style.color = color;
      detailScore.style.border = `1px solid ${color}44`;
    }

    if (detailHeaderCard) {
      detailHeaderCard.style.border = `1px solid ${color}44`;
      detailHeaderCard.style.background = `linear-gradient(135deg, ${color}0D 0%, rgba(22,27,34,0.96) 100%)`;
    }

    switchTab('detail');

    const container = document.getElementById('detailChartTypeSelector');
    if (container) {
      container.querySelectorAll('.chart-type-btn').forEach((b, idx) => {
        if (idx === 0) b.classList.add('active');
        else b.classList.remove('active');
      });
    }

    fetchDetailChartData('violations_by_type');
  }

  function initDetailChartTypeSelector() {
    const container = document.getElementById('detailChartTypeSelector');
    if (!container) return;

    container.innerHTML = '';
    CHART_TYPES.forEach((ct) => {
      if (ct.key === 'violations_by_station') return; // Skip "By Station" for single-zone details
      const btn = document.createElement('button');
      btn.className = 'chart-type-btn' + (container.children.length === 0 ? ' active' : '');
      btn.textContent = ct.label;
      btn.dataset.chartType = ct.key;
      btn.addEventListener('click', () => {
        container.querySelectorAll('.chart-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fetchDetailChartData(ct.key);
      });
      container.appendChild(btn);
    });
  }

  function initDetailCloseBtn() {
    const closeBtn = document.getElementById('detailCloseBtn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        state.activeClusterId = null;
        switchTab('queue');
      });
    }
  }

  async function fetchDetailChartData(chartType) {
    if (state.activeClusterId === null) return;
    try {
      const res = await fetch(`/api/data/charts/${chartType}/cluster/${state.activeClusterId}?min_samples=${state.minSamples}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderDetailChart(chartType, data);
    } catch (e) {
      console.error('fetchDetailChartData:', e);
    }
  }

  function renderDetailChart(chartType, data) {
    if (state.currentDetailChart) {
      state.currentDetailChart.destroy();
      state.currentDetailChart = null;
    }

    const canvas = document.getElementById('detailChartCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const activeHotspot = state.hotspots.find(h => h.cluster_id === state.activeClusterId);
    const score = activeHotspot ? (activeHotspot.composite_score || activeHotspot.score || 0) : 50;
    const baseColor = tierColor(score);

    const detailColors = [
      baseColor,
      baseColor + 'E6',
      baseColor + 'CC',
      baseColor + 'B3',
      baseColor + '99',
      baseColor + '80',
      baseColor + '66',
      baseColor + '4D',
      baseColor + '33',
      baseColor + '1A'
    ];

    const labels = data.labels || [];
    const values = data.values || data.data || [];

    let config;

    switch (chartType) {
      case 'violations_by_type':
        config = {
          type: 'doughnut',
          data: {
            labels: labels.slice(0, 10),
            datasets: [{
              data: values.slice(0, 10),
              backgroundColor: detailColors.slice(0, 10),
              borderColor: '#161B22',
              borderWidth: 2,
              hoverBorderColor: '#E7EAEE',
              hoverBorderWidth: 2,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '55%',
            plugins: {
              legend: { position: 'right', labels: { font: { size: 10 }, boxWidth: 12 } },
            },
          },
        };
        break;

      case 'violations_by_month':
        config = {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: 'Events',
              data: values,
              borderColor: baseColor,
              backgroundColor: baseColor + '14',
              borderWidth: 2.5,
              pointBackgroundColor: baseColor,
              pointBorderColor: '#161B22',
              pointBorderWidth: 2,
              pointRadius: 4,
              pointHoverRadius: 6,
              fill: true,
              tension: 0.35,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { grid: { color: 'rgba(255,255,255,0.05)' } },
              y: { grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
            },
            plugins: { legend: { display: false } },
          },
        };
        break;

      case 'violations_by_station':
        config = {
          type: 'bar',
          data: {
            labels: labels.slice(0, 10),
            datasets: [{
              label: 'Events',
              data: values.slice(0, 10),
              backgroundColor: detailColors.slice(0, 10).map(c => c + 'CC'),
              borderColor: detailColors.slice(0, 10),
              borderWidth: 1,
              borderRadius: 4,
              barPercentage: 0.7,
            }],
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
              y: { grid: { display: false } },
            },
            plugins: { legend: { display: false } },
          },
        };
        break;

      case 'violations_by_vehicle':
        config = {
          type: 'polarArea',
          data: {
            labels,
            datasets: [{
              data: values,
              backgroundColor: detailColors.slice(0, labels.length).map(c => c + '99'),
              borderColor: detailColors.slice(0, labels.length),
              borderWidth: 1.5,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              r: {
                grid: { color: 'rgba(255,255,255,0.08)' },
                ticks: { display: false },
              },
            },
            plugins: {
              legend: { position: 'right', labels: { font: { size: 10 }, boxWidth: 12 } },
            },
          },
        };
        break;

      case 'violations_by_hour':
        config = {
          type: 'radar',
          data: {
            labels,
            datasets: [{
              label: 'Events',
              data: values,
              borderColor: baseColor,
              backgroundColor: baseColor + '1E',
              borderWidth: 2,
              pointBackgroundColor: baseColor,
              pointBorderColor: '#161B22',
              pointBorderWidth: 2,
              pointRadius: 3,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              r: {
                grid: { color: 'rgba(255,255,255,0.08)' },
                angleLines: { color: 'rgba(255,255,255,0.06)' },
                ticks: { display: false },
                beginAtZero: true,
              },
            },
            plugins: { legend: { display: false } },
          },
        };
        break;

      case 'violations_by_day_of_week':
        config = {
          type: 'bar',
          data: {
            labels,
            datasets: [{
              label: 'Events',
              data: values,
              backgroundColor: values.map((_, i) => detailColors[i % detailColors.length] + 'BB'),
              borderColor: values.map((_, i) => detailColors[i % detailColors.length]),
              borderWidth: 1,
              borderRadius: 6,
              barPercentage: 0.65,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              x: { grid: { display: false } },
              y: { grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
            },
            plugins: { legend: { display: false } },
          },
        };
        break;

      default:
        return;
    }

    state.currentDetailChart = new Chart(ctx, config);
  }

  // ── Stats Footer ──────────────────────────────────────
  async function fetchSummary() {
    try {
      const res = await fetch(`/api/data/summary?min_samples=${state.minSamples}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      
      setText('statViolations', formatNum(data.total_violations || 0));
      setText('statClusters', formatNum(data.clusters_detected || 0));
      setText('statTrending', formatNum(data.trending_zones || 0));
      setText('statDateRange', typeof data.date_range === 'string' ? data.date_range : '—');
    } catch (e) {
      console.warn('fetchSummary:', e);
    }
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ── Input Handling ────────────────────────────────────
  function initInput() {
    const input = document.getElementById('chatInput');
    const btn = document.getElementById('askBtn');

    if (input) {
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage(input.value);
        }
      });
    }

    if (btn) {
      btn.addEventListener('click', () => {
        if (input) sendMessage(input.value);
      });
    }
  }

  // ── Boot ──────────────────────────────────────────────
  let sliderDebounceTimeout = null;

  function initMinSamplesSlider() {
    const slider = document.getElementById('minSamplesSlider');
    const display = document.getElementById('minSamplesVal');
    if (!slider || !display) return;

    slider.addEventListener('input', () => {
      display.textContent = slider.value;
      
      clearTimeout(sliderDebounceTimeout);
      sliderDebounceTimeout = setTimeout(() => {
        state.minSamples = parseInt(slider.value, 10);
        
        if (state.activeClusterId !== null) {
          state.activeClusterId = null;
          switchTab('queue');
        }
        
        fetchSummary();
        fetchHotspots();
        fetchTrendingHotspots();
      }, 300);
    });
  }

  function initSidebarResizer() {
    const resizer = document.getElementById('sidebarResizer');
    const sidebar = document.querySelector('.sidebar');
    const mapContainer = document.getElementById('map');
    if (!resizer || !sidebar) return;

    let isResizing = false;

    resizer.addEventListener('mousedown', (e) => {
      isResizing = true;
      resizer.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      if (mapContainer) mapContainer.style.pointerEvents = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;

      const containerWidth = window.innerWidth;
      let newWidth = containerWidth - e.clientX;

      if (newWidth < 280) newWidth = 280;
      if (newWidth > 600) newWidth = 600;

      sidebar.style.width = `${newWidth}px`;
      
      if (state.map) {
        state.map.invalidateSize();
      }
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      resizer.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (mapContainer) mapContainer.style.pointerEvents = '';
      
      if (state.map) {
        state.map.invalidateSize();
      }
    });
  }

  // ── Station Stats Overlay Module ──────────────────────
  function setStatsOverlay(open) {
    const overlay = document.getElementById('statsOverlay');
    const launchBtn = document.getElementById('stationStatsBtn');
    if (!overlay) return;

    overlay.classList.toggle('is-open', open);
    overlay.setAttribute('aria-hidden', open ? 'false' : 'true');
    overlay.style.display = open ? 'flex' : 'none';
    document.body.classList.toggle('stats-overlay-open', open);

    if (open && state.stations.length === 0) {
      fetchStationsData();
    }

    if (!open) {
      const compareView = document.getElementById('stationCompareView');
      const detailView = document.getElementById('stationDetailView');
      if (compareView && detailView) {
        compareView.style.display = 'block';
        detailView.style.display = 'none';
      }
      const list = document.getElementById('statsRankList');
      if (list) {
        list.querySelectorAll('.rank-item').forEach(el => el.classList.remove('active'));
      }
      if (state.stationChart) {
        state.stationChart.destroy();
        state.stationChart = null;
      }
    }
  }

  async function fetchStationsData() {
    try {
      const res = await fetch('/api/data/stations');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.stations = data || [];
      
      renderStationLeaderboard();
      populateStationDropdowns();
    } catch (e) {
      console.error('fetchStationsData:', e);
      const list = document.getElementById('statsRankList');
      if (list) list.innerHTML = '<div style="color:var(--accent-red); padding:18px;">Failed to load station rankings.</div>';
    }
  }

  function renderStationLeaderboard() {
    const list = document.getElementById('statsRankList');
    if (!list) return;

    list.innerHTML = '';
    if (state.stations.length === 0) {
      list.innerHTML = '<div style="padding:18px; color:var(--text-dim);">No stations found.</div>';
      return;
    }

    const maxVal = Math.max(...state.stations.map(s => s.count || 1));

    state.stations.forEach((s, idx) => {
      const item = document.createElement('div');
      item.className = 'rank-item';
      const percentage = ((s.count || 0) / maxVal) * 100;
      
      item.innerHTML = `
        <div class="rank-num">${idx + 1}</div>
        <div class="rank-name-box">
          <div class="rank-name">${esc(s.station)}</div>
          <div class="rank-bar-wrap">
            <div class="rank-bar" style="width: ${percentage}%"></div>
          </div>
        </div>
        <div class="rank-val">${formatNum(s.count)}</div>
      `;

      item.addEventListener('click', () => {
        list.querySelectorAll('.rank-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        showStationDetails(s.station);
      });

      list.appendChild(item);
    });
  }

  function populateStationDropdowns() {
    const selA = document.getElementById('stationSelectA');
    const selB = document.getElementById('stationSelectB');
    if (!selA || !selB) return;

    selA.innerHTML = '';
    selB.innerHTML = '';

    const sortedStations = [...state.stations].sort((a, b) => a.station.localeCompare(b.station));

    sortedStations.forEach((s, idx) => {
      const optA = document.createElement('option');
      optA.value = s.station;
      optA.textContent = s.station;
      selA.appendChild(optA);

      const optB = document.createElement('option');
      optB.value = s.station;
      optB.textContent = s.station;
      if (idx === 1) optB.selected = true;
      selB.appendChild(optB);
    });
  }

  async function runStationComparison() {
    const selA = document.getElementById('stationSelectA');
    const selB = document.getElementById('stationSelectB');
    const results = document.getElementById('compareResults');
    const placeholder = document.getElementById('comparePlaceholder');
    if (!selA || !selB || !results || !placeholder) return;

    const nameA = selA.value;
    const nameB = selB.value;

    if (!nameA || !nameB) return;

    placeholder.style.display = 'none';
    results.style.display = 'grid';
    results.innerHTML = '<div style="grid-column: span 2; text-align:center; padding:40px; color:var(--text-dim);">Running comparisons...</div>';

    try {
      const res = await fetch(`/api/data/compare_stations?station_a=${encodeURIComponent(nameA)}&station_b=${encodeURIComponent(nameB)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      
      renderComparisonResults(data.station_a, data.station_b);
    } catch (e) {
      console.error('runStationComparison:', e);
      results.innerHTML = '<div style="grid-column: span 2; color:var(--accent-red); text-align:center; padding:20px;">Failed to compute comparison stats.</div>';
    }
  }

  function renderComparisonResults(sa, sb) {
    const results = document.getElementById('compareResults');
    if (!results) return;

    const peakHourStr = h => h != null ? `${String(h).padStart(2, '0')}:00` : '—';

    results.innerHTML = '';

    [sa, sb].forEach((s) => {
      const col = document.createElement('div');
      col.className = 'compare-column';
      
      let vtypesHtml = '';
      const totalVtypeCounts = s.top_violation_types.length > 0 ? Math.max(...s.top_violation_types.map(v => v.count || 1)) : 1;
      s.top_violation_types.forEach(vt => {
        const pct = ((vt.count || 0) / totalVtypeCounts) * 100;
        vtypesHtml += `
          <div class="compare-progress-row">
            <div class="compare-progress-info">
               <span class="compare-progress-label" title="${esc(vt.type)}">${esc(vt.type)}</span>
               <span class="compare-progress-val">${formatNum(vt.count)}</span>
            </div>
            <div class="compare-progress-bar-wrap">
               <div class="compare-progress-bar" style="width: ${pct}%"></div>
            </div>
          </div>
        `;
      });

      let vehiclesHtml = '';
      const totalVehCounts = s.top_vehicle_types.length > 0 ? Math.max(...s.top_vehicle_types.map(v => v.count || 1)) : 1;
      s.top_vehicle_types.forEach(vh => {
        const pct = ((vh.count || 0) / totalVehCounts) * 100;
        vehiclesHtml += `
          <div class="compare-progress-row">
            <div class="compare-progress-info">
               <span class="compare-progress-label">${esc(vh.vehicle_type)}</span>
               <span class="compare-progress-val">${formatNum(vh.count)}</span>
            </div>
            <div class="compare-progress-bar-wrap">
               <div class="compare-progress-bar" style="width: ${pct}%"></div>
            </div>
          </div>
        `;
      });

      col.innerHTML = `
         <div class="compare-column-title">${esc(s.station)}</div>
         
         <div class="compare-card-stat">
           <span class="compare-stat-label">Total Events</span>
           <span class="compare-stat-val blue">${formatNum(s.total_violations)}</span>
         </div>
         
         <div class="compare-card-stat">
           <span class="compare-stat-label">Peak Hour</span>
           <span class="compare-stat-val">${peakHourStr(s.peak_hour)}</span>
         </div>
         
         <div class="compare-sub-section">
           <div class="compare-sub-title">Dominant Event Causes</div>
           ${vtypesHtml || '<div style="font-size:12px; color:var(--text-dim);">No data</div>'}
         </div>
         
         <div class="compare-sub-section">
           <div class="compare-sub-title">Vehicle Profile Distribution</div>
           ${vehiclesHtml || '<div style="font-size:12px; color:var(--text-dim);">No data</div>'}
         </div>
      `;
      results.appendChild(col);
    });
  }

  async function showStationDetails(stationName) {
    const compareView = document.getElementById('stationCompareView');
    const detailView = document.getElementById('stationDetailView');
    if (!compareView || !detailView) return;

    compareView.style.display = 'none';
    detailView.style.display = 'flex';

    const title = document.getElementById('stationDetailTitle');
    if (title) title.textContent = `${stationName} Station`;

    const totalEl = document.getElementById('stationDetailTotal');
    const peakEl = document.getElementById('stationDetailPeak');
    const violationsList = document.getElementById('stationDetailViolations');
    const vehiclesList = document.getElementById('stationDetailVehicles');

    if (totalEl) totalEl.textContent = 'Loading...';
    if (peakEl) peakEl.textContent = 'Loading...';
    if (violationsList) {
      violationsList.innerHTML = `
        <div class="skeleton-row" style="height:25px; margin-bottom:6px;"></div>
        <div class="skeleton-row" style="height:25px; margin-bottom:6px;"></div>
        <div class="skeleton-row" style="height:25px;"></div>
      `;
    }
    if (vehiclesList) {
      vehiclesList.innerHTML = `
        <div class="skeleton-row" style="height:25px; margin-bottom:6px;"></div>
        <div class="skeleton-row" style="height:25px; margin-bottom:6px;"></div>
        <div class="skeleton-row" style="height:25px;"></div>
      `;
    }

    try {
      const res = await fetch(`/api/data/stations/${encodeURIComponent(stationName)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (totalEl) totalEl.textContent = formatNum(data.total_violations);
      if (peakEl) {
        const peakStr = data.peak_hour != null ? `${String(data.peak_hour).padStart(2, '0')}:00` : '—';
        peakEl.textContent = peakStr;
      }

      if (violationsList) {
        violationsList.innerHTML = '';
        if (data.top_violation_types.length === 0) {
          violationsList.innerHTML = '<div style="font-size:12px; color:var(--text-dim);">No data</div>';
        } else {
          const maxCount = Math.max(...data.top_violation_types.map(v => v.count || 1));
          data.top_violation_types.forEach(vt => {
            const pct = ((vt.count || 0) / maxCount) * 100;
            const row = document.createElement('div');
            row.className = 'compare-progress-row';
            row.innerHTML = `
              <div class="compare-progress-info">
                 <span class="compare-progress-label" title="${esc(vt.type)}">${esc(vt.type)}</span>
                 <span class="compare-progress-val">${formatNum(vt.count)}</span>
              </div>
              <div class="compare-progress-bar-wrap">
                 <div class="compare-progress-bar" style="width: ${pct}%"></div>
              </div>
            `;
            violationsList.appendChild(row);
          });
        }
      }

      if (vehiclesList) {
        vehiclesList.innerHTML = '';
        if (data.top_vehicle_types.length === 0) {
          vehiclesList.innerHTML = '<div style="font-size:12px; color:var(--text-dim);">No data</div>';
        } else {
          const maxCount = Math.max(...data.top_vehicle_types.map(v => v.count || 1));
          data.top_vehicle_types.forEach(vh => {
            const pct = ((vh.count || 0) / maxCount) * 100;
            const row = document.createElement('div');
            row.className = 'compare-progress-row';
            row.innerHTML = `
              <div class="compare-progress-info">
                 <span class="compare-progress-label" title="${esc(vh.vehicle_type)}">${esc(vh.vehicle_type)}</span>
                 <span class="compare-progress-val">${formatNum(vh.count)}</span>
              </div>
              <div class="compare-progress-bar-wrap">
                 <div class="compare-progress-bar" style="width: ${pct}%"></div>
              </div>
            `;
            vehiclesList.appendChild(row);
          });
        }
      }

      renderStationTimelineChart(data.monthly_timeline);
    } catch (e) {
      console.error('showStationDetails:', e);
      if (totalEl) totalEl.textContent = 'Error';
      if (peakEl) peakEl.textContent = 'Error';
      if (violationsList) violationsList.innerHTML = '<div style="color:var(--accent-red); font-size:12px;">Failed to load breakdowns.</div>';
      if (vehiclesList) vehiclesList.innerHTML = '<div style="color:var(--accent-red); font-size:12px;">Failed to load vehicles.</div>';
    }
  }

  function renderStationTimelineChart(timeline) {
    if (state.stationChart) {
      state.stationChart.destroy();
      state.stationChart = null;
    }

    const canvas = document.getElementById('stationTimelineChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const labels = timeline.labels || [];
    const values = timeline.values || [];

    const chartColor = '#4FA0D9';
    let gradient = null;
    try {
      gradient = ctx.createLinearGradient(0, 0, 0, 150);
      gradient.addColorStop(0, 'rgba(79,160,217,0.18)');
      gradient.addColorStop(1, 'rgba(79,160,217,0.00)');
    } catch(err) {
      gradient = 'rgba(79,160,217,0.05)';
    }

    const config = {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Monthly Events',
          data: values,
          borderColor: chartColor,
          backgroundColor: gradient,
          borderWidth: 2,
          pointBackgroundColor: chartColor,
          pointBorderColor: '#161B22',
          pointBorderWidth: 1.5,
          pointRadius: 3,
          pointHoverRadius: 5,
          fill: true,
          tension: 0.3,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { font: { size: 9 }, color: '#8B94A1' }
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { font: { size: 9 }, color: '#8B94A1' },
            beginAtZero: true
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            padding: 8,
            backgroundColor: '#1D2430',
            borderColor: 'rgba(255,255,255,0.08)',
            borderWidth: 1,
            titleColor: '#E7EAEE',
            bodyColor: '#4FA0D9',
            titleFont: { family: "'IBM Plex Sans', sans-serif", weight: 'bold' },
            bodyFont: { family: "'IBM Plex Mono', monospace" }
          }
        }
      }
    };

    state.stationChart = new Chart(ctx, config);
  }

  function initStatsOverlay() {
    const launchBtn = document.getElementById('stationStatsBtn');
    const closeBtn = document.getElementById('statsCloseBtn');
    const backdrop = document.getElementById('statsBackdrop');
    const overlay = document.getElementById('statsOverlay');
    const compareBtn = document.getElementById('stationCompareBtn');
    const backBtn = document.getElementById('backToCompareBtn');

    if (launchBtn) {
      launchBtn.addEventListener('click', () => setStatsOverlay(true));
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => setStatsOverlay(false));
    }

    if (backdrop) {
      backdrop.addEventListener('click', () => setStatsOverlay(false));
    }

    if (overlay) {
      overlay.setAttribute('tabindex', '-1');
      overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          setStatsOverlay(false);
        }
      });
    }

    if (compareBtn) {
      compareBtn.addEventListener('click', () => runStationComparison());
    }

    if (backBtn) {
      backBtn.addEventListener('click', () => {
        const compareView = document.getElementById('stationCompareView');
        const detailView = document.getElementById('stationDetailView');
        if (compareView && detailView) {
          compareView.style.display = 'block';
          detailView.style.display = 'none';
        }
        const list = document.getElementById('statsRankList');
        if (list) {
          list.querySelectorAll('.rank-item').forEach(el => el.classList.remove('active'));
        }
        if (state.stationChart) {
          state.stationChart.destroy();
          state.stationChart = null;
        }
      });
    }
  }

  // ── Heatmap Module ────────────────────────────────────
  const HEATMAP_MONTHS = [
    { label: 'All Data', value: 'all' },
    { label: 'Nov 2023', value: '2023-11' },
    { label: 'Dec 2023', value: '2023-12' },
    { label: 'Jan 2024', value: '2024-01' },
    { label: 'Feb 2024', value: '2024-02' },
    { label: 'Mar 2024', value: '2024-03' },
    { label: 'Apr 2024', value: '2024-04' }
  ];

  async function fetchHeatmapData() {
    const countEl = document.getElementById('heatmapSummaryCount');
    if (countEl) countEl.textContent = 'Loading...';

    try {
      const res = await fetch('/api/heatmap');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.heatmapData = data || [];
      
      renderHeatmap();
    } catch (e) {
      console.error('fetchHeatmapData:', e);
      if (countEl) countEl.textContent = 'Error';
    }
  }

  function renderHeatmap() {
    if (!state.map) return;

    const slider = document.getElementById('heatmapTimelineSlider');
    const sliderVal = slider ? parseInt(slider.value, 10) : 0;
    const mapping = HEATMAP_MONTHS[sliderVal] || HEATMAP_MONTHS[0];

    const labelEl = document.getElementById('heatmapTimelineVal');
    if (labelEl) labelEl.textContent = mapping.label;

    let filteredPoints = [];
    let totalIntensity = 0;

    if (mapping.value === 'all') {
      const coordMap = {};
      state.heatmapData.forEach(p => {
        const lat = p.lat;
        const lon = p.lon;
        const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
        const val = p.intensity || 1;
        coordMap[key] = (coordMap[key] || 0) + val;
      });
      
      for (const key in coordMap) {
        const [latStr, lonStr] = key.split(',');
        const lat = parseFloat(latStr);
        const lon = parseFloat(lonStr);
        const intensity = coordMap[key];
        filteredPoints.push([lat, lon, intensity]);
        totalIntensity += intensity;
      }
    } else {
      state.heatmapData.forEach(p => {
        if (p.month === mapping.value) {
          filteredPoints.push([p.lat, p.lon, p.intensity || 1]);
          totalIntensity += (p.intensity || 1);
        }
      });
    }

    const countEl = document.getElementById('heatmapSummaryCount');
    if (countEl) countEl.textContent = formatNum(totalIntensity);

    if (state.heatmapLayer) {
      state.map.removeLayer(state.heatmapLayer);
      state.heatmapLayer = null;
    }

    if (filteredPoints.length === 0) return;

    const intensities = filteredPoints.map(p => p[2]);
    const maxIntensity = intensities.length > 0 ? Math.max(...intensities) : 1;

    state.heatmapLayer = L.heatLayer(filteredPoints, {
      radius: 18,
      blur: 13,
      maxZoom: 15,
      max: maxIntensity * 0.7
    }).addTo(state.map);
  }

  function initHeatmapTimelineSlider() {
    const slider = document.getElementById('heatmapTimelineSlider');
    if (!slider) return;

    slider.addEventListener('input', () => {
      renderHeatmap();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    startClock();
    initMap();
    initTabs();
    initInput();
    initChatOverlay();
    initChartTypeSelector();
    initDetailChartTypeSelector();
    initDetailCloseBtn();
    initMinSamplesSlider();
    initSidebarResizer();
    initStatsOverlay();
    initHeatmapTimelineSlider();
    renderChips();
    showWelcome();
    fetchSummary();
    fetchHotspots();
    fetchTrendingHotspots();
    fetchChartData('violations_by_type');
  });
})();
