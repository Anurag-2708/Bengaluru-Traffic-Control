import React, { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import {
  MapPin, Shield, Radio, Activity, Archive, Plus, Trash2,
  Map as MapIcon, X, Sliders, AlertTriangle, Check, Layers, BarChart2,
  RefreshCw, ChevronDown, ChevronUp, FileText, TrendingUp, Search
} from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

// Extended preset locations covering major Bangalore roads & corridors from dataset
const LOCATION_PRESETS = [
  { name: "Town Hall", lat: 12.97883, lon: 77.59953 },
  { name: "MG Road Metro", lat: 12.97540, lon: 77.60680 },
  { name: "Koramangala", lat: 12.93520, lon: 77.62450 },
  { name: "Indiranagar", lat: 12.97190, lon: 77.64120 },
  { name: "Yeshwanthpur", lat: 13.02350, lon: 77.54680 },
  { name: "Silk Board Junction", lat: 12.91760, lon: 77.62260 },
  { name: "Hebbal Flyover", lat: 13.03560, lon: 77.59410 },
  { name: "Electronic City", lat: 12.84320, lon: 77.66340 },
  { name: "Marathahalli Bridge", lat: 12.95680, lon: 77.69700 },
  { name: "KR Puram Bridge", lat: 12.99780, lon: 77.69450 },
  { name: "Outer Ring Road (ORR) East", lat: 12.95100, lon: 77.71200 },
  { name: "Outer Ring Road (ORR) West", lat: 12.97500, lon: 77.50100 },
  { name: "Bannerghatta Road", lat: 12.89600, lon: 77.59400 },
  { name: "Old Airport Road", lat: 12.96340, lon: 77.64380 },
  { name: "Bellary Road (NH7)", lat: 13.01200, lon: 77.60500 },
  { name: "Mysore Road", lat: 12.95600, lon: 77.52300 },
  { name: "Tumkur Road (NH48)", lat: 13.02800, lon: 77.53600 },
  { name: "Hosur Road (NH44)", lat: 12.91100, lon: 77.63600 },
  { name: "Whitefield", lat: 12.96990, lon: 77.74990 },
  { name: "Rajajinagar", lat: 12.99200, lon: 77.55100 },
  { name: "Shivajinagar", lat: 12.98700, lon: 77.59800 },
  { name: "Jalahalli Cross", lat: 13.02900, lon: 77.53900 },
  { name: "Peenya Industrial Area", lat: 13.03000, lon: 77.52000 },
  { name: "HAL Airport Road", lat: 12.94900, lon: 77.66800 },
  { name: "Kadugodi", lat: 12.99500, lon: 77.77400 },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("simulation");
  const [stations, setStations] = useState({});
  const [liveEvents, setLiveEvents] = useState({});
  const [mappings, setMappings] = useState({});
  const [featureImportance, setFeatureImportance] = useState({});
  const [historicalEvents, setHistoricalEvents] = useState([]);
  const [modelMetrics, setModelMetrics] = useState({});
  const [archives, setArchives] = useState([]);
  const [responseCardOptions, setResponseCardOptions] = useState({ corridors: [], event_causes: [], time_slots: [] });

  // Simulation list
  const [simList, setSimList] = useState([]);
  const [activeSimIdx, setActiveSimIdx] = useState(null);

  // UI States
  const [isSimModalOpen, setIsSimModalOpen] = useState(false);
  const [loadingSim, setLoadingSim] = useState(false);
  const [retraining, setRetraining] = useState(false);
  const [retrainLogs, setRetrainLogs] = useState([]);
  const [showRetrainConfirm, setShowRetrainConfirm] = useState(false);

  // Live events accordion state
  const [expandedEventIds, setExpandedEventIds] = useState(new Set());

  // Sim form state
  const [simForm, setSimForm] = useState({
    eventType: "",
    eventCause: "",
    priority: "High",
    requiresRoadClosure: true,
    latitude: 12.97883,
    longitude: 77.59953,
  });

  // Close event modal
  const [closingEventId, setClosingEventId] = useState(null);
  const [closeForm, setCloseForm] = useState({
    actualDuration: 45,
    actualSeverity: 5.0,
    actualCongestion: "Moderate",
    actualImpactRadius: 1.0,
    actualResponseTime: 12,
    additionalOfficers: 0,
    additionalBarricades: 0,
    additionalVehicles: 0,
    adjustments: "None"
  });

  // Reassessment modal
  const [reassessingEventId, setReassessingEventId] = useState(null);
  const [reassessmentText, setReassessmentText] = useState("");
  const [reassessLoading, setReassessLoading] = useState(false);

  // Station capacity edit
  const [selectedStationToEdit, setSelectedStationToEdit] = useState("");
  const [stationEditForm, setStationEditForm] = useState({ totalOfficers: 0, totalBarricades: 0, totalVehicles: 0 });

  // Infrastructure sorting
  const [infraSort, setInfraSort] = useState({ col: 'name', dir: 'asc' });

  // Response card state
  const [rcEventCause, setRcEventCause] = useState("");
  const [rcCorridor, setRcCorridor] = useState("");
  const [rcTimeOfDay, setRcTimeOfDay] = useState("Evening Rush (4-9 PM)");
  const [responseCard, setResponseCard] = useState(null);
  const [rcLoading, setRcLoading] = useState(false);

  // Expandable sections state (for AI plan expanders in sim)
  const [expandedSections, setExpandedSections] = useState({});
  const toggleSection = (key) => setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));

  // Heatmap state
  const [heatmapData, setHeatmapData] = useState([]);
  const [heatmapTimelineIdx, setHeatmapTimelineIdx] = useState(0);
  const [heatmapIntensityCount, setHeatmapIntensityCount] = useState(0);
  const [heatmapPointCount, setHeatmapPointCount] = useState(0);

  // Map references
  const mapRef = useRef(null);
  const leafletMapInstance = useRef(null);
  const leafletDensityMapInstance = useRef(null);
  const densityMapRef = useRef(null);
  const mapLayersRef = useRef([]);
  const densityMapLayersRef = useRef([]);
  const densityHeatLayerRef = useRef(null);
  const stationMarkersRef = useRef([]);       // for sim map station stars only

  // Fetch data on mount
  useEffect(() => {
    fetchAll();
    const interval = setInterval(() => {
      fetchStations();
      fetchEvents();
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const fetchAll = () => {
    fetchStations();
    fetchEvents();
    fetchMappings();
    fetchFeatureImportance();
    fetchHistoricalEvents();
    fetchModelMetrics();
    fetchArchives();
    fetchResponseCardOptions();
    fetchHeatmapData();
  };

  const fetchStations = async () => {
    try {
      const res = await fetch(`${API_URL}/stations`);
      if (res.ok) setStations(await res.json());
    } catch (e) { console.error("Error fetching stations:", e); }
  };

  const fetchEvents = async () => {
    try {
      const res = await fetch(`${API_URL}/events`);
      if (res.ok) setLiveEvents(await res.json());
    } catch (e) { console.error("Error fetching events:", e); }
  };

  const fetchMappings = async () => {
    try {
      const res = await fetch(`${API_URL}/mappings`);
      if (res.ok) {
        const data = await res.json();
        setMappings(data);
        if (data.event_type && data.event_cause) {
          setSimForm(f => ({
            ...f,
            eventType: Object.keys(data.event_type)[0] || "",
            eventCause: Object.keys(data.event_cause)[0] || ""
          }));
          setRcEventCause(Object.keys(data.event_cause)[0] || "");
        }
      }
    } catch (e) { console.error("Error fetching mappings:", e); }
  };

  const fetchFeatureImportance = async () => {
    try {
      const res = await fetch(`${API_URL}/feature_importance`);
      if (res.ok) setFeatureImportance(await res.json());
    } catch (e) { console.error("Error fetching feature importance:", e); }
  };

  const fetchHistoricalEvents = async () => {
    try {
      const res = await fetch(`${API_URL}/historical_events`);
      if (res.ok) setHistoricalEvents(await res.json());
    } catch (e) { console.error("Error fetching historical events:", e); }
  };

  const fetchModelMetrics = async () => {
    try {
      const res = await fetch(`${API_URL}/model_metrics`);
      if (res.ok) setModelMetrics(await res.json());
    } catch (e) { console.error("Error fetching model metrics:", e); }
  };

  const fetchArchives = async () => {
    try {
      const res = await fetch(`${API_URL}/archives`);
      if (res.ok) setArchives(await res.json());
    } catch (e) { console.error("Error fetching archives:", e); }
  };

  const fetchResponseCardOptions = async () => {
    try {
      const res = await fetch(`${API_URL}/response_card_options`);
      if (res.ok) setResponseCardOptions(await res.json());
    } catch (e) { console.error("Error fetching response card options:", e); }
  };

  const fetchHeatmapData = async () => {
    try {
      const res = await fetch(`${API_URL}/api/heatmap`);
      if (res.ok) {
        const data = await res.json();
        setHeatmapData(data || []);
      }
    } catch (e) { console.error("Error fetching heatmap data:", e); }
  };

  // Build zoom-aware station star markers for a Leaflet map instance
  const addStationStarMarkers = useCallback((mapInstance, markersArrayRef) => {
    // Clear previous station markers
    markersArrayRef.current.forEach(m => m.remove());
    markersArrayRef.current = [];

    const zoom = mapInstance.getZoom();

    Object.entries(stations).forEach(([name, s]) => {
      if (!s.latitude || !s.longitude) return;

      // Compute size based on zoom level
      let starSize = 0;
      if (zoom >= 14) starSize = 22;
      else if (zoom >= 13) starSize = 18;
      else if (zoom >= 12) starSize = 14;
      else if (zoom >= 11) starSize = 10;
      // Below zoom 11 → don't show

      if (starSize === 0) return;

      const marker = L.marker([s.latitude, s.longitude], {
        icon: L.divIcon({
          className: '',
          html: `<div style="
            width: ${starSize}px; height: ${starSize}px;
            background: #1565C0;
            clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
            filter: drop-shadow(0 1px 3px rgba(0,0,0,0.45));
            transition: all 0.2s;
          "></div>`,
          iconSize: [starSize, starSize],
          iconAnchor: [starSize / 2, starSize / 2],
        })
      }).addTo(mapInstance);

      marker.bindTooltip(name, {
        permanent: false,
        direction: 'top',
        className: 'station-tooltip',
        offset: [0, -starSize / 2]
      });

      markersArrayRef.current.push(marker);
    });
  }, [stations]);

  // Listen for zoom events on sim map
  useEffect(() => {
    const map = leafletMapInstance.current;
    if (!map) return;
    const handleZoom = () => addStationStarMarkers(map, stationMarkersRef);
    map.on('zoomend', handleZoom);
    return () => map.off('zoomend', handleZoom);
  }, [addStationStarMarkers]);

  // NOTE: No station markers on density map (only shown on simulation map)

  // Simulation map effect
  useEffect(() => {
    if (activeTab !== "simulation" || !mapRef.current) {
      if (leafletMapInstance.current) {
        leafletMapInstance.current.off('zoomend');
        leafletMapInstance.current.remove();
        leafletMapInstance.current = null;
      }
      stationMarkersRef.current = [];
      return;
    }

    let center = [12.97883, 77.59953];
    if (activeSimIdx !== null && simList[activeSimIdx]) {
      center = [simList[activeSimIdx].params.latitude, simList[activeSimIdx].params.longitude];
    }

    if (!leafletMapInstance.current) {
      const bangaloreBounds = L.latLngBounds([12.8, 77.4], [13.1, 77.8]);
      leafletMapInstance.current = L.map(mapRef.current, {
        center, zoom: 13,
        maxBounds: bangaloreBounds,
        maxBoundsViscosity: 0.8,
        minZoom: 11
      });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
      }).addTo(leafletMapInstance.current);

      // Attach zoom listener
      leafletMapInstance.current.on('zoomend', () => {
        addStationStarMarkers(leafletMapInstance.current, stationMarkersRef);
      });
    } else {
      leafletMapInstance.current.setView(center, leafletMapInstance.current.getZoom());
    }

    // Clear event layers (no road coloring)
    mapLayersRef.current.forEach(l => l.remove());
    mapLayersRef.current = [];

    // Add Live Event impact zones & markers
    Object.entries(liveEvents).forEach(([id, ev]) => {
      const sev = ev.severity_index || 5.0;
      const closed = ev.requires_road_closure;
      const radKm = ev.impact_radius_km || 1.0;

      let color = "#28A745";
      if (closed) color = "#8B0000";
      else if (sev >= 7.0) color = "#DC3545";
      else if (sev >= 5.0) color = "#FD7E14";
      else if (sev >= 3.0) color = "#FFC107";

      const circle = L.circle([ev.latitude, ev.longitude], {
        radius: radKm * 1000, color, fillColor: color, fillOpacity: 0.12, weight: 1
      }).addTo(leafletMapInstance.current);
      circle.bindTooltip(`Live Impact Radius: ${radKm.toFixed(2)} km`);
      mapLayersRef.current.push(circle);

      const marker = L.marker([ev.latitude, ev.longitude], {
        icon: L.divIcon({
          className: '',
          html: `<div style="background:${color};width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 0 6px rgba(0,0,0,0.3);"></div>`
        })
      }).addTo(leafletMapInstance.current);
      marker.bindPopup(`<div style="font-family:'Outfit',sans-serif"><strong>LIVE: ${id}</strong><br/>Cause: ${ev.event_cause}<br/>Severity: ${sev.toFixed(1)}/10<br/>Congestion: ${ev.congestion_level || 'N/A'}</div>`);
      mapLayersRef.current.push(marker);
    });

    // Add sim markers + routes (no road segment coloring)
    simList.forEach((sim, idx) => {
      const isCurrent = idx === activeSimIdx;
      const sp = sim.params;
      const sr = sim.results;
      const color = isCurrent ? "#007BFF" : "#6C757D";

      const marker = L.marker([sp.latitude, sp.longitude], {
        icon: L.divIcon({
          className: '',
          html: `<div style="background:${color};width:16px;height:16px;border-radius:50%;border:2px solid white;display:flex;align-items:center;justify-content:center;box-shadow:0 0 8px rgba(0,0,0,0.4);color:white;font-size:9px;font-weight:bold;">${idx + 1}</div>`
        })
      }).addTo(leafletMapInstance.current);
      marker.bindPopup(`<div style="font-family:'Outfit',sans-serif"><strong>Simulation #${idx + 1} ${isCurrent ? '⭐ Active' : ''}</strong><br/>Cause: ${sp.event_cause}<br/>Priority: ${sp.priority}</div>`);
      marker.on('click', () => setActiveSimIdx(idx));
      mapLayersRef.current.push(marker);

      if (sr && sr.alternative_paths) {
        const routeColors = ["#007BFF", "#28A745", "#FFC107"];
        sr.alternative_paths.forEach((path, pIdx) => {
          const poly = L.polyline(path.coords, {
            color: routeColors[pIdx % routeColors.length], weight: 5 - pIdx, opacity: 0.95
          }).addTo(leafletMapInstance.current);
          poly.bindTooltip(`Route ${pIdx + 1}: ${path.travel_time_mins} mins (${path.distance_km} km)`);
          mapLayersRef.current.push(poly);
        });
      }
    });

    // Render station stars
    addStationStarMarkers(leafletMapInstance.current, stationMarkersRef);

  }, [activeTab, simList, activeSimIdx, liveEvents, addStationStarMarkers]);

  // Heatmap months config (matches density.zip)
  const HEATMAP_MONTHS = [
    { label: 'All Data', value: 'all' },
    { label: 'Nov 2023', value: '2023-11' },
    { label: 'Dec 2023', value: '2023-12' },
    { label: 'Jan 2024', value: '2024-01' },
    { label: 'Feb 2024', value: '2024-02' },
    { label: 'Mar 2024', value: '2024-03' },
    { label: 'Apr 2024', value: '2024-04' },
  ];

  // Render heatmap points based on selected month
  const renderDensityHeatmap = useCallback((map, data, monthIdx) => {
    if (!map || !L.heatLayer) return;

    // Remove previous heat layer
    if (densityHeatLayerRef.current) {
      map.removeLayer(densityHeatLayerRef.current);
      densityHeatLayerRef.current = null;
    }

    const mapping = HEATMAP_MONTHS[monthIdx] || HEATMAP_MONTHS[0];
    let filteredPoints = [];
    let totalIntensity = 0;

    if (mapping.value === 'all') {
      const coordMap = {};
      data.forEach(p => {
        const key = `${p.lat?.toFixed(3)},${p.lon?.toFixed(3)}`;
        coordMap[key] = (coordMap[key] || 0) + (p.intensity || 1);
      });
      for (const key in coordMap) {
        const [latStr, lonStr] = key.split(',');
        filteredPoints.push([parseFloat(latStr), parseFloat(lonStr), coordMap[key]]);
        totalIntensity += coordMap[key];
      }
    } else {
      data.forEach(p => {
        if (p.month === mapping.value) {
          filteredPoints.push([p.lat, p.lon, p.intensity || 1]);
          totalIntensity += (p.intensity || 1);
        }
      });
    }

    setHeatmapIntensityCount(totalIntensity);
    setHeatmapPointCount(filteredPoints.length);

    if (filteredPoints.length === 0) return;

    const maxIntensity = Math.max(...filteredPoints.map(p => p[2]));
    densityHeatLayerRef.current = L.heatLayer(filteredPoints, {
      radius: 20,
      blur: 15,
      maxZoom: 15,
      max: maxIntensity * 0.7,
      gradient: { 0.2: '#3B82F6', 0.4: '#8B5CF6', 0.6: '#F59E0B', 0.8: '#EF4444', 1.0: '#FF0000' }
    }).addTo(map);
  }, []);

  // Density map effect
  useEffect(() => {
    if (activeTab !== "density" || !densityMapRef.current) {
      if (leafletDensityMapInstance.current) {
        leafletDensityMapInstance.current.off('zoomend');
        leafletDensityMapInstance.current.remove();
        leafletDensityMapInstance.current = null;
      }
      densityHeatLayerRef.current = null;
      return;
    }

    // Register leaflet-heat plugin inline if not already present
    if (!L.heatLayer) {
      (function () {
        function simpleheat(canvas) {
          if (!(this instanceof simpleheat)) return new simpleheat(canvas);
          this._canvas = canvas = typeof canvas === 'string' ? document.getElementById(canvas) : canvas;
          this._ctx = canvas.getContext('2d');
          this._width = canvas.width;
          this._height = canvas.height;
          this._max = 1;
          this._data = [];
        }
        simpleheat.prototype = {
          defaultRadius: 25,
          defaultGradient: { 0.4: 'blue', 0.6: 'cyan', 0.7: 'lime', 0.8: 'yellow', 1.0: 'red' },
          data: function (data) { this._data = data; return this; },
          max: function (max) { this._max = max; return this; },
          add: function (point) { this._data.push(point); return this; },
          clear: function () { this._data = []; return this; },
          radius: function (r, blur) {
            blur = blur === undefined ? 15 : blur;
            var circle = this._circle = this._createCanvas();
            var ctx = circle.getContext('2d');
            var r2 = this._r = r + blur;
            circle.width = circle.height = r2 * 2;
            ctx.shadowOffsetX = ctx.shadowOffsetY = r2 * 2;
            ctx.shadowBlur = blur;
            ctx.shadowColor = 'black';
            ctx.beginPath();
            ctx.arc(-r2, -r2, r, 0, Math.PI * 2, true);
            ctx.closePath();
            ctx.fill();
            return this;
          },
          resize: function () { this._width = this._canvas.width; this._height = this._canvas.height; },
          gradient: function (grad) {
            var canvas = this._createCanvas();
            var ctx = canvas.getContext('2d');
            var gradient = ctx.createLinearGradient(0, 0, 0, 256);
            canvas.width = 1;
            canvas.height = 256;
            for (var i in grad) { gradient.addColorStop(+i, grad[i]); }
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, 1, 256);
            this._grad = ctx.getImageData(0, 0, 1, 256).data;
            return this;
          },
          draw: function (minOpacity) {
            if (!this._circle) this.radius(this.defaultRadius);
            if (!this._grad) this.gradient(this.defaultGradient);
            var ctx = this._ctx;
            ctx.clearRect(0, 0, this._width, this._height);
            for (var i = 0, len = this._data.length, p; i < len; i++) {
              p = this._data[i];
              ctx.globalAlpha = Math.min(Math.max(p[2] / this._max, minOpacity === undefined ? 0.05 : minOpacity), 1);
              ctx.drawImage(this._circle, p[0] - this._r, p[1] - this._r);
            }
            var colored = ctx.getImageData(0, 0, this._width, this._height);
            this._colorize(colored.data, this._grad);
            ctx.putImageData(colored, 0, 0);
            return this;
          },
          _colorize: function (pixels, gradient) {
            for (var i = 0, len = pixels.length, j; i < len; i += 4) {
              j = pixels[i + 3] * 4;
              if (j) { pixels[i] = gradient[j]; pixels[i + 1] = gradient[j + 1]; pixels[i + 2] = gradient[j + 2]; }
            }
          },
          _createCanvas: function () {
            if (typeof document !== 'undefined') return document.createElement('canvas');
            var c = new OffscreenCanvas(1, 1);
            return c;
          }
        };

        L.HeatLayer = (L.Layer ? L.Layer : L.Class).extend({
          initialize: function (latlngs, options) { this._latlngs = latlngs; L.setOptions(this, options); },
          setLatLngs: function (latlngs) { this._latlngs = latlngs; return this.redraw(); },
          addLatLng: function (latlng) { this._latlngs.push(latlng); return this.redraw(); },
          setOptions: function (options) { L.setOptions(this, options); if (this._heat) { this._updateOptions(); } return this.redraw(); },
          redraw: function () { if (this._heat && !this._frame && this._map && !this._map._animating) { this._frame = L.Util.requestAnimFrame(this._redraw, this); } return this; },
          onAdd: function (map) {
            this._map = map;
            if (!this._canvas) this._initCanvas();
            if (this.options.pane) this.getPane().appendChild(this._canvas);
            else map._panes.overlayPane.appendChild(this._canvas);
            map.on('moveend', this._reset, this);
            if (map.options.zoomAnimation && L.Browser.any3d) map.on('zoomanim', this._animateZoom, this);
            this._reset();
          },
          onRemove: function (map) {
            if (this.options.pane) this.getPane().removeChild(this._canvas);
            else map.getPanes().overlayPane.removeChild(this._canvas);
            map.off('moveend', this._reset, this);
            if (map.options.zoomAnimation) map.off('zoomanim', this._animateZoom, this);
          },
          addTo: function (map) { map.addLayer(this); return this; },
          _initCanvas: function () {
            var canvas = this._canvas = L.DomUtil.create('canvas', 'leaflet-heatmap-layer leaflet-layer');
            var originProp = L.DomUtil.testProp(['transformOrigin', 'WebkitTransformOrigin', 'msTransformOrigin']);
            canvas.style[originProp] = '50% 50%';
            var animated = this._map.options.zoomAnimation && L.Browser.any3d;
            L.DomUtil.addClass(canvas, 'leaflet-zoom-' + (animated ? 'animated' : 'hide'));
            this._heat = simpleheat(canvas);
            this._updateOptions();
          },
          _updateOptions: function () {
            this._heat.radius(this.options.radius || this._heat.defaultRadius, this.options.blur);
            if (this.options.gradient) this._heat.gradient(this.options.gradient);
            if (this.options.max) this._heat.max(this.options.max);
          },
          _reset: function () {
            var topLeft = this._map.containerPointToLayerPoint([0, 0]);
            L.DomUtil.setPosition(this._canvas, topLeft);
            var size = this._map.getSize();
            if (this._heat._width !== size.x) { this._canvas.width = this._heat._width = size.x; }
            if (this._heat._height !== size.y) { this._canvas.height = this._heat._height = size.y; }
            this._redraw();
          },
          _redraw: function () {
            if (!this._map) return;
            var data = [], r = this._heat._r, size = this._map.getSize(),
              bounds = new L.Bounds(L.point([-r, -r]), size.add([r, r])),
              max = this.options.max === undefined ? 1 : this.options.max,
              maxZoom = this.options.maxZoom === undefined ? this._map.getMaxZoom() : this.options.maxZoom,
              v = 1 / Math.pow(2, Math.max(0, Math.min(maxZoom - this._map.getZoom(), 12))),
              cellSize = r / 2,
              grid = [], offsetX = this._canvas.getBoundingClientRect().left, offsetY = this._canvas.getBoundingClientRect().top, i, len, p, cell;
            for (i = 0, len = this._latlngs.length; i < len; i++) {
              p = this._map.latLngToContainerPoint(this._latlngs[i]);
              var x = Math.floor(p.x / cellSize) + 2, y = Math.floor(p.y / cellSize) + 2;
              var alt = this._latlngs[i].alt !== undefined ? this._latlngs[i].alt : (this._latlngs[i][2] !== undefined ? +this._latlngs[i][2] : 1);
              var k = alt * v;
              grid[y] = grid[y] || [];
              cell = grid[y][x];
              if (!cell) {
                grid[y][x] = [p.x, p.y, k];
              } else {
                cell[0] = (cell[0] * cell[2] + p.x * k) / (cell[2] + k);
                cell[1] = (cell[1] * cell[2] + p.y * k) / (cell[2] + k);
                cell[2] += k;
              }
            }
            for (i = 0, len = grid.length; i < len; i++) {
              if (grid[i]) {
                for (var j = 0, len2 = grid[i].length; j < len2; j++) {
                  cell = grid[i][j];
                  if (cell) {
                    p = [Math.round(cell[0]), Math.round(cell[1]), Math.min(cell[2], max)];
                    if (bounds.contains(p)) data.push(p);
                  }
                }
              }
            }
            this._heat.data(data).draw(this.options.minOpacity);
            this._frame = null;
          },
          _animateZoom: function (e) {
            var scale = this._map.getZoomScale(e.zoom),
              offset = this._map._getCenterOffset(e.center)._multiplyBy(-scale).subtract(this._map._getMapPanePos());
            if (L.DomUtil.setTransform) L.DomUtil.setTransform(this._canvas, offset, scale);
            else this._canvas.style[L.DomUtil.TRANSFORM] = L.DomUtil.getTranslateString(offset) + ' scale(' + scale + ')';
          }
        });
        L.heatLayer = function (latlngs, options) { return new L.HeatLayer(latlngs, options); };
      })();
    }

    if (!leafletDensityMapInstance.current) {
      const bangaloreBounds = L.latLngBounds([12.7, 77.3], [13.15, 77.9]);
      leafletDensityMapInstance.current = L.map(densityMapRef.current, {
        center: [12.97883, 77.59953], zoom: 12,
        maxBounds: bangaloreBounds, maxBoundsViscosity: 0.8, minZoom: 10
      });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19
      }).addTo(leafletDensityMapInstance.current);

      // No zoom listener for stations on density map
    }

    // Render heatmap only (no station markers on density map)
    renderDensityHeatmap(leafletDensityMapInstance.current, heatmapData, heatmapTimelineIdx);
  }, [activeTab, heatmapData, heatmapTimelineIdx, renderDensityHeatmap]);

  // Run simulation
  const handleRunSimulation = async (e) => {
    e.preventDefault();
    setIsSimModalOpen(false);
    setLoadingSim(true);

    const newSim = {
      params: {
        event_type: simForm.eventType,
        event_cause: simForm.eventCause,
        priority: simForm.priority,
        requires_road_closure: simForm.requiresRoadClosure,
        latitude: parseFloat(simForm.latitude),
        longitude: parseFloat(simForm.longitude),
        start_datetime_ist: new Date().toISOString()
      },
      results: null
    };

    try {
      const resPred = await fetch(`${API_URL}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSim.params)
      });
      if (resPred.ok) {
        const predRes = await resPred.json();

        const resAlloc = await fetch(`${API_URL}/allocate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            incidents: [{
              id: `SIM_${simList.length}`,
              latitude: newSim.params.latitude,
              longitude: newSim.params.longitude,
              severity_index: predRes.predicted_severity_index,
              requires_road_closure: newSim.params.requires_road_closure
            }],
            stations: Object.values(stations).map(si => ({
              name: si.name,
              latitude: si.latitude,
              longitude: si.longitude,
              available_officers: si.available_officers,
              available_barricades: si.available_barricades,
              available_vehicles: si.available_vehicles
            }))
          })
        });
        const allocRes = resAlloc.ok ? await resAlloc.json() : { allocations: [] };

        newSim.results = {
          predictions: predRes,
          recommendations: predRes.recommendations || {},
          allocation: allocRes,
          alternative_paths: []
        };

        const updatedList = [...simList, newSim];
        setSimList(updatedList);
        setActiveSimIdx(updatedList.length - 1);
      }
    } catch (e) {
      alert(`Simulation failed: ${e.message}`);
    } finally {
      setLoadingSim(false);
    }
  };

  const updateSimAllocation = (dispIdx, field, val) => {
    if (activeSimIdx === null) return;
    const listCopy = [...simList];
    const sim = listCopy[activeSimIdx];
    if (sim.results?.allocation?.allocations?.[0]) {
      sim.results.allocation.allocations[0].dispatches[dispIdx][field] = parseInt(val);
      setSimList(listCopy);
    }
  };

  // Deploy sim to live
  const handleDeployEvent = async (sim) => {
    const pred = sim.results.predictions;
    const sp = sim.params;
    const dispatches = sim.results.allocation.allocations[0]?.dispatches || [];
    const deployPayload = {
      id: `EV_${new Date().toISOString().slice(5, 19).replace(/[:-]/g, '').replace('T', '_')}`,
      event_type: sp.event_type,
      event_cause: sp.event_cause,
      latitude: sp.latitude,
      longitude: sp.longitude,
      priority: sp.priority,
      requires_road_closure: sp.requires_road_closure,
      severity_index: pred.predicted_severity_index,
      duration_mins: pred.predicted_duration_mins,
      congestion_level: pred.predicted_congestion_level,
      impact_radius_km: pred.predicted_impact_radius_km,
      response_time_mins: pred.predicted_response_time_mins,
      dispatches,
      alternative_paths: sim.results.alternative_paths || [],
      start_datetime_ist: sp.start_datetime_ist
    };
    try {
      const res = await fetch(`${API_URL}/events/deploy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deployPayload)
      });
      if (res.ok) {
        const updated = simList.filter((_, idx) => idx !== activeSimIdx);
        setSimList(updated);
        setActiveSimIdx(updated.length > 0 ? 0 : null);
        fetchStations(); fetchEvents();
      } else alert(await res.text());
    } catch (e) { alert(`Deployment failed: ${e.message}`); }
  };

  // Close event
  const handleCloseEventSubmit = async (e) => {
    e.preventDefault();
    if (!closingEventId) return;
    try {
      const res = await fetch(`${API_URL}/events/close`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: closingEventId,
          actual_duration_mins: parseFloat(closeForm.actualDuration),
          actual_severity_index: parseFloat(closeForm.actualSeverity),
          actual_congestion: closeForm.actualCongestion,
          actual_impact_radius_km: parseFloat(closeForm.actualImpactRadius),
          actual_response_time_mins: parseFloat(closeForm.actualResponseTime),
          additional_officers_requested: parseInt(closeForm.additionalOfficers),
          additional_barricades_requested: parseInt(closeForm.additionalBarricades),
          additional_vehicles_requested: parseInt(closeForm.additionalVehicles),
          manual_operator_adjustments: closeForm.adjustments
        })
      });
      if (res.ok) {
        setClosingEventId(null);
        fetchStations(); fetchEvents(); fetchArchives();
      } else alert(await res.text());
    } catch (e) { alert(`Error closing event: ${e.message}`); }
  };

  const handleReassessEvent = async (id) => {
    setReassessingEventId(id);
    setReassessmentText("");
    setReassessLoading(true);
    try {
      const res = await fetch(`${API_URL}/events/reassess`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (res.ok) {
        const data = await res.json();
        setReassessmentText(
          data.resource_recommendations +
          "\n\nManpower: " + data.officer_allocation +
          "\n\nBarricades: " + data.barricade_placement
        );
      }
    } catch (e) { setReassessmentText(`Failed: ${e.message}`); }
    finally { setReassessLoading(false); }
  };

  const handleUpdateStationCapacity = async (e) => {
    e.preventDefault();
    if (!selectedStationToEdit) return;
    try {
      const res = await fetch(`${API_URL}/stations/update`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: selectedStationToEdit,
          total_officers: parseInt(stationEditForm.totalOfficers),
          total_barricades: parseInt(stationEditForm.totalBarricades),
          total_vehicles: parseInt(stationEditForm.totalVehicles)
        })
      });
      if (res.ok) { fetchStations(); alert("Capacity updated!"); }
    } catch (e) { alert(e.message); }
  };

  const handleTriggerRetraining = async () => {
    setShowRetrainConfirm(false);
    setRetraining(true);
    setRetrainLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] Initiating retrain cycle with ${archives.length} post-event records...`]);
    try {
      const res = await fetch(`${API_URL}/retrain`, { method: 'POST' });
      if (res.ok) {
        setRetrainLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] Retraining in progress — processing new data...`]);
        setTimeout(() => {
          fetchFeatureImportance();
          fetchModelMetrics();
          setRetrainLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ✅ Retrain complete. Models updated and deployed.`]);
          setRetraining(false);
        }, 4000);
      }
    } catch (e) {
      setRetrainLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ❌ Error: ${e.message}`]);
      setRetraining(false);
    }
  };

  const handleSelectPreset = (name) => {
    const preset = LOCATION_PRESETS.find(p => p.name === name);
    if (preset) setSimForm(f => ({ ...f, latitude: preset.lat, longitude: preset.lon }));
  };

  // Toggle live event accordion
  const toggleEventExpand = (id) => {
    setExpandedEventIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Infrastructure table sorting
  const sortedStations = (() => {
    const entries = Object.entries(stations);
    return entries.sort(([nameA, a], [nameB, b]) => {
      const { col, dir } = infraSort;
      let valA, valB;
      if (col === 'name') { valA = nameA; valB = nameB; }
      else if (col === 'officers') { valA = a.available_officers; valB = b.available_officers; }
      else if (col === 'barricades') { valA = a.available_barricades; valB = b.available_barricades; }
      else if (col === 'vehicles') { valA = a.available_vehicles; valB = b.available_vehicles; }
      else if (col === 'tier') { valA = a.tier || ''; valB = b.tier || ''; }
      if (valA < valB) return dir === 'asc' ? -1 : 1;
      if (valA > valB) return dir === 'asc' ? 1 : -1;
      return 0;
    });
  })();

  const SortBtn = ({ col, label }) => {
    const isActive = infraSort.col === col;
    return (
      <button
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          display: 'flex', alignItems: 'center', gap: '4px',
          color: isActive ? 'var(--primary)' : 'inherit', fontWeight: isActive ? 700 : 600,
          fontSize: '0.8rem'
        }}
        onClick={() => setInfraSort(s => ({
          col, dir: s.col === col && s.dir === 'asc' ? 'desc' : 'asc'
        }))}
      >
        {label}
        {isActive ? (infraSort.dir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />) : <ChevronDown size={13} style={{ opacity: 0.3 }} />}
      </button>
    );
  };

  // Fetch response card
  const handleGetResponseCard = async () => {
    setRcLoading(true);
    setResponseCard(null);
    try {
      const params = new URLSearchParams({ event_cause: rcEventCause });
      if (rcCorridor) params.append('corridor', rcCorridor);
      if (rcTimeOfDay) params.append('time_of_day', rcTimeOfDay);
      const res = await fetch(`${API_URL}/response_card?${params}`);
      if (res.ok) setResponseCard(await res.json());
      else alert("Failed to fetch response card");
    } catch (e) { alert(e.message); }
    finally { setRcLoading(false); }
  };

  // ────────────────────────────── RENDER ──────────────────────────────
  return (
    <div className="app-container">
      <header className="header">
        <div className="header-title-group">
          <h1 className="header-title">GridAI Control Room</h1>
          <span className="header-subtitle">Bangalore Emergency Dispatch & Response Intelligence</span>
        </div>
        <nav className="nav-tabs">
          {[
            { id: 'simulation', label: 'Event Simulation', icon: <MapIcon size={15} /> },
            { id: 'live-events', label: 'Active Events', icon: <Radio size={15} /> },
            { id: 'infrastructure', label: 'Infrastructure', icon: <Shield size={15} /> },
            { id: 'density', label: 'Density Map', icon: <Activity size={15} /> },
            { id: 'response-cards', label: 'Response Cards', icon: <FileText size={15} /> },
            { id: 'archives', label: 'Archives', icon: <Archive size={15} /> },
          ].map(({ id, label, icon }) => (
            <button key={id} className={`nav-tab ${activeTab === id ? 'active' : ''}`} onClick={() => setActiveTab(id)}>
              {icon} {label}
              {id === 'live-events' && Object.keys(liveEvents).length > 0 && (
                <span className="badge badge-live" style={{ marginLeft: '6px', fontSize: '0.65rem', padding: '2px 6px' }}>
                  {Object.keys(liveEvents).length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="main-content">

        {/* ── TAB 1: SIMULATION ── */}
        {activeTab === 'simulation' && (
          <div className="grid-2-3">
            <div>
              <div className="card" style={{ padding: 0, position: 'relative', overflow: 'hidden' }}>
                <div style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 className="card-title" style={{ margin: 0 }}><MapIcon size={18} /> Dispatch Map</h2>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Bangalore Jurisdiction • ★ = Police Station</span>
                </div>
                <div ref={mapRef} style={{ height: '580px', width: '100%' }}></div>
              </div>
            </div>

            <div>
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                  <h3 className="card-title" style={{ margin: 0 }}><BarChart2 size={18} /> Forecast & Simulation Plan</h3>
                  <button className="btn btn-primary" onClick={() => setIsSimModalOpen(true)}>
                    <Plus size={16} /> Simulate New
                  </button>
                </div>

                {loadingSim && (
                  <div style={{ textAlign: 'center', padding: '3rem 0' }}>
                    <RefreshCw style={{ animation: 'spin 1.5s linear infinite', color: 'var(--primary)', marginBottom: '1rem' }} size={32} />
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Running prediction models & allocating resources...</p>
                  </div>
                )}

                {!loadingSim && simList.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '4rem 1rem', background: '#F8F9FA', borderRadius: '12px', border: '1px dashed var(--border)' }}>
                    <MapPin size={36} style={{ color: 'var(--text-muted)', marginBottom: '0.75rem' }} />
                    <h4 style={{ fontWeight: 600, marginBottom: '0.25rem' }}>No Active Simulations</h4>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', maxWidth: '300px', margin: '0 auto 1.25rem' }}>
                      Click "Simulate New" to specify location, type, and cause to predict outcomes.
                    </p>
                    {Object.keys(liveEvents).length > 0 && (
                      <div style={{ background: '#FFF3CD', border: '1px solid #FFC107', borderRadius: '8px', padding: '0.75rem', fontSize: '0.85rem', color: '#856404' }}>
                        <AlertTriangle size={14} style={{ marginRight: '6px' }} />
                        {Object.keys(liveEvents).length} live event(s) active — check the Active Events tab.
                      </div>
                    )}
                  </div>
                )}

                {!loadingSim && simList.length > 0 && activeSimIdx !== null && simList[activeSimIdx] && (() => {
                  const sim = simList[activeSimIdx];
                  const pred = sim.results?.predictions;
                  const rec = sim.results?.recommendations;
                  return (
                    <div>
                      {simList.length > 1 && (
                        <div className="form-group" style={{ marginBottom: '1.25rem' }}>
                          <label className="sim-select-label">Select Simulation:</label>
                          <select className="form-control" value={activeSimIdx} onChange={e => setActiveSimIdx(parseInt(e.target.value))}>
                            {simList.map((s, i) => (
                              <option key={i} value={i}>Sim #{i + 1} · {s.params.event_cause.toUpperCase()} ({s.params.priority})</option>
                            ))}
                          </select>
                        </div>
                      )}

                      <div style={{ padding: '0.75rem 1rem', background: '#F1F3F5', borderRadius: '8px', fontSize: '0.85rem', marginBottom: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div><strong>Simulated:</strong> {sim.params.event_cause.toUpperCase()} @ ({sim.params.latitude.toFixed(4)}, {sim.params.longitude.toFixed(4)})</div>
                        <button className="btn btn-secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                          onClick={() => {
                            const updated = simList.filter((_, idx) => idx !== activeSimIdx);
                            setSimList(updated);
                            setActiveSimIdx(updated.length > 0 ? 0 : null);
                          }}>
                          <Trash2 size={13} /> Discard
                        </button>
                      </div>

                      {pred && (
                        <div>
                          <div className="metrics-row">
                            <div className="metric-card">
                              <div className="metric-value">{pred.predicted_severity_index.toFixed(1)}/10</div>
                              <div className="metric-label">Severity</div>
                            </div>
                            <div className="metric-card">
                              <div className="metric-value">{pred.predicted_duration_mins.toFixed(0)}m</div>
                              <div className="metric-label">Duration</div>
                            </div>
                            <div className="metric-card">
                              <div className="metric-value">{pred.predicted_congestion_level}</div>
                              <div className="metric-label">Traffic</div>
                            </div>
                          </div>
                          <div className="metrics-row">
                            <div className="metric-card">
                              <div className="metric-value">{pred.predicted_impact_radius_km.toFixed(2)} km</div>
                              <div className="metric-label">Impact Rad</div>
                            </div>
                            <div className="metric-card">
                              <div className="metric-value">{pred.predicted_response_time_mins.toFixed(1)}m</div>
                              <div className="metric-label">Response Time</div>
                            </div>
                            <div className="metric-card">
                              <div className="metric-value" style={{ fontSize: '0.85rem' }}>{pred.closest_station_name || '—'}</div>
                              <div className="metric-label">Nearest Station</div>
                            </div>
                          </div>

                          <h4 style={{ fontSize: '0.9rem', fontWeight: 700, margin: '1rem 0 0.5rem' }}>🤖 AI Action Plan</h4>
                          <div style={{ background: '#F8F9FA', borderLeft: '4px solid var(--primary)', padding: '0.75rem', fontSize: '0.85rem', color: '#495057', borderRadius: '4px', marginBottom: '1rem' }}>
                            {rec?.resource_recommendations || "No recommendations generated."}
                          </div>

                          {[['manpower', 'Manpower Allocation Plan', rec?.officer_allocation], ['barricade', 'Barricade Protocols', rec?.barricade_placement], ['mitigation', 'Alternate Bypass & Risk Mitigation', rec?.risk_mitigation_strategies]].map(([key, title, text]) => (
                            <div key={key}>
                              <div className="expander-header" onClick={() => toggleSection(key)}>
                                {title} <span>{expandedSections[key] ? '▲' : '▼'}</span>
                              </div>
                              {expandedSections[key] && <div className="expander-body">{text || "—"}</div>}
                            </div>
                          ))}

                          <h4 style={{ fontSize: '0.9rem', fontWeight: 700, marginTop: '1.25rem', marginBottom: '0.75rem' }}>🚔 Resource Deployment</h4>
                          {sim.results.allocation?.allocations?.[0]?.dispatches?.map((disp, dIdx) => {
                            const stat = stations[disp.station_name] || {};
                            return (
                              <div key={dIdx} style={{ marginBottom: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                                  <span>{disp.station_name}</span>
                                  <span style={{ color: 'var(--text-muted)' }}>{disp.transit_distance_km?.toFixed(1) ?? '—'} km away</span>
                                </div>
                                <div className="form-row-2">
                                  {['officers', 'barricades', 'vehicles'].map(field => {
                                    const maxVal = (stat[`available_${field}`] || 0) + (disp[field] || 0);
                                    return (
                                      <div key={field} className="slider-group">
                                        <div className="slider-header">
                                          <span style={{ textTransform: 'capitalize' }}>{field}</span>
                                          <span>{disp[field]}</span>
                                        </div>
                                        <input type="range" className="slider-input" min="0" max={maxVal}
                                          value={disp[field]} onChange={e => updateSimAllocation(dIdx, field, e.target.value)} />
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}

                          <button className="btn btn-primary btn-block" style={{ marginTop: '1.25rem' }}
                            onClick={() => handleDeployEvent(sim)}>
                            Confirm Deployment → Live Event
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* ── TAB 2: ACTIVE LIVE EVENTS (accordion) ── */}
        {activeTab === 'live-events' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 className="card-title" style={{ margin: 0 }}><Radio size={18} /> Active Operations</h3>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                {Object.keys(liveEvents).length} event(s) active
              </span>
            </div>

            {Object.keys(liveEvents).length === 0 ? (
              <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
                <Check size={28} style={{ color: 'var(--success)', marginBottom: '0.5rem' }} />
                <p style={{ color: 'var(--text-muted)' }}>No active emergency events. All clear.</p>
              </div>
            ) : (
              Object.entries(liveEvents).map(([id, ev]) => {
                const deployedAt = new Date(ev.deployed_at);
                const now = new Date();
                const elapsedMins = (now - deployedAt) / (1000 * 60);
                const isOverdue = elapsedMins > (ev.duration_mins || 60);
                const isExpanded = expandedEventIds.has(id);

                return (
                  <div key={id} className="accordion-event-card" style={{ marginBottom: '0.75rem' }}>
                    {/* Accordion header */}
                    <div className="accordion-header" onClick={() => toggleEventExpand(id)}
                      style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '1rem 1.25rem', background: 'var(--bg-card)',
                        border: `1px solid ${isOverdue ? '#DC3545' : 'var(--border)'}`,
                        borderRadius: isExpanded ? '12px 12px 0 0' : '12px',
                        cursor: 'pointer', userSelect: 'none',
                        borderLeft: `4px solid ${isOverdue ? '#DC3545' : 'var(--primary)'}`,
                      }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{id}</div>
                          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                            {ev.event_cause?.toUpperCase()} · {ev.event_type} · {ev.priority} Priority
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                          {isOverdue
                            ? <span className="badge badge-overdue">⚠️ OVERDUE</span>
                            : <span className="badge badge-live">🔴 Live</span>
                          }
                          <span style={{ fontSize: '0.78rem', background: '#F1F3F5', padding: '3px 8px', borderRadius: '4px' }}>
                            Sev: {ev.severity_index?.toFixed(1)}/10
                          </span>
                          <span style={{ fontSize: '0.78rem', background: '#F1F3F5', padding: '3px 8px', borderRadius: '4px' }}>
                            {ev.impact_radius_km?.toFixed(2)} km radius
                          </span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                          {Math.round(elapsedMins)}m elapsed
                        </span>
                        {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                      </div>
                    </div>

                    {/* Accordion body */}
                    {isExpanded && (
                      <div style={{
                        border: `1px solid ${isOverdue ? '#DC3545' : 'var(--border)'}`,
                        borderTop: 'none', borderRadius: '0 0 12px 12px',
                        padding: '1.25rem', background: '#FAFAFA'
                      }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '1rem' }}>
                          {/* Details */}
                          <div>
                            <h4 style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--primary)' }}>📋 Event Details</h4>
                            {[
                              ['Event ID', id],
                              ['Cause', ev.event_cause],
                              ['Type', ev.event_type],
                              ['Priority', ev.priority],
                              ['Road Closure', ev.requires_road_closure ? 'Yes' : 'No'],
                              ['Location', `${ev.latitude?.toFixed(4)}, ${ev.longitude?.toFixed(4)}`],
                              ['Deployed At', new Date(ev.deployed_at).toLocaleString()],
                            ].map(([k, v]) => (
                              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '0.35rem', borderBottom: '1px solid #EAEAEA', paddingBottom: '0.3rem' }}>
                                <span style={{ color: 'var(--text-muted)' }}>{k}</span>
                                <span style={{ fontWeight: 600 }}>{v}</span>
                              </div>
                            ))}
                          </div>

                          {/* Predictions */}
                          <div>
                            <h4 style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--primary)' }}>📊 Predictions</h4>
                            {[
                              ['Severity', `${ev.severity_index?.toFixed(1)} / 10`],
                              ['Duration', `${ev.duration_mins?.toFixed(0)} mins`],
                              ['Congestion', ev.congestion_level],
                              ['Impact Radius', `${ev.impact_radius_km?.toFixed(2)} km`],
                              ['Response Time', `${ev.response_time_mins?.toFixed(1)} mins`],
                            ].map(([k, v]) => (
                              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '0.35rem', borderBottom: '1px solid #EAEAEA', paddingBottom: '0.3rem' }}>
                                <span style={{ color: 'var(--text-muted)' }}>{k}</span>
                                <span style={{ fontWeight: 600 }}>{v}</span>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Dispatches */}
                        {ev.dispatches?.length > 0 && (
                          <div style={{ marginBottom: '1rem' }}>
                            <h4 style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.5rem' }}>🚔 Deployed Resources</h4>
                            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                              {ev.dispatches.map((d, dIdx) => (
                                <div key={dIdx} style={{ background: '#E3F2FD', borderRadius: '8px', padding: '0.5rem 0.75rem', fontSize: '0.8rem' }}>
                                  <strong>{d.station_name}</strong>: {d.officers} Officers · {d.barricades} Barricades · {d.vehicles} Vehicles
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Actions */}
                        <div style={{ display: 'flex', gap: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                          <button className="btn btn-secondary" style={{ padding: '0.4rem 1rem', fontSize: '0.82rem' }}
                            onClick={() => handleReassessEvent(id)}>
                            🔍 Reassess
                          </button>
                          <button className="btn btn-danger" style={{ padding: '0.4rem 1rem', fontSize: '0.82rem' }}
                            onClick={() => {
                              setClosingEventId(id);
                              setCloseForm({
                                actualDuration: Math.round(ev.duration_mins || 45),
                                actualSeverity: ev.severity_index,
                                actualCongestion: ev.congestion_level || "Moderate",
                                actualImpactRadius: ev.impact_radius_km,
                                actualResponseTime: Math.round(ev.response_time_mins || 15),
                                additionalOfficers: 0, additionalBarricades: 0, additionalVehicles: 0,
                                adjustments: "None"
                              });
                            }}>
                            ✅ Close Event
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ── TAB 3: INFRASTRUCTURE ── */}
        {activeTab === 'infrastructure' && (
          <div className="grid-2-3">
            <div>
              <div className="card">
                <h3 className="card-title"><Shield size={18} /> Police Station Resource Status</h3>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                  Click column headers to sort. Default: alphabetical.
                </p>
                <div className="table-container">
                  <table className="table">
                    <thead>
                      <tr>
                        <th><SortBtn col="name" label="Station Name" /></th>
                        <th><SortBtn col="tier" label="Tier" /></th>
                        <th><SortBtn col="officers" label="Officers (Avail/Total)" /></th>
                        <th><SortBtn col="barricades" label="Barricades (Avail/Total)" /></th>
                        <th><SortBtn col="vehicles" label="Vehicles (Avail/Total)" /></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedStations.map(([name, s]) => (
                        <tr key={name}>
                          <td><strong>{name}</strong></td>
                          <td><span className="badge" style={{ background: '#E3F2FD', color: '#1565C0' }}>{s.tier || 'Tier 2'}</span></td>
                          <td>
                            <span style={{ color: s.available_officers < 3 ? 'var(--danger)' : 'inherit' }}>
                              {s.available_officers}
                            </span> / {s.total_officers}
                          </td>
                          <td>{s.available_barricades} / {s.total_barricades}</td>
                          <td>{s.available_vehicles} / {s.total_vehicles}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div>
              <div className="card">
                <h3 className="card-title"><Sliders size={18} /> Modify Capacity Settings</h3>
                <form onSubmit={handleUpdateStationCapacity}>
                  <div className="form-group">
                    <label className="form-label">Select Station</label>
                    <select className="form-control" value={selectedStationToEdit}
                      onChange={e => {
                        setSelectedStationToEdit(e.target.value);
                        const s = stations[e.target.value] || {};
                        setStationEditForm({ totalOfficers: s.total_officers || 0, totalBarricades: s.total_barricades || 0, totalVehicles: s.total_vehicles || 0 });
                      }}>
                      <option value="">-- Choose Station --</option>
                      {Object.keys(stations).sort().map(name => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                  </div>
                  {selectedStationToEdit && (
                    <>
                      {[['totalOfficers', 'Total Officers Capacity'], ['totalBarricades', 'Total Barricades Capacity'], ['totalVehicles', 'Total Patrol Vehicles Capacity']].map(([key, label]) => (
                        <div key={key} className="form-group">
                          <label className="form-label">{label}</label>
                          <input type="number" className="form-control" value={stationEditForm[key]}
                            onChange={e => setStationEditForm({ ...stationEditForm, [key]: e.target.value })} />
                        </div>
                      ))}
                      <button type="submit" className="btn btn-primary btn-block" style={{ marginTop: '1rem' }}>Apply Changes</button>
                    </>
                  )}
                </form>
              </div>
            </div>
          </div>
        )}

        {/* ── TAB 4: DENSITY MAP ── */}
        {activeTab === 'density' && (
          <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)' }}>
            {/* Header row */}
            <div style={{ flexShrink: 0, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Activity size={16} style={{ color: 'var(--primary)' }} />
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>Historical Event Density Heatmap</h3>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginLeft: '0.25rem' }}>· Traffic event concentration across Bangalore</span>
            </div>
            {/* Iframe embedding density_extracted heatmap — light mode, controls below map */}
            <div className="card" style={{ flex: 1, padding: 0, overflow: 'hidden', minHeight: 0 }}>
              <iframe
                src="/density/heatmap.html"
                title="Density Heatmap"
                style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                allow="*"
              />
            </div>
          </div>
        )}

        {/* ── TAB 5: RESPONSE CARDS ── */}
        {activeTab === 'response-cards' && (
          <div>
            <div style={{ marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '1.3rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FileText size={20} /> Smart Response Recommender
              </h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem', marginTop: '0.25rem' }}>
                Get data-driven response templates based on historical event patterns.
              </p>
            </div>

            <div className="card" style={{ marginBottom: '1.5rem' }}>
              <h4 style={{ fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Search size={16} /> Search Event Profile
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Event Cause</label>
                  <select className="form-control" value={rcEventCause} onChange={e => setRcEventCause(e.target.value)}>
                    {(responseCardOptions.event_causes?.length > 0
                      ? responseCardOptions.event_causes
                      : (mappings.event_cause ? Object.keys(mappings.event_cause) : [])
                    ).map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Corridor</label>
                  <select className="form-control" value={rcCorridor} onChange={e => setRcCorridor(e.target.value)}>
                    <option value="">-- Any --</option>
                    {responseCardOptions.corridors?.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Time of Day</label>
                  <select className="form-control" value={rcTimeOfDay} onChange={e => setRcTimeOfDay(e.target.value)}>
                    {(responseCardOptions.time_slots || ["Morning Rush (8-12 AM)", "Afternoon (12-4 PM)", "Evening Rush (4-9 PM)", "Night (9 PM-8 AM)"]).map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
              </div>
              <button className="btn btn-primary" onClick={handleGetResponseCard} disabled={rcLoading}>
                {rcLoading ? <RefreshCw size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Search size={15} />}
                {rcLoading ? ' Loading...' : ' Get Response Card'}
              </button>
            </div>

            {responseCard && (
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                  <h4 style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <FileText size={16} /> Response Card
                  </h4>
                  <span style={{ background: responseCard.match_type === 'Exact Match' ? '#D4EDDA' : '#FFF3CD', color: responseCard.match_type === 'Exact Match' ? '#155724' : '#856404', padding: '3px 10px', borderRadius: '20px', fontSize: '0.78rem', fontWeight: 600 }}>
                    {responseCard.match_type}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '1.25rem' }}>
                  <div>
                    <h5 style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--primary)', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Historical Analysis</h5>
                    {[
                      ['Similar Events Found', responseCard.similar_events_found],
                      ['Median Resolution Time', responseCard.median_resolution_time],
                      ['Resolution Range (P25–P75)', responseCard.resolution_range],
                      ['Road Closure Rate', responseCard.road_closure_rate],
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.5rem', borderBottom: '1px solid #F0F0F0', paddingBottom: '0.4rem' }}>
                        <span style={{ color: 'var(--text-muted)' }}>{k}</span>
                        <span style={{ fontWeight: 700 }}>{v}</span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <h5 style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--primary)', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Recommendations</h5>
                    {[
                      ['Nearest Police Station(s)', responseCard.nearest_stations?.join(', ') || '—'],
                      ['Zone', responseCard.zone],
                      ['Diversion Corridors', responseCard.diversion_corridors?.join(' · ') || '—'],
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.5rem', borderBottom: '1px solid #F0F0F0', paddingBottom: '0.4rem' }}>
                        <span style={{ color: 'var(--text-muted)' }}>{k}</span>
                        <span style={{ fontWeight: 700, textAlign: 'right', maxWidth: '60%' }}>{v}</span>
                      </div>
                    ))}
                    <div style={{ marginTop: '0.75rem' }}>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>Common Vehicle Types</div>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        {responseCard.common_vehicle_types?.map(vt => (
                          <span key={vt.type} style={{ background: '#E3F2FD', color: '#1565C0', padding: '2px 8px', borderRadius: '12px', fontSize: '0.78rem' }}>
                            {vt.type} ({vt.count})
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {responseCard.similar_past_events?.length > 0 && (
                  <div>
                    <h5 style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--primary)', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Similar Past Events</h5>
                    <div className="table-container">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Date</th><th>Duration</th><th>Station</th><th>Description</th>
                          </tr>
                        </thead>
                        <tbody>
                          {responseCard.similar_past_events.map((ev, i) => (
                            <tr key={i}>
                              <td>{ev.date}</td>
                              <td><strong>{ev.duration}</strong></td>
                              <td style={{ color: 'var(--primary)' }}>{ev.station}</td>
                              <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{ev.description}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── TAB 6: ARCHIVES ── */}
        {activeTab === 'archives' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <div>
                <h2 style={{ fontSize: '1.3rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Archive size={20} /> Closed Event Archives
                </h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem', marginTop: '0.25rem' }}>
                  {archives.length} post-event records stored for learning · {archives.filter(a => !a.retrained).length} not yet used in training
                </p>
              </div>
              <button className="btn btn-primary" onClick={() => setShowRetrainConfirm(true)} disabled={retraining || archives.length === 0}>
                <RefreshCw size={15} /> {retraining ? 'Retraining...' : 'Retrain Models'}
              </button>
            </div>

            {retrainLogs.length > 0 && (
              <div className="card" style={{ marginBottom: '1.5rem', padding: '1rem' }}>
                <div style={{ background: '#212529', color: '#A9E34B', padding: '1rem', borderRadius: '6px', fontFamily: 'monospace', fontSize: '0.8rem', maxHeight: '150px', overflowY: 'auto' }}>
                  {retrainLogs.map((log, i) => <div key={i}>{log}</div>)}
                </div>
              </div>
            )}

            {archives.length === 0 ? (
              <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
                <Archive size={32} style={{ color: 'var(--text-muted)', marginBottom: '0.75rem' }} />
                <p style={{ color: 'var(--text-muted)' }}>No closed events yet. Close a live event to see it here.</p>
              </div>
            ) : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div className="table-container">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Event ID</th>
                        <th>Cause / Type</th>
                        <th>Station</th>
                        <th>Pred Duration</th>
                        <th>Actual Duration</th>
                        <th>Pred Severity</th>
                        <th>Actual Severity</th>
                        <th>Officers</th>
                        <th>Barricades</th>
                        <th>Vehicles</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...archives].reverse().map((rec, i) => (
                        <tr key={i}>
                          <td><strong style={{ fontSize: '0.78rem' }}>{rec.event_id || '—'}</strong></td>
                          <td>
                            <div style={{ fontWeight: 600, fontSize: '0.82rem' }}>{rec.event_cause}</div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{rec.event_type}</div>
                          </td>
                          <td style={{ fontSize: '0.8rem' }}>{rec.police_station || '—'}</td>
                          <td>{rec.predicted_duration_mins ? `${rec.predicted_duration_mins.toFixed(0)}m` : '—'}</td>
                          <td style={{ fontWeight: 700, color: 'var(--primary)' }}>{rec.duration_mins ? `${rec.duration_mins.toFixed(0)}m` : '—'}</td>
                          <td>{rec.predicted_severity_index?.toFixed(1) || '—'}</td>
                          <td style={{ fontWeight: 700 }}>{rec.severity_index?.toFixed(1) || '—'}</td>
                          <td>{rec.officers_allocated ?? '—'}</td>
                          <td>{rec.barricades_allocated ?? '—'}</td>
                          <td>{rec.vehicles_allocated ?? '—'}</td>
                          <td style={{ fontSize: '0.75rem', color: 'var(--text-muted)', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {rec.manual_operator_adjustments || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}



      </main>

      {/* ── MODAL: CREATE SIMULATION ── */}
      {isSimModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3 className="modal-title">Simulate Traffic / Emergency Event</h3>
              <button className="modal-close" onClick={() => setIsSimModalOpen(false)}><X size={20} /></button>
            </div>
            <form onSubmit={handleRunSimulation}>
              <div className="modal-body">
                <div className="form-row-2">
                  <div className="form-group">
                    <label className="form-label">Event Type</label>
                    <select className="form-control" value={simForm.eventType}
                      onChange={e => setSimForm({ ...simForm, eventType: e.target.value })}>
                      {mappings.event_type && Object.keys(mappings.event_type).map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Event Cause</label>
                    <select className="form-control" value={simForm.eventCause}
                      onChange={e => setSimForm({ ...simForm, eventCause: e.target.value })}>
                      {mappings.event_cause && Object.keys(mappings.event_cause).map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>

                <div className="form-row-2">
                  <div className="form-group">
                    <label className="form-label">Priority</label>
                    <select className="form-control" value={simForm.priority}
                      onChange={e => setSimForm({ ...simForm, priority: e.target.value })}>
                      <option value="High">High</option>
                      <option value="Low">Low</option>
                    </select>
                  </div>
                  <div className="form-group" style={{ display: 'flex', alignItems: 'center', paddingTop: '1.5rem' }}>
                    <label className="checkbox-control">
                      <input type="checkbox" checked={simForm.requiresRoadClosure}
                        onChange={e => setSimForm({ ...simForm, requiresRoadClosure: e.target.checked })} />
                      Requires Road Closure
                    </label>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Coordinates Preset (Bangalore)</label>
                  <select className="form-control" onChange={e => handleSelectPreset(e.target.value)}>
                    <option value="">-- Custom Coordinates --</option>
                    {LOCATION_PRESETS.map(p => (
                      <option key={p.name} value={p.name}>{p.name} ({p.lat.toFixed(4)}, {p.lon.toFixed(4)})</option>
                    ))}
                  </select>
                </div>

                <div className="form-row-2">
                  <div className="form-group">
                    <label className="form-label">Latitude</label>
                    <input type="number" step="any" className="form-control" value={simForm.latitude}
                      onChange={e => setSimForm({ ...simForm, latitude: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Longitude</label>
                    <input type="number" step="any" className="form-control" value={simForm.longitude}
                      onChange={e => setSimForm({ ...simForm, longitude: e.target.value })} />
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setIsSimModalOpen(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Run Simulation</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── MODAL: RETRAIN CONFIRM ── */}
      {showRetrainConfirm && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '480px' }}>
            <div className="modal-header">
              <h3 className="modal-title">Confirm Model Retraining</h3>
              <button className="modal-close" onClick={() => setShowRetrainConfirm(false)}><X size={20} /></button>
            </div>
            <div className="modal-body">
              <div style={{ background: '#FFF3CD', border: '1px solid #FFC107', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
                <AlertTriangle size={16} style={{ color: '#856404', marginRight: '8px' }} />
                <strong style={{ color: '#856404' }}>This will retrain all production ML models</strong>
              </div>
              <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>
                The system will retrain the duration and severity prediction models using <strong>{archives.length} post-event records</strong> accumulated since last training. Models will only be updated after training completes successfully.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowRetrainConfirm(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleTriggerRetraining}>
                <RefreshCw size={15} /> Yes, Retrain Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: CLOSE EVENT ── */}
      {closingEventId && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3 className="modal-title">Close Live Event: {closingEventId}</h3>
              <button className="modal-close" onClick={() => setClosingEventId(null)}><X size={20} /></button>
            </div>
            <form onSubmit={handleCloseEventSubmit}>
              <div className="modal-body">
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem', background: '#F8F9FA', padding: '0.75rem', borderRadius: '8px' }}>
                  Enter the actual outcome metrics. This data will be stored in Archives for future model training.
                </p>
                <div className="form-row-2">
                  <div className="form-group">
                    <label className="form-label">Actual Duration (mins)</label>
                    <input type="number" className="form-control" value={closeForm.actualDuration}
                      onChange={e => setCloseForm({ ...closeForm, actualDuration: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Actual Severity (1–10)</label>
                    <input type="number" step="0.1" className="form-control" value={closeForm.actualSeverity}
                      onChange={e => setCloseForm({ ...closeForm, actualSeverity: e.target.value })} />
                  </div>
                </div>
                <div className="form-row-2">
                  <div className="form-group">
                    <label className="form-label">Actual Congestion</label>
                    <select className="form-control" value={closeForm.actualCongestion}
                      onChange={e => setCloseForm({ ...closeForm, actualCongestion: e.target.value })}>
                      <option>Low</option><option>Moderate</option><option>Congested</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Actual Impact Radius (km)</label>
                    <input type="number" step="0.1" className="form-control" value={closeForm.actualImpactRadius}
                      onChange={e => setCloseForm({ ...closeForm, actualImpactRadius: e.target.value })} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Actual Response Time (mins)</label>
                  <input type="number" className="form-control" value={closeForm.actualResponseTime}
                    onChange={e => setCloseForm({ ...closeForm, actualResponseTime: e.target.value })} />
                </div>
                <h4 style={{ fontSize: '0.85rem', fontWeight: 700, margin: '1rem 0 0.5rem', color: 'var(--text-muted)' }}>Additional resources requested</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem' }}>
                  {[['additionalOfficers', 'Officers'], ['additionalBarricades', 'Barricades'], ['additionalVehicles', 'Vehicles']].map(([key, label]) => (
                    <div key={key} className="form-group">
                      <label className="form-label">{label}</label>
                      <input type="number" className="form-control" value={closeForm[key]}
                        onChange={e => setCloseForm({ ...closeForm, [key]: e.target.value })} />
                    </div>
                  ))}
                </div>
                <div className="form-group">
                  <label className="form-label">Operator Notes</label>
                  <textarea className="form-control" rows="2" value={closeForm.adjustments}
                    onChange={e => setCloseForm({ ...closeForm, adjustments: e.target.value })} />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setClosingEventId(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Archive Event</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── MODAL: REASSESS ── */}
      {reassessingEventId && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3 className="modal-title">Reassessment: {reassessingEventId}</h3>
              <button className="modal-close" onClick={() => setReassessingEventId(null)}><X size={20} /></button>
            </div>
            <div className="modal-body">
              {reassessLoading ? (
                <div style={{ textAlign: 'center', padding: '2rem' }}>
                  <RefreshCw style={{ animation: 'spin 1.5s linear infinite', color: 'var(--primary)', marginBottom: '0.5rem' }} size={24} />
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Analyzing incident & active resources...</p>
                </div>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.9rem', background: '#F8F9FA', padding: '1rem', borderRadius: '6px', border: '1px solid var(--border)', color: '#495057' }}>
                  {reassessmentText}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setReassessingEventId(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
