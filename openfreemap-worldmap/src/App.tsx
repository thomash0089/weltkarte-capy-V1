import { useEffect, useRef, useState } from "react";

declare global { interface Window { maplibregl?: any } }

const MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js";
const MAPLIBRE_CSS = "https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css";

const OFM_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const SUPPORTED_LANGS = ["de", "en", "es", "fr"] as const;
type Lang = (typeof SUPPORTED_LANGS)[number];
const LABEL_SCALE = 1.6;

export default function App() {
  const mapRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const [lang, setLang] = useState<Lang>("de");
  const [status, setStatus] = useState<string>("Lade Karte …");

  const userMarkersRef = useRef<any[]>([]);
  const favoritesRef = useRef<any[]>([]);
  const routesRef = useRef<any[]>([]);

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
            scaleTextSizesOnMap(map, LABEL_SCALE); // nur einmalig skalieren
          } catch {}

          prepareUserSourcesAndLayers(map);
          map.on("click", (e: any) => addUserMarker(map, [e.lngLat.lng, e.lngLat.lat]));
          setStatus("");
        });

        map.on("error", (e: any) => {
          setStatus(`Fehler: ${e?.error?.message ?? "Unbekannt"}`);
        });
      } catch (e: any) {
        setStatus(`Konnte Karte nicht laden: ${e?.message ?? e}`);
      }
    })();

    return () => {
      canceled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Sprachwechsel live anwenden
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try { applyLanguageOnMap(map, lang); } catch {}
  }, [lang]);

  // ======= Loader für MapLibre (falls CDN verspätet lädt) =======
  async function ensureMapLibreLoaded() {
    if (window.maplibregl) return;
    // CSS einfügen
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = MAPLIBRE_CSS;
    document.head.appendChild(css);
    // JS laden und auf window.maplibregl warten
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = MAPLIBRE_JS;
      s.async = true;
      s.onload = () => (window.maplibregl ? resolve() : reject(new Error("MapLibre nicht verfügbar")));
      s.onerror = () => reject(new Error("MapLibre Script konnte nicht geladen werden"));
      document.head.appendChild(s);
    });
  }

  // ======= Style-Operationen direkt auf der Map =======
  function localizedTextExpression(l: Lang) {
    return ["coalesce", ["get", `name:${l}`], ["get", "name:latin"], ["get", "name"]];
  }
  function applyLanguageOnMap(map: any, l: Lang) {
    const expr = localizedTextExpression(l);
    const layers = (map.getStyle()?.layers ?? []) as any[];
    for (const layer of layers) {
      if (layer.type !== "symbol") continue;
      try { map.setLayoutProperty(layer.id, "text-field", expr); } catch {}
    }
  }
  function scaleTextSizesOnMap(map: any, factor: number) {
    const layers = (map.getStyle()?.layers ?? []) as any[];
    for (const layer of layers) {
      if (layer.type !== "symbol") continue;
      try {
        const current = map.getLayoutProperty(layer.id, "text-size");
        map.setLayoutProperty(layer.id, "text-size", ["*", current ?? 12, factor]);
      } catch {}
    }
  }

  // ======= Benutzer-Layer (Marker/Favoriten/Route) =======
  function prepareUserSourcesAndLayers(map: any) {
    map.addSource("user-markers", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "user-markers-layer", type: "circle", source: "user-markers", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 3, 8, 6, 14, 9], "circle-color": "#2f5f8b", "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } }, topmostSymbolLayerId(map));

    map.addSource("favorites", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "favorites-layer", type: "symbol", source: "favorites", layout: { "icon-image": ["coalesce", ["get", "icon"], "marker-15"], "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 0.9, 14, 1.3], "text-field": ["coalesce", ["get", "title"], "Favorit"], "text-offset": [0, 1.1], "text-anchor": "top", "text-size": ["*", 12, LABEL_SCALE * 0.9] }, paint: { "text-color": "#1b1b1b", "text-halo-color": "#ffffff", "text-halo-width": 1.2 } }, "user-markers-layer");

    map.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "routes-casing", type: "line", source: "routes", paint: { "line-color": "#0b2e4f", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2, 10, 5, 14, 8], "line-opacity": 0.25 } }, "favorites-layer");
    map.addLayer({ id: "routes-line", type: "line", source: "routes", paint: { "line-color": "#1e88e5", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 10, 3.5, 14, 6] } }, "routes-casing");
  }

  function topmostSymbolLayerId(map: any) {
    const layers = (map.getStyle()?.layers ?? []) as any[];
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i].type === "symbol") return layers[i].id;
    return undefined;
  }

  function addUserMarker(map: any, lngLat: [number, number], props: Record<string, any> = {}) {
    const f = { type: "Feature", geometry: { type: "Point", coordinates: lngLat }, properties: { createdAt: Date.now(), ...props } };
    userMarkersRef.current.push(f);
    map.getSource("user-markers").setData({ type: "FeatureCollection", features: userMarkersRef.current });
  }
  function clearUserMarkers() {
    userMarkersRef.current = [];
    const map = mapRef.current;
    if (map) map.getSource("user-markers").setData({ type: "FeatureCollection", features: [] });
  }
  function addFavorite(map: any, lngLat: [number, number], title = "Favorit", icon = "star-15") {
    const f = { type: "Feature", geometry: { type: "Point", coordinates: lngLat }, properties: { title, icon } };
    favoritesRef.current.push(f);
    map.getSource("favorites").setData({ type: "FeatureCollection", features: favoritesRef.current });
  }
  function addRoute(coords: [number, number][], props: Record<string, any> = {}) {
    const map = mapRef.current;
    const f = { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: props };
    routesRef.current.push(f);
    map.getSource("routes").setData({ type: "FeatureCollection", features: routesRef.current });
  }
  function clearRoutes() {
    routesRef.current = [];
    const map = mapRef.current;
    map.getSource("routes").setData({ type: "FeatureCollection", features: [] });
  }

  return (
    <div className="h-dvh w-dvw overflow-hidden bg-background text-foreground">
      <div className="fixed left-2 right-2 top-2 z-10 flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-white/90 p-2 shadow-sm backdrop-blur-sm dark:bg-white/10">
        <div className="flex items-center gap-2">
          <label htmlFor="lang" className="text-sm font-medium">Sprache</label>
          <select id="lang" className="rounded-md border border-border bg-white px-2 py-1 text-sm dark:bg-black/20" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            {SUPPORTED_LANGS.map((l) => (<option key={l} value={l}>{l.toUpperCase()}</option>))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button className="rounded-md bg-[#2f5f8b] px-3 py-1 text-sm text-white hover:bg-[#4892d9]" onClick={() => clearUserMarkers()} title="Alle Marker entfernen">Marker löschen</button>
          <button className="rounded-md bg-[#2f5f8b] px-3 py-1 text-sm text-white hover:bg-[#4892d9]" onClick={() => addRoute([[2.3522, 48.8566],[8.6821, 50.1109],[13.4050, 52.5200]], { name: "Demo-Route" })} title="Beispielroute hinzufügen">Demo‑Route</button>
          <button className="rounded-md bg-[#2f5f8b] px-3 py-1 text-sm text-white hover:bg-[#4892d9]" onClick={() => clearRoutes()} title="Alle Routen entfernen">Route löschen</button>
        </div>
      </div>

      {/* Map-Container mit Fallback-Style, falls Tailwind mal nicht greift */}
      <div ref={mapContainerRef} style={{ position: "fixed", left: 0, right: 0, top: 56, bottom: 28 }} />

      {/* Status/Fehleranzeige */}
      {status && (
        <div className="pointer-events-none fixed inset-0 z-20 grid place-items-center">
          <div className="pointer-events-auto rounded-md bg-white/95 px-3 py-2 text-sm text-black shadow">
            {status}
          </div>
        </div>
      )}

      <div className="pointer-events-auto fixed inset-x-2 bottom-2 z-10 rounded-md border border-border/60 bg-white/90 px-2 py-1 text-center text-xs text-black shadow-sm backdrop-blur-sm dark:bg-white/10 dark:text-white">
        © <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> Mitwirkende · Tiles & Style: <a className="underline" href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> · Renderer: <a className="underline" href="https://maplibre.org" target="_blank" rel="noreferrer">MapLibre GL JS</a>
      </div>
    </div>
  );
}
