import { useEffect, useMemo, useRef, useState } from "react";

declare global { interface Window { maplibregl?: any } }

const MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js";
const MAPLIBRE_CSS = "https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css";

const OFM_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const SUPPORTED_LANGS = ["de", "en", "es", "fr"] as const;
type Lang = (typeof SUPPORTED_LANGS)[number];
const LABEL_SCALE = 1.6;

type Suggestion = {
  id: string;
  name: string;
  subtitle?: string;
  center: [number, number];
  bbox?: [number, number, number, number];
  raw: any;
};

type Waypoint = { id: string; name: string; coord: [number, number] };

type SavedRoute = { id: string; name: string; waypoints: Waypoint[] };

type OverlayKey = "nationalparks" | "attractions" | "unesco" | "beaches";

type Engine = "osrm" | "valhalla";

type Config = {
  geocoderBase: string;
  overpassBases: string[];
  routingEngine: Engine;
  osrmBase: string;
  valhallaBase: string;
};

const DEFAULT_CONFIG: Config = {
  geocoderBase: "https://photon.komoot.io",
  overpassBases: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
  ],
  routingEngine: "osrm",
  osrmBase: "https://router.project-osrm.org",
  valhallaBase: "https://valhalla1.openstreetmap.de",
};

function uid() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

export default function App() {
  const mapRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const [lang, setLang] = useState<Lang>("de");
  const [status, setStatus] = useState<string>("Lade Karte …");

  const userMarkersRef = useRef<any[]>([]);
  const favoritesRef = useRef<any[]>([]);
  const routesRef = useRef<any[]>([]);

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchTimerRef = useRef<any>(null);
  const lastSelectedRef = useRef<Suggestion | null>(null);

  const [routeOpen, setRouteOpen] = useState(false);
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>([]);
  const [insertAfter, setInsertAfter] = useState<number | null>(null);

  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>({ nationalparks: false, attractions: false, unesco: false, beaches: false });
  const overlayAbort = useRef<Record<OverlayKey, AbortController | null>>({ nationalparks: null, attractions: null, unesco: null, beaches: null });
  const [overlayLoading, setOverlayLoading] = useState<Record<OverlayKey, boolean>>({ nationalparks: false, attractions: false, unesco: false, beaches: false });
  const overlayColors: Record<OverlayKey, string> = { nationalparks: "#2e7d32", attractions: "#8e24aa", unesco: "#f4511e", beaches: "#0288d1" };

  const [configOpen, setConfigOpen] = useState(false);
  const [config, setConfig] = useState<Config>(() => {
    try { const raw = localStorage.getItem("worldmap.config"); if (raw) return JSON.parse(raw); } catch {}
    return DEFAULT_CONFIG;
  });
  const persistConfig = () => { try { localStorage.setItem("worldmap.config", JSON.stringify(config)); } catch {} };

  const [roadGeom, setRoadGeom] = useState<any | null>(null);
  const [roadDistanceKm, setRoadDistanceKm] = useState<number | null>(null);
  const [roadDurationMin, setRoadDurationMin] = useState<number | null>(null);
  const [routingBusy, setRoutingBusy] = useState(false);

  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        await ensureMapLibreLoaded();
        if (canceled) return;
        const map = new window.maplibregl.Map({
          container: mapContainerRef.current!,
          style: OFM_STYLE_URL,
          center: [0, 20],
          zoom: 0,
          minZoom: 0,
          maxZoom: 20,
          renderWorldCopies: false,
          attributionControl: false,
          cooperativeGestures: false,
        });
        mapRef.current = map;
        try { map.scrollZoom.enable(); } catch {}
        map.addControl(new window.maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
        map.addControl(new window.maplibregl.ScaleControl({ maxWidth: 140, unit: "metric" }), "bottom-left");
        map.on("load", () => {
          try {
            applyLanguageOnMap(map, lang);
            scaleTextSizesOnMap(map, LABEL_SCALE);
          } catch {}
          prepareUserSourcesAndLayers(map);
          ensureOverlaySources(map);
          map.on("click", (e: any) => addUserMarker(map, [e.lngLat.lng, e.lngLat.lat]));
          restoreFromStorage();
          setStatus("");
        });
        map.on("moveend", () => reloadActiveOverlays());
        map.on("error", (e: any) => setStatus(`Fehler: ${e?.error?.message ?? "Unbekannt"}`));
      } catch (e: any) { setStatus(`Konnte Karte nicht laden: ${e?.message ?? e}`); }
    })();
    return () => { canceled = true; if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, []);

  useEffect(() => { const map = mapRef.current; if (!map) return; try { applyLanguageOnMap(map, lang); } catch {} }, [lang]);

  useEffect(() => {
    if (!query.trim()) { setSuggestions([]); setShowSuggestions(false); return; }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => { runSearch(query); }, 250);
  }, [query, lang, config.geocoderBase]);

  useEffect(() => { updateRouteLine(); computeRoadRoute(); }, [waypoints, config.routingEngine, config.osrmBase, config.valhallaBase]);

  useEffect(() => { reloadActiveOverlays(); }, [overlays, config.overpassBases]);

  function restoreFromStorage() {
    try {
      const fav = JSON.parse(localStorage.getItem("worldmap.favorites") || "[]");
      if (Array.isArray(fav)) { favoritesRef.current = fav; const map = mapRef.current; map.getSource("favorites").setData({ type: "FeatureCollection", features: favoritesRef.current }); }
      const saved = JSON.parse(localStorage.getItem("worldmap.routes.saved") || "[]"); if (Array.isArray(saved)) setSavedRoutes(saved);
      const current = JSON.parse(localStorage.getItem("worldmap.routes.current") || "[]"); if (Array.isArray(current)) setWaypoints(current);
      const cfg = JSON.parse(localStorage.getItem("worldmap.config") || "null"); if (cfg) setConfig(cfg);
    } catch {}
  }

  function persistFavorites() { try { localStorage.setItem("worldmap.favorites", JSON.stringify(favoritesRef.current)); } catch {} }
  function persistCurrentRoute() { try { localStorage.setItem("worldmap.routes.current", JSON.stringify(waypoints)); } catch {} }
  function persistSavedRoutes(list: SavedRoute[]) { try { localStorage.setItem("worldmap.routes.saved", JSON.stringify(list)); } catch {} }

  async function ensureMapLibreLoaded() {
    if (window.maplibregl) return;
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = MAPLIBRE_CSS; document.head.appendChild(css);
    await new Promise<void>((resolve, reject) => { const s = document.createElement("script"); s.src = MAPLIBRE_JS; s.async = true; s.onload = () => (window.maplibregl ? resolve() : reject(new Error("MapLibre nicht verfügbar"))); s.onerror = () => reject(new Error("MapLibre Script konnte nicht geladen werden")); document.head.appendChild(s); });
  }

  function localizedTextExpression(l: Lang) { return ["coalesce", ["get", `name:${l}`], ["get", "name:latin"], ["get", "name"]]; }
  function applyLanguageOnMap(map: any, l: Lang) { const expr = localizedTextExpression(l); const layers = (map.getStyle()?.layers ?? []) as any[]; for (const layer of layers) { if (layer.type !== "symbol") continue; try { map.setLayoutProperty(layer.id, "text-field", expr); } catch {} } }
  function scaleTextSizesOnMap(map: any, factor: number) { const layers = (map.getStyle()?.layers ?? []) as any[]; for (const layer of layers) { if (layer.type !== "symbol") continue; try { const current = map.getLayoutProperty(layer.id, "text-size"); map.setLayoutProperty(layer.id, "text-size", ["*", current ?? 12, factor]); } catch {} } }

  function prepareUserSourcesAndLayers(map: any) {
    map.addSource("user-markers", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "user-markers-layer", type: "circle", source: "user-markers", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 3, 8, 6, 14, 9], "circle-color": "#2f5f8b", "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } }, topmostSymbolLayerId(map));

    map.addSource("favorites", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "favorites-layer", type: "symbol", source: "favorites", layout: { "icon-image": ["coalesce", ["get", "icon"], "marker-15"], "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 0.9, 14, 1.3], "text-field": ["coalesce", ["get", "title"], "Favorit"], "text-offset": [0, 1.1], "text-anchor": "top", "text-size": ["*", 12, LABEL_SCALE * 0.9] }, paint: { "text-color": "#1b1b1b", "text-halo-color": "#ffffff", "text-halo-width": 1.2 } }, "user-markers-layer");

    map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "routes-casing", type: "line", source: "routes", paint: { "line-color": "#0b2e4f", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2, 10, 5, 14, 8], "line-opacity": 0.25 } }, "favorites-layer");
    map.addLayer({ id: "routes-line", type: "line", source: "routes", paint: { "line-color": "#1e88e5", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 10, 3.5, 14, 6] } }, "routes-casing");

    map.addSource("routes-road", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "routes-road-casing", type: "line", source: "routes-road", paint: { "line-color": "#0b2e4f", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 3, 10, 6, 14, 10], "line-opacity": 0.35 } }, "routes-line");
    map.addLayer({ id: "routes-road-line", type: "line", source: "routes-road", paint: { "line-color": "#ff6f00", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2, 10, 4, 14, 7] } }, "routes-road-casing");
  }

  function ensureOverlaySources(map: any) {
    const insertBefore = topmostSymbolLayerId(map);
    const defs: { key: OverlayKey; color: string }[] = [
      { key: "nationalparks", color: overlayColors.nationalparks },
      { key: "attractions", color: overlayColors.attractions },
      { key: "unesco", color: overlayColors.unesco },
      { key: "beaches", color: overlayColors.beaches },
    ];
    for (const d of defs) {
      const src = `overlay-${d.key}`;
      if (!map.getSource(src)) map.addSource(src, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      const layerId = `${src}-points`;
      if (!map.getLayer(layerId)) {
        map.addLayer({ id: layerId, type: "circle", source: src, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 4, 10, 7, 14, 11], "circle-color": d.color, "circle-stroke-width": 2, "circle-stroke-color": "#ffffff", "circle-opacity": 0.95 } }, insertBefore);
        map.on("click", layerId, (e: any) => {
          const f = e.features?.[0]; if (!f) return; const p = f.properties || {}; const title = p.title || p.name || "Objekt";
          new window.maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(`<div style="min-width:220px"><div style="font-weight:600">${escapeHtml(title)}</div>${p.subtitle ? `<div style=\"opacity:.7\">${escapeHtml(p.subtitle)}</div>` : ""}</div>`).addTo(mapRef.current);
        });
      }
    }
  }

  function topmostSymbolLayerId(map: any) { const layers = (map.getStyle()?.layers ?? []) as any[]; for (let i = layers.length - 1; i >= 0; i--) if (layers[i].type === "symbol") return layers[i].id; return undefined; }

  function addUserMarker(map: any, lngLat: [number, number], props: Record<string, any> = {}) { const f = { type: "Feature", geometry: { type: "Point", coordinates: lngLat }, properties: { createdAt: Date.now(), ...props } } as any; userMarkersRef.current.push(f); map.getSource("user-markers").setData({ type: "FeatureCollection", features: userMarkersRef.current }); }
  function clearUserMarkers() { userMarkersRef.current = []; const map = mapRef.current; if (map) map.getSource("user-markers").setData({ type: "FeatureCollection", features: [] }); }
  function addFavorite(map: any, lngLat: [number, number], title = "Favorit", icon = "star-15") { const f = { type: "Feature", geometry: { type: "Point", coordinates: lngLat }, properties: { title, icon } } as any; favoritesRef.current.push(f); map.getSource("favorites").setData({ type: "FeatureCollection", features: favoritesRef.current }); persistFavorites(); }

  function updateRouteLine() {
    const map = mapRef.current; if (!map) return;
    const coords = waypoints.map(w => w.coord);
    const fc = coords.length >= 2 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { name: "Route (Gerade)" } }] : [];
    routesRef.current = fc as any; map.getSource("routes").setData({ type: "FeatureCollection", features: routesRef.current });
    persistCurrentRoute();
  }

  function addWaypointAt(coord: [number, number], name: string, index?: number) { const w: Waypoint = { id: uid(), name, coord }; setWaypoints(prev => { const arr = prev.slice(); if (index == null || index < 0 || index >= arr.length) arr.push(w); else arr.splice(index + 1, 0, w); return arr; }); }
  function removeWaypoint(id: string) { setWaypoints(prev => prev.filter(w => w.id !== id)); }
  function moveWaypoint(id: string, dir: -1 | 1) { setWaypoints(prev => { const i = prev.findIndex(w => w.id === id); if (i < 0) return prev; const j = i + dir; if (j < 0 || j >= prev.length) return prev; const copy = prev.slice(); const [it] = copy.splice(i, 1); copy.splice(j, 0, it); return copy; }); }
  function clearRoute() { setWaypoints([]); setRoadGeom(null); setRoadDistanceKm(null); setRoadDurationMin(null); const map = mapRef.current; if (map) map.getSource("routes-road").setData({ type: "FeatureCollection", features: [] }); }

  function saveCurrentRoute(name: string) { const r: SavedRoute = { id: uid(), name, waypoints: waypoints.slice() }; const list = [r, ...savedRoutes]; setSavedRoutes(list); persistSavedRoutes(list); }
  function loadRoute(id: string) { const r = savedRoutes.find(x => x.id === id); if (!r) return; setWaypoints(r.waypoints.slice()); }
  function deleteRoute(id: string) { const list = savedRoutes.filter(x => x.id !== id); setSavedRoutes(list); persistSavedRoutes(list); }

  async function runSearch(q: string) {
    if (!q.trim()) { setSuggestions([]); setShowSuggestions(false); return; }
    if (searchAbortRef.current) searchAbortRef.current.abort(); const ctl = new AbortController(); searchAbortRef.current = ctl;
    try {
      const url = `${config.geocoderBase.replace(/\/$/, "")}/api/?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(lang)}&limit=8`;
      const res = await fetch(url, { signal: ctl.signal }); const data = await res.json();
      const feats: Suggestion[] = (data.features || []).map((f: any, idx: number) => { const p = f.properties || {}; const name = p.name || p.street || p.city || p.country || "Unbenannt"; const parts = [p.city, p.state, p.country].filter(Boolean); const subtitle = parts.join(" · "); let center: [number, number] = [f.geometry.coordinates[0], f.geometry.coordinates[1]]; const bbox = f.bbox && f.bbox.length === 4 ? [f.bbox[1], f.bbox[0], f.bbox[3], f.bbox[2]] as [number, number, number, number] : undefined; return { id: String(p.osm_id || idx), name, subtitle, center, bbox, raw: f }; });
      setSuggestions(feats); setShowSuggestions(true);
    } catch (e) { if ((e as any)?.name !== "AbortError") setSuggestions([]); }
  }

  function flyToSuggestion(s: Suggestion) {
    const map = mapRef.current; if (!map) return; lastSelectedRef.current = s;
    if (s.bbox) { const b = [[s.bbox[1], s.bbox[0]], [s.bbox[3], s.bbox[2]]]; map.fitBounds(b, { padding: 60, duration: 800 }); } else { map.flyTo({ center: s.center, zoom: 12, duration: 800 }); }
    addUserMarker(map, s.center, { title: s.name }); setShowSuggestions(false);
  }
  function addSuggestionToRoute(s: Suggestion) { const idx = insertAfter == null ? undefined : insertAfter; addWaypointAt(s.center, s.name, idx); }
  function addSuggestionToFavorites(s: Suggestion) { const map = mapRef.current; if (!map) return; addFavorite(map, s.center, s.name, "star-15"); }

  function getMapBbox(): [number, number, number, number] | null { const map = mapRef.current; if (!map) return null; const b = map.getBounds(); return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]; }

  function reloadActiveOverlays() {
    const bbox = getMapBbox(); const map = mapRef.current; if (!bbox || !map) return; const zoom = map.getZoom();
    (Object.keys(overlays) as OverlayKey[]).forEach((k) => { if (overlays[k]) { if (zoom < 4) { clearOverlay(k); return; } loadOverlay(k, bbox); } else { clearOverlay(k); } });
  }

  function clearOverlay(key: OverlayKey) { const map = mapRef.current; if (!map) return; const src = map.getSource(`overlay-${key}`); if (src) src.setData({ type: "FeatureCollection", features: [] }); if (overlayAbort.current[key]) overlayAbort.current[key]!.abort(); overlayAbort.current[key] = null; setOverlayLoading(prev => ({ ...prev, [key]: false })); }

  async function loadOverlay(key: OverlayKey, bbox: [number, number, number, number]) {
    if (overlayAbort.current[key]) overlayAbort.current[key]!.abort(); const ctl = new AbortController(); overlayAbort.current[key] = ctl; setOverlayLoading(prev => ({ ...prev, [key]: true }));
    const q = buildOverpassQuery(key, bbox);
    let lastErr: any = null;
    for (const base of config.overpassBases) {
      try {
        const res = await fetch(base, { method: "POST", body: q, headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, signal: ctl.signal });
        if (!res.ok) throw new Error(`Overpass ${res.status}`);
        const json = await res.json();
        const feats = (json.elements || []).map((el: any) => overpassElementToPointFeature(el, lang)).filter(Boolean);
        const fc = { type: "FeatureCollection", features: feats } as any;
        const map = mapRef.current; const src = map.getSource(`overlay-${key}`); if (src) src.setData(fc);
        setOverlayLoading(prev => ({ ...prev, [key]: false }));
        return;
      } catch (e) { lastErr = e; continue; }
    }
    setOverlayLoading(prev => ({ ...prev, [key]: false }));
  }

  function buildOverpassQuery(key: OverlayKey, bbox: [number, number, number, number]) {
    const b = `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`; // south,west,north,east
    let body = "";
    if (key === "beaches") body = `data=[out:json][timeout:25];(node[\"natural\"=\"beach\"](${b});way[\"natural\"=\"beach\"](${b});relation[\"natural\"=\"beach\"](${b}););out center tags;`;
    else if (key === "nationalparks") body = `data=[out:json][timeout:25];(way[\"boundary\"=\"protected_area\"][\"protect_class\"=2](${b});relation[\"boundary\"=\"protected_area\"][\"protect_class\"=2](${b});way[\"leisure\"=\"nature_reserve\"](${b});relation[\"leisure\"=\"nature_reserve\"](${b}););out center tags;`;
    else if (key === "attractions") body = `data=[out:json][timeout:25];(node[\"tourism\"~\"^(attraction|museum|gallery|theme_park|zoo)$\"](${b});way[\"tourism\"~\"^(attraction|museum|gallery|theme_park|zoo)$\"](${b});relation[\"tourism\"~\"^(attraction|museum|gallery|theme_park|zoo)$\"](${b});node[\"historic\"](${b});way[\"historic\"](${b});relation[\"historic\"](${b}););out center tags;`;
    else if (key === "unesco") body = `data=[out:json][timeout:25];(node[\"heritage:operator\"~\"(?i)unesco\"](${b});way[\"heritage:operator\"~\"(?i)unesco\"](${b});relation[\"heritage:operator\"~\"(?i)unesco\"](${b});node[\"heritage\"=\"1\"](${b});way[\"heritage\"=\"1\"](${b});relation[\"heritage\"=\"1\"](${b}););out center tags;`;
    return body;
  }

  function overpassElementToPointFeature(el: any, l: Lang) {
    const tags = el.tags || {}; const name = tags[`name:${l}`] || tags["name:latin"] || tags["name"] || null;
    const coord: [number, number] = el.type === "node" ? [el.lon, el.lat] : [el.center?.lon, el.center?.lat]; if (!coord[0] || !coord[1]) return null;
    const subtitleParts = [tags["wikidata"] ? "Wikidata" : null, tags["heritage"] ? "Heritage" : null].filter(Boolean);
    const p: any = { title: name || "Objekt", subtitle: subtitleParts.join(" · ") };
    return { type: "Feature", geometry: { type: "Point", coordinates: coord }, properties: p } as any;
  }

  async function computeRoadRoute() {
    const map = mapRef.current; if (!map) return; if (waypoints.length < 2) { setRoadGeom(null); setRoadDistanceKm(null); setRoadDurationMin(null); map.getSource("routes-road").setData({ type: "FeatureCollection", features: [] }); return; }
    setRoutingBusy(true);
    try {
      if (config.routingEngine === "osrm") {
        const coords = waypoints.map(w => `${w.coord[0]},${w.coord[1]}`).join(";");
        const base = config.osrmBase.replace(/\/$/, "");
        const url = `${base}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false&annotations=false`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`OSRM ${res.status}`);
        const json = await res.json();
        const route = json.routes?.[0];
        if (route?.geometry) {
          const geom = route.geometry;
          setRoadGeom(geom);
          setRoadDistanceKm((route.distance ?? 0) / 1000);
          setRoadDurationMin((route.duration ?? 0) / 60);
          map.getSource("routes-road").setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: geom, properties: { name: "Straßenroute (OSRM)" } }] });
        }
      } else {
        const base = config.valhallaBase.replace(/\/$/, "");
        const url = `${base}/route`;
        const body = { locations: waypoints.map(w => ({ lat: w.coord[1], lon: w.coord[0] })), costing: "auto", directions_options: { units: "kilometers" } };
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`Valhalla ${res.status}`);
        const json = await res.json();
        const trip = json.trip;
        let totalDistKm = 0; let totalDurMin = 0; const coords: [number, number][] = [];
        if (trip?.legs) {
          for (const leg of trip.legs) {
            totalDistKm += (leg.summary?.length ?? 0);
            totalDurMin += (leg.summary?.time ?? 0) / 60;
            const legCoords = decodeValhallaShape(leg.shape);
            coords.push(...legCoords);
          }
        }
        setRoadDistanceKm(totalDistKm);
        setRoadDurationMin(totalDurMin);
        const geom = { type: "LineString", coordinates: coords } as any;
        setRoadGeom(geom);
        map.getSource("routes-road").setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: geom, properties: { name: "Straßenroute (Valhalla)" } }] });
      }
    } catch (e) {
      // silently ignore for now, could set status
    } finally {
      setRoutingBusy(false);
    }
  }

  function decodeValhallaShape(shape: string): [number, number][] {
    // Valhalla uses polyline6
    let index = 0, lat = 0, lon = 0; const coordinates: [number, number][] = [];
    const factor = 1e-6;
    while (index < shape.length) {
      let b = 0, shift = 0, result = 0; do { b = shape.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const dlat = (result & 1) ? ~(result >> 1) : (result >> 1); lat += dlat;
      shift = 0; result = 0; do { b = shape.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const dlon = (result & 1) ? ~(result >> 1) : (result >> 1); lon += dlon;
      coordinates.push([lon * factor, lat * factor]);
    }
    return coordinates;
  }

  function exportGeoJSON() {
    const fc = { type: "FeatureCollection", features: [] as any[] } as any;
    if (waypoints.length) fc.features.push({ type: "Feature", geometry: { type: "MultiPoint", coordinates: waypoints.map(w => w.coord) }, properties: { name: "Wegpunkte" } });
    if (routesRef.current.length) fc.features.push(...routesRef.current);
    if (roadGeom) fc.features.push({ type: "Feature", geometry: roadGeom, properties: { name: "Straßenroute" } });
    downloadBlob(JSON.stringify(fc, null, 2), "route.geojson", "application/geo+json");
  }
  function exportGPX() {
    const coords: [number, number][] = (roadGeom?.coordinates as any) || waypoints.map(w => w.coord);
    const trkpts = coords.map(c => `<trkpt lon="${c[0]}" lat="${c[1]}"></trkpt>`).join("\n");
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="worldmap" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Route</name><trkseg>${trkpts}</trkseg></trk></gpx>`;
    downloadBlob(gpx, "route.gpx", "application/gpx+xml");
  }
  function downloadBlob(data: string, filename: string, type: string) { const blob = new Blob([data], { type }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

  function clearSearch() { setQuery(""); setSuggestions([]); setShowSuggestions(false); }

  function escapeHtml(s: string) { return s?.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c] as string)) || ""; }

  return (
    <div className="h-dvh w-dvw overflow-hidden bg-background text-foreground">
      <div className="fixed left-2 right-2 top-2 z-10 flex items-center gap-2 rounded-lg border border-border/60 bg-white/90 p-2 shadow-sm backdrop-blur-sm dark:bg-white/10">
        <div className="flex items-center gap-2">
          <label htmlFor="lang" className="text-sm font-medium">Sprache</label>
          <select id="lang" className="rounded-md border border-border bg-white px-2 py-1 text-sm dark:bg-black/20" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            {SUPPORTED_LANGS.map((l) => (<option key={l} value={l}>{l.toUpperCase()}</option>))}
          </select>
        </div>
        <div className="relative flex-1">
          <input value={query} onChange={(e) => setQuery(e.target.value)} onFocus={() => suggestions.length && setShowSuggestions(true)} placeholder="Suche nach Städten, Orten, Stränden, Bergen…" className="w-full rounded-md border border-border bg-white px-3 py-2 pr-8 text-sm text-black shadow-sm focus:outline-none dark:bg-black/20 dark:text-white" />
          {query && (
            <button aria-label="Suche löschen" className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1 text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-700" onClick={clearSearch}>×</button>
          )}
          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-border bg-white text-sm shadow-lg dark:bg-zinc-900">
              {suggestions.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2 last:border-b-0 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{s.name}</div>
                    {s.subtitle && <div className="truncate text-xs opacity-70">{s.subtitle}</div>}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button className="rounded bg-zinc-200 px-2 py-1 text-xs hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600" onClick={() => flyToSuggestion(s)}>Anzeigen</button>
                    <button className="rounded bg-[#2f5f8b] px-2 py-1 text-xs text-white hover:bg-[#4892d9]" onClick={() => addSuggestionToRoute(s)}>Zur Route</button>
                    <button className="rounded bg-amber-500 px-2 py-1 text-xs text-white hover:bg-amber-600" onClick={() => addSuggestionToFavorites(s)}>Favorit</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button className="rounded-md bg-[#2f5f8b] px-3 py-1 text-sm text-white hover:bg-[#4892d9]" onClick={() => clearUserMarkers()} title="Alle Marker entfernen">Marker löschen</button>
          <button className="rounded-md bg-[#2f5f8b] px-3 py-1 text-sm text-white hover:bg-[#4892d9]" onClick={() => setRouteOpen(v => !v)} title="Reiseplanung">Route‑Planer</button>
          <button className="rounded-md bg-zinc-800 px-3 py-1 text-sm text-white hover:bg-zinc-700" onClick={() => { setConfigOpen(v => !v); }} title="Einstellungen">⚙︎</button>
        </div>
      </div>

      <div ref={mapContainerRef} style={{ position: "fixed", left: 0, right: 0, top: 56, bottom: 28 }} />

      <div className="fixed right-2 top-20 z-10 w-64 rounded-md border border-border/60 bg-white/90 p-2 text-sm shadow-sm backdrop-blur-sm dark:bg-white/10">
        <div className="mb-2 font-medium">Legende</div>
        <div className="space-y-1">
          {(["nationalparks","attractions","unesco","beaches"] as OverlayKey[]).map((k) => (
            <label key={k} className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={overlays[k]} onChange={(e) => setOverlays(prev => ({ ...prev, [k]: e.target.checked }))} />
              <span className="inline-block h-3 w-3 rounded-full" style={{ background: overlayColors[k] }} />
              <span className="capitalize">{k === "nationalparks" ? "Nationalparks" : k === "attractions" ? "Sehenswürdigkeiten" : k === "unesco" ? "UNESCO" : "Strände"}</span>
              {overlayLoading[k] && <span className="ml-auto text-xs opacity-70">lädt…</span>}
            </label>
          ))}
          <div className="mt-1 text-xs opacity-65">Tipp: Für bessere Ergebnisse in die Karte hineinzoomen.</div>
        </div>
      </div>

      {routeOpen && (
        <div className="fixed bottom-28 right-2 top-44 z-10 w-[28rem] overflow-hidden rounded-md border border-border/60 bg-white/95 shadow-lg backdrop-blur-sm dark:bg-zinc-900">
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2 text-sm">
            <div className="font-medium">Reiseplanung</div>
            <button className="rounded px-2 py-1 hover:bg-zinc-200 dark:hover:bg-zinc-800" onClick={() => setRouteOpen(false)}>Schließen</button>
          </div>
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 p-3 text-xs">
              <button className="rounded bg-[#2f5f8b] px-2 py-1 text-white hover:bg-[#4892d9]" onClick={() => { if (lastSelectedRef.current) addSuggestionToRoute(lastSelectedRef.current); }}>Letzte Suche hinzufügen</button>
              <button className="rounded bg-emerald-600 px-2 py-1 text-white hover:bg-emerald-700" onClick={() => { const map = mapRef.current; if (!map) return; const c = map.getCenter(); addWaypointAt([c.lng, c.lat], "Kartenmitte"); }}>Punkt: Kartenmitte</button>
              <button className="rounded bg-rose-600 px-2 py-1 text-white hover:bg-rose-700" onClick={() => clearRoute()}>Leeren</button>
              <div className="ml-auto flex items-center gap-2">
                <label>Engine</label>
                <select value={config.routingEngine} onChange={(e) => setConfig({ ...config, routingEngine: e.target.value as Engine })} className="rounded border border-border bg-white px-2 py-1 dark:bg-black/20">
                  <option value="osrm">OSRM</option>
                  <option value="valhalla">Valhalla</option>
                </select>
                {routingBusy && <span className="opacity-70">berechne…</span>}
              </div>
            </div>
            <div className="flex-1 overflow-auto px-3 pb-2">
              {waypoints.length === 0 && <div className="p-3 text-sm opacity-70">Keine Wegpunkte. Füge Ergebnisse aus der Suche hinzu oder nutze „Kartenmitte“.</div>}
              {waypoints.map((w, i) => (
                <div key={w.id} className={`mb-2 rounded border border-border/60 p-2 ${insertAfter === i ? "ring-2 ring-[#2f5f8b]" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{i + 1}. {w.name}</div>
                      <div className="truncate text-xs opacity-60">{w.coord[1].toFixed(5)}, {w.coord[0].toFixed(5)}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button className="rounded bg-zinc-200 px-2 py-1 text-xs hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600" onClick={() => { const map = mapRef.current; if (!map) return; map.flyTo({ center: w.coord, zoom: 12 }); }}>Zoomen</button>
                      <button className="rounded bg-zinc-200 px-2 py-1 text-xs hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600" onClick={() => setInsertAfter(i)}>➕ hier</button>
                      <button className="rounded bg-zinc-200 px-2 py-1 text-xs hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600" onClick={() => moveWaypoint(w.id, -1)}>↑</button>
                      <button className="rounded bg-zinc-200 px-2 py-1 text-xs hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600" onClick={() => moveWaypoint(w.id, 1)}>↓</button>
                      <button className="rounded bg-rose-600 px-2 py-1 text-xs text-white hover:bg-rose-700" onClick={() => removeWaypoint(w.id)}>Löschen</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-2 border-t border-border/60 p-3 text-sm">
              <div className="flex items-center gap-3">
                <div className="rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-900 dark:bg-zinc-800 dark:text-zinc-200">Distanz: {roadDistanceKm ? `${roadDistanceKm.toFixed(1)} km` : "–"}</div>
                <div className="rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-900 dark:bg-zinc-800 dark:text-zinc-200">Dauer: {roadDurationMin ? `${Math.round(roadDurationMin)} min` : "–"}</div>
                <div className="ml-auto flex items-center gap-2">
                  <button className="rounded bg-zinc-200 px-2 py-1 text-xs hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600" onClick={exportGeoJSON}>Export GeoJSON</button>
                  <button className="rounded bg-zinc-200 px-2 py-1 text-xs hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600" onClick={exportGPX}>Export GPX</button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input id="save-name" placeholder="Routenname" className="w-full rounded border border-border bg-white px-2 py-1 text-sm dark:bg-black/20" />
                <button className="rounded bg-emerald-600 px-3 py-1 text-white hover:bg-emerald-700" onClick={() => { const el = document.getElementById("save-name") as HTMLInputElement | null; const name = el?.value?.trim() || "Meine Route"; saveCurrentRoute(name); }}>Speichern</button>
              </div>
              <div>
                <div className="mb-1 font-medium">Gespeicherte Routen</div>
                <div className="max-h-40 overflow-auto rounded border border-border/60">
                  {savedRoutes.length === 0 && <div className="p-2 text-xs opacity-60">Keine gespeicherten Routen</div>}
                  {savedRoutes.map(r => (
                    <div key={r.id} className="flex items-center justify-between gap-2 border-b border-border/60 px-2 py-1 last:border-b-0">
                      <div className="truncate text-xs">{r.name} · {r.waypoints.length} Punkte</div>
                      <div className="flex shrink-0 gap-1">
                        <button className="rounded bg-zinc-200 px-2 py-1 text-xs hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600" onClick={() => loadRoute(r.id)}>Laden</button>
                        <button className="rounded bg-rose-600 px-2 py-1 text-xs text-white hover:bg-rose-700" onClick={() => deleteRoute(r.id)}>Entfernen</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {configOpen && (
        <div className="fixed left-1/2 top-24 z-20 w-[36rem] -translate-x-1/2 rounded-md border border-border/60 bg-white p-4 text-sm shadow-xl dark:bg-zinc-900">
          <div className="mb-2 text-base font-medium">Einstellungen & Endpoints</div>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs opacity-70">Geocoder Base (Photon)</label>
              <input value={config.geocoderBase} onChange={(e) => setConfig({ ...config, geocoderBase: e.target.value })} className="w-full rounded border border-border bg-white px-2 py-1 dark:bg-black/20" />
            </div>
            <div>
              <label className="mb-1 block text-xs opacity-70">Overpass Bases (eine pro Zeile)</label>
              <textarea value={config.overpassBases.join("\n")} onChange={(e) => setConfig({ ...config, overpassBases: e.target.value.split(/\n+/).map(s => s.trim()).filter(Boolean) })} rows={3} className="w-full rounded border border-border bg-white px-2 py-1 dark:bg-black/20" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs opacity-70">OSRM Base</label>
                <input value={config.osrmBase} onChange={(e) => setConfig({ ...config, osrmBase: e.target.value })} className="w-full rounded border border-border bg-white px-2 py-1 dark:bg-black/20" />
              </div>
              <div>
                <label className="mb-1 block text-xs opacity-70">Valhalla Base</label>
                <input value={config.valhallaBase} onChange={(e) => setConfig({ ...config, valhallaBase: e.target.value })} className="w-full rounded border border-border bg-white px-2 py-1 dark:bg-black/20" />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button className="rounded bg-zinc-200 px-3 py-1 hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600" onClick={() => { setConfig(DEFAULT_CONFIG); }}>Zurücksetzen</button>
              <button className="rounded bg-[#2f5f8b] px-3 py-1 text-white hover:bg-[#4892d9]" onClick={() => { persistConfig(); setConfigOpen(false); reloadActiveOverlays(); computeRoadRoute(); }}>Speichern</button>
            </div>
          </div>
        </div>
      )}

      {status && (
        <div className="pointer-events-none fixed inset-0 z-20 grid place-items-center">
          <div className="pointer-events-auto rounded-md bg-white/95 px-3 py-2 text-sm text-black shadow">{status}</div>
        </div>
      )}

      <div className="pointer-events-auto fixed inset-x-2 bottom-2 z-10 rounded-md border border-border/60 bg-white/90 px-2 py-1 text-center text-xs text-black shadow-sm backdrop-blur-sm dark:bg-white/10 dark:text-white">
        © <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> Mitwirkende · Tiles & Style: <a className="underline" href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> · Renderer: <a className="underline" href="https://maplibre.org" target="_blank" rel="noreferrer">MapLibre GL JS</a>
      </div>
    </div>
  );
}