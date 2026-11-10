// Íconos del portal instalado como app (manifest, iPhone y notificaciones),
// sacados del logotipo oficial. Se corre una vez y se commitean los PNG:
//
//   node tools/iconos-portal/generar.mjs
//
// Usa sharp, que ya viene con Next.
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const sharp = createRequire(path.join(root, "apps/portal/package.json"))("sharp");

const LOGO = path.join(root, "apps/portal/src/assets/logotipo-clapi.svg");
const OUT = path.join(root, "apps/portal/public/icons");
const FONDO = "#0d0b14"; // el azul noche del portal

const logo = await sharp(LOGO, { density: 600 }).trim().png().toBuffer();
const { width: lw, height: lh } = await sharp(logo).metadata();

/** El logotipo centrado sobre el azul noche, ocupando `share` del ancho. */
async function icon(size, share, file) {
  const w = Math.round(size * share);
  const mark = await sharp(logo).resize({ width: w }).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: FONDO } })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toFile(path.join(OUT, file));
}

// "any": el logotipo grande. "maskable": Android lo recorta en círculo o
// gota; dentro del 80 % central queda entero.
await icon(192, 0.8, "icon-192.png");
await icon(512, 0.8, "icon-512.png");
await icon(512, 0.68, "maskable-512.png");
// iPhone le pone sus propias esquinas redondeadas.
await icon(180, 0.8, "apple-touch-icon.png");

// La insignia de la barra de estado de Android: solo cuenta la silueta
// (blanco sobre transparente). Va la A con el punto, que se lee a 24 px.
const aLeft = Math.round(lw * 0.427);
const aWidth = Math.round(lw * 0.258);
const a = await sharp(logo).extract({ left: aLeft, top: 0, width: aWidth, height: lh }).trim().toBuffer();
const silhouette = await sharp(a)
  .resize({ width: 72, height: 72, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .extractChannel("alpha")
  .toBuffer();
const white = await sharp({ create: { width: 72, height: 72, channels: 3, background: "#ffffff" } }).png().toBuffer();
const badge = await sharp(white).joinChannel(silhouette).png().toBuffer();
await sharp({ create: { width: 96, height: 96, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: badge, gravity: "center" }])
  .png()
  .toFile(path.join(OUT, "badge-96.png"));

console.log("Íconos en", OUT, `(logotipo ${lw}×${lh})`);
