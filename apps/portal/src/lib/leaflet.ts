"use client";

/**
 * Leaflet para los mapas del portal (simulador y Flota). Llega por CDN, sin
 * tipos, con su huella (SRI): si el CDN sirve otra cosa, el navegador no la
 * ejecuta. Al cambiar de versión se cambian las dos constantes.
 */

const LEAFLET_SRC = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
// La misma que publica leafletjs.com para la 1.9.4.
const LEAFLET_INTEGRITY = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";

export const OSM_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

// Sin tipos: lo mínimo que se usa.
export type Leaflet = any;
declare global {
  interface Window {
    L?: Leaflet;
  }
}

export function loadLeaflet(): Promise<Leaflet> {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${LEAFLET_SRC}"]`);
    const script =
      existing ?? Object.assign(document.createElement("script"), { src: LEAFLET_SRC, integrity: LEAFLET_INTEGRITY, crossOrigin: "anonymous", async: true });
    script.addEventListener("load", () => resolve(window.L));
    script.addEventListener("error", () => reject(new Error("No cargó Leaflet")));
    if (!existing) document.head.appendChild(script);
  });
}

/** Lo mínimo del CSS de Leaflet, en línea: se pone con `<style>{LEAFLET_CSS}</style>`. */
export const LEAFLET_CSS = `
.leaflet-pane,.leaflet-tile,.leaflet-marker-icon,.leaflet-marker-shadow,.leaflet-tile-container,.leaflet-pane>svg,.leaflet-pane>canvas,.leaflet-zoom-box,.leaflet-image-layer,.leaflet-layer{position:absolute;left:0;top:0}
.leaflet-container{overflow:hidden;outline:0;-webkit-tap-highlight-color:transparent;background:#f1eff7}
.leaflet-container.leaflet-touch-zoom{touch-action:pan-x pan-y}.leaflet-container.leaflet-touch-drag{touch-action:none}
.leaflet-pane{z-index:400}.leaflet-overlay-pane{z-index:400}.leaflet-marker-pane{z-index:600}.leaflet-tooltip-pane{z-index:650}.leaflet-popup-pane{z-index:700}
.leaflet-map-pane canvas{z-index:100}.leaflet-map-pane svg{z-index:200}
.leaflet-zoom-animated{transform-origin:0 0}.leaflet-zoom-anim .leaflet-zoom-animated{transition:transform .25s cubic-bezier(0,0,.25,1)}
.leaflet-interactive{cursor:pointer}.leaflet-grab{cursor:grab}.leaflet-dragging .leaflet-grab{cursor:grabbing}
.leaflet-marker-icon{display:block}.leaflet-tile{visibility:hidden}.leaflet-tile-loaded{visibility:inherit}
.leaflet-container img.leaflet-tile{max-width:none!important;max-height:none!important;user-select:none}
.leaflet-control-attribution{margin:0;padding:0 5px;font-size:11px;background:rgba(255,255,255,.8);color:#333}
.leaflet-control-container .leaflet-top,.leaflet-control-container .leaflet-bottom{position:absolute;z-index:800;pointer-events:none}
.leaflet-top{top:0}.leaflet-left{left:0}.leaflet-right{right:0}.leaflet-bottom{bottom:0}
.leaflet-control{position:relative;z-index:800;pointer-events:auto;float:left;clear:both;margin:12px 0 0 12px}
.leaflet-bar{border:1px solid #e9e6f1;border-radius:6px;background:#fff;overflow:hidden}
.leaflet-bar a{display:block;width:32px;height:32px;line-height:32px;text-align:center;text-decoration:none;color:#0d0b14;font-size:18px;font-weight:600}
.leaflet-bar a+a{border-top:1px solid #e9e6f1}
.leaflet-tooltip{position:absolute;padding:2px 6px;background:#fff;color:#0d0b14;border:1px solid #e9e6f1;border-radius:4px;white-space:nowrap;font-size:12px;pointer-events:none}
`;
