// Simulador de despacho para demos. Lee de la base (solo lectura) los pedidos
// que crea el bot real y las conversaciones de WhatsApp, y los asigna a motos
// de ejemplo con el engine (apps/engine). No escribe en la base ni envía nada.
//
//   DATABASE_URL=postgres://... node tools/simulador-demo/servidor.mjs
//   Sin DATABASE_URL funciona solo con pedidos creados desde el mapa.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import * as wa from "./whatsapp.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const PUERTO = Number(process.env.PORT ?? 4000);
const PUERTO_ENGINE = Number(process.env.ENGINE_PORT ?? 3013);
const ENGINE = `http://127.0.0.1:${PUERTO_ENGINE}`;
const VELOCIDAD_KMH = 25; // la misma que supone el engine (línea recta × 1,3 a 25 km/h)
const FACTOR_RUTA = 1.3;
const LISTO_POR_DEFECTO_MIN = 10; // si el pedido no trae "listo en"
const ESPERA_CLIENTE_MIN = 10;

// ---------------------------------------------------------------------------
// Engine: se levanta como proceso hijo
// ---------------------------------------------------------------------------

const engine = spawn("python3", [join(DIR, "../../apps/engine/api.py")], {
  env: { ...process.env, PORT: String(PUERTO_ENGINE) },
  stdio: ["ignore", "inherit", "pipe"],
});
// El engine registra cada petición; solo se muestran los errores.
engine.stderr.on("data", (d) => String(d).split("\n").filter((l) => l && !/" 200 -$/.test(l)).forEach((l) => console.error(l)));
process.on("exit", () => engine.kill());
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(0));

async function evaluar(peticion) {
  const r = await fetch(`${ENGINE}/evaluar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(peticion),
  });
  const cuerpo = await r.json();
  if (!r.ok) throw new Error(cuerpo.error ?? `engine ${r.status}`);
  return cuerpo;
}

// ---------------------------------------------------------------------------
// Reloj de la demo: puede ir más rápido que el real
// ---------------------------------------------------------------------------

let velocidad = 1;
let relojBase = Date.now();
let relojVirtual = Date.now();
const ahoraMs = () => relojVirtual + (Date.now() - relojBase) * velocidad;
const ahora = () => Math.floor(ahoraMs() / 1000);
function cambiarVelocidad(v) {
  relojVirtual = ahoraMs();
  relojBase = Date.now();
  velocidad = v;
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

// 16 km: el restaurante de prueba está en Jamundí y las motos en el sur de Cali.
const config = { modo: null, multipedido: true, radio_km: 16 };

// Zona sur de Cali.
const MOTOS_INICIALES = [
  ["Ana", 3.3745, -76.5235, 5], // Valle del Lili
  ["Beto", 3.3925, -76.5165, 2], // El Caney
  ["Carla", 3.3650, -76.5345, 7], // Ciudad Jardín
  ["Dani", 3.3385, -76.5240, 3], // Bochalema
  ["Elena", 3.3960, -76.5400, 4], // El Limonar
  ["Fabio", 3.3700, -76.5110, 1], // Ciudad Pacífica
  ["Gina", 3.3470, -76.5385, 6], // Cañasgordas
  ["Hugo", 3.3840, -76.5300, 2], // Quintas de Don Simón
];

let motos;
let pedidos;
let eventos;
let siguienteManual;
let vistoDesde;

function reiniciar() {
  const t = ahora();
  motos = MOTOS_INICIALES.map(([id, lat, lon, entregas], i) => ({
    id, lat, lon, entregas,
    telefono: `30055501${String(i + 1).padStart(2, "0")}`, // de mentira: sale en el aviso al restaurante
    disponible_desde_ts: t - (i * 4 + 3) * 60,
    activa: true,
    paradas: [],
    llegada_ts: null, // cuándo llegó a la parada en la que está esperando
  }));
  pedidos = new Map();
  eventos = [];
  siguienteManual = 9001;
  vistoDesde = new Date(Date.now() - 2 * 60_000);
  registrar("Simulación reiniciada con 8 motos de ejemplo");
}

function registrar(texto, pedido = null) {
  eventos.unshift({ ts: ahora(), texto, pedido });
  eventos.length = Math.min(eventos.length, 80);
}

function cuota() {
  const activas = motos.filter((m) => m.activa);
  return activas.length ? activas.reduce((s, m) => s + m.entregas, 0) / activas.length : 0;
}

// ---------------------------------------------------------------------------
// Pedidos desde la base (solo lectura)
// ---------------------------------------------------------------------------

const db = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }) : null;
let estadoDb = db ? "conectando" : "sin DATABASE_URL: solo pedidos manuales";

async function leerBase() {
  if (!db) return;
  try {
    const { rows } = await db.query(
      `select t.id, t.code, t.status, t.origin_restaurant_name, t.pickup_address, t.delivery_address,
              coalesce(t.pickup_location, r.known_pickup_location) as pickup, t.delivery_location as delivery,
              t.ready_at, t.created_at, t.value_to_collect, t.delivery_fee, t.notes,
              t.customer_name, t.customer_phone, t.payment_method, t.source_wa_message_id, c.phone as restaurant_phone
         from trips t left join restaurants r on r.id = t.restaurant_id
         left join conversations c on c.id = t.conversation_id
        where t.created_at >= $1 order by t.id`,
      [vistoDesde],
    );
    for (const t of rows) {
      const existente = pedidos.get(t.id);
      if (existente) {
        // El bot puede completar datos después (ubicación, "listo en"): se actualiza mientras espera.
        if (existente.estado === "esperando") completarDesdeBase(existente, t);
        if (t.status === "cancelled" && existente.estado !== "cancelado") cancelar(existente, "cancelado en el bot");
        continue;
      }
      if (t.status === "cancelled") continue;
      const p = {
        id: t.id, codigo: t.code, origen: "whatsapp", estado: "esperando", moto: null,
        restaurante_nombre: t.origin_restaurant_name, recogida: t.pickup_address, entrega: t.delivery_address,
        valor: t.value_to_collect, tarifa: t.delivery_fee, notas: t.notes,
        cliente_nombre: t.customer_name, cliente_tel: t.customer_phone, pago: t.payment_method,
        mensaje_origen: t.source_wa_message_id, restaurante_tel: t.restaurant_phone,
        restaurante: null, cliente: null, listo_ts: null, evaluacion: null, creado_ts: ahora(),
      };
      completarDesdeBase(p, t);
      pedidos.set(p.id, p);
      registrar(`Llegó por WhatsApp el pedido ${p.codigo} de ${p.restaurante_nombre}`, p.id);
    }
    estadoDb = "conectada";
  } catch (e) {
    estadoDb = `error: ${e.message}`;
  }
}

function completarDesdeBase(p, t) {
  if (t.pickup && !p.restaurante) p.restaurante = [t.pickup.lat, t.pickup.lng];
  if (t.delivery && !p.cliente) p.cliente = [t.delivery.lat, t.delivery.lng];
  // Lo que falta en tiempo real se traslada al reloj de la demo (que puede ir acelerado).
  // Sin "listo en" del restaurante se supone LISTO_POR_DEFECTO_MIN desde que se creó.
  if (t.ready_at && !p.listo_real) {
    p.listo_ts = ahora() + Math.max(0, Math.round((t.ready_at.getTime() - Date.now()) / 1000));
    p.listo_real = true;
  } else if (p.listo_ts == null) {
    const faltaMs = LISTO_POR_DEFECTO_MIN * 60_000 - (Date.now() - t.created_at.getTime());
    p.listo_ts = ahora() + Math.max(0, Math.round(faltaMs / 1000));
  }
}

let mensajes = [];
/** Lo que envía el simulador no queda en la base: se muestra en el chat desde aquí. */
const enviados = [];
let ultimoBoton = null;
/** Los toques de «Terminé el servicio» que le llegaron al bot (él los guarda; aquí se leen). */
async function leerBotones() {
  if (!db) return;
  try {
    if (ultimoBoton === null) {
      const { rows } = await db.query("select coalesce(max(id), 0) as id from messages");
      ultimoBoton = Number(rows[0].id);
    }
    const { rows } = await db.query(
      `select id, incoming->>'buttonId' as boton from messages
        where id > $1 and incoming->>'kind' = 'button' and incoming->>'buttonId' like $2 order by id`,
      [ultimoBoton, `${wa.BOTON_ENTREGAR}%`],
    );
    for (const r of rows) {
      ultimoBoton = Math.max(ultimoBoton, r.id);
      const p = pedidos.get(Number(r.boton.slice(wa.BOTON_ENTREGAR.length)));
      if (p) terminar(p);
    }
  } catch (e) {
    estadoDb = `error: ${e.message}`;
  }
}
async function leerChat() {
  if (!db) return;
  try {
    const { rows } = await db.query(
      `select m.id, m.role, m.text, m.created_at, m.trip_id, c.phone, coalesce(c.display_name, c.phone) as nombre
         from messages m join conversations c on c.id = m.conversation_id
        where m.created_at >= $1 order by m.id desc limit 60`,
      [vistoDesde],
    );
    mensajes = rows.reverse().map((m) => ({ id: m.id, rol: m.role, texto: m.text, hora: m.created_at, pedido: m.trip_id, conversacion: m.nombre }));
  } catch (e) {
    estadoDb = `error: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Asignación: cada tick se pregunta al engine por cada pedido que espera
// ---------------------------------------------------------------------------

function peticionPara(p) {
  return {
    ahora: ahora(),
    modo: config.modo,
    multipedido: config.multipedido,
    radio_km: config.radio_km,
    pedido: { id: p.id, restaurante: p.restaurante, cliente: p.cliente, listo_ts: p.listo_ts },
    motos: motos.map((m) => ({
      id: m.id, lat: m.lat, lon: m.lon,
      sin_senal: !m.activa,
      entregas: m.entregas,
      cuota: cuota(),
      disponible_desde_ts: m.disponible_desde_ts,
      paradas: m.paradas.map(({ tipo, punto, pedido, listo_ts }) => (listo_ts != null ? { tipo, punto, pedido, listo_ts } : { tipo, punto, pedido })),
    })),
    tiempos: "haversine",
  };
}

async function evaluarPendientes() {
  for (const p of pedidos.values()) {
    if (p.estado !== "esperando") continue;
    if (!p.restaurante || !p.cliente) {
      p.evaluacion = null;
      continue;
    }
    try {
      p.evaluacion = await evaluar(peticionPara(p));
      p.error = null;
    } catch (e) {
      p.error = e.message;
      continue;
    }
    if (p.evaluacion.ganador && p.evaluacion.despacho.faltan_min === 0) asignar(p, p.evaluacion.ganador, p.evaluacion.plan, p.evaluacion.explicacion);
  }
}

function asignar(p, idMoto, plan, motivo) {
  const moto = motos.find((m) => m.id === idMoto);
  moto.paradas = plan.map((s) => ({ ...s, pedido: s.pedido ?? p.id }));
  moto.llegada_ts = null;
  p.estado = "asignado";
  p.moto = idMoto;
  p.asignado_ts = ahora();
  p.evaluacion_final = p.evaluacion;
  registrar(`${p.codigo} → ${idMoto}. ${motivo ?? ""}`, p.id);
  if (p.origen === "whatsapp") {
    avisar(`Ficha de ${idMoto} enviada al motorizado de la demo`, wa.fichaMotorizado(p, moto), p.id);
    avisar(`Aviso de asignación enviado al restaurante`, wa.avisoAsignado(p, moto), p.id);
  }
}

/** Los envíos no detienen la simulación: el resultado queda en la bitácora. */
function avisar(texto, envio, pedido) {
  envio.then((r) => {
    registrar(r.ok ? `📱 ${texto}` : `⚠️ ${texto}: no salió (${r.motivo})`, pedido);
    if (r.ok) enviados.push({ id: `sim-${enviados.length}`, rol: "bot", texto: r.texto, hora: new Date(), pedido, conversacion: r.para });
  });
}

/** «Terminé el servicio» del motorizado de la demo (o desde el simulador). */
function terminar(p) {
  const moto = motos.find((m) => m.id === p.moto);
  if (!moto || !["asignado", "moto en restaurante", "recogido", "en el cliente"].includes(p.estado)) return;
  moto.paradas = moto.paradas.filter((s) => s.pedido !== p.id);
  moto.llegada_ts = null;
  moto.entregas += 1;
  if (!moto.paradas.length) moto.disponible_desde_ts = ahora();
  p.estado = "entregado";
  registrar(`${moto.id} terminó ${p.codigo}`, p.id);
  if (p.origen === "whatsapp") {
    avisar(`Confirmación enviada al motorizado`, wa.avisoTerminadoMotorizado(p, moto), p.id);
    avisar(`Aviso de entrega enviado al restaurante`, wa.avisoEntregado(p), p.id);
  }
}

/** Asignación manual del despachador: se inserta con la mejor ruta que calcula el engine para esa moto. */
async function asignarManual(p, idMoto) {
  const soloEsa = peticionPara(p);
  soloEsa.motos = soloEsa.motos.filter((m) => m.id === idMoto).map((m) => ({ ...m, sin_senal: false }));
  const r = await evaluar({ ...soloEsa, radio_km: 1000, multipedido: true, config: { MAX_PEDIDOS: { pico: 99, valle: 99 }, R_MAX_MIN: 999 } });
  if (!r.plan) throw new Error(`${idMoto} no puede llevar este pedido`);
  asignar(p, idMoto, r.plan, "(asignado a mano por el despachador)");
}

function quitarDeRuta(p) {
  const moto = motos.find((m) => m.id === p.moto);
  if (moto) moto.paradas = moto.paradas.filter((s) => s.pedido !== p.id);
}

function cancelar(p, motivo) {
  quitarDeRuta(p);
  p.estado = "cancelado";
  registrar(`${p.codigo} cancelado (${motivo})`, p.id);
}

// ---------------------------------------------------------------------------
// Movimiento: las motos recorren sus paradas a la velocidad que supone el engine
// ---------------------------------------------------------------------------

const rad = (g) => (g * Math.PI) / 180;
function km(a, b) {
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

let ultimoMov = ahoraMs();
function mover() {
  const t = ahoraMs();
  const dtMin = (t - ultimoMov) / 60_000;
  ultimoMov = t;
  for (const m of motos) {
    let restante = (VELOCIDAD_KMH / FACTOR_RUTA / 60) * dtMin; // km en línea recta que alcanza a recorrer
    while (m.paradas.length && restante > 0) {
      const s = m.paradas[0];
      const d = km([m.lat, m.lon], s.punto);
      if (d > restante) {
        const f = restante / d;
        m.lat += (s.punto[0] - m.lat) * f;
        m.lon += (s.punto[1] - m.lon) * f;
        break;
      }
      restante -= d;
      [m.lat, m.lon] = s.punto;
      if (!llegar(m, s)) break;
    }
  }
}

/** La moto está en la parada. Devuelve true si la completó y puede seguir. */
function llegar(m, s) {
  const p = pedidos.get(s.pedido);
  const nombre = p?.codigo ?? `#${s.pedido}`;
  if (m.llegada_ts == null) m.llegada_ts = ahora();
  if (s.tipo === "R") {
    if (s.listo_ts != null && ahora() < s.listo_ts) {
      if (p) p.estado = "moto en restaurante";
      return false; // la moto espera la comida
    }
    if (p) {
      p.estado = "recogido";
      p.espera_moto_min = Math.round((ahora() - m.llegada_ts) / 6) / 10;
    }
    registrar(`${m.id} recogió ${nombre}${p?.espera_moto_min ? ` (esperó ${p.espera_moto_min} min la comida)` : ""}`, s.pedido);
  } else if (s.tipo === "C") {
    // Los pedidos de WhatsApp se cierran cuando el motorizado toca «Terminé el servicio».
    if (p?.origen === "whatsapp") {
      if (p.estado !== "en el cliente") registrar(`${m.id} llegó donde el cliente de ${nombre}: falta que toque «Terminé el servicio»`, s.pedido);
      p.estado = "en el cliente";
      return false;
    }
    if (p) p.estado = "entregado";
    m.entregas += 1;
    registrar(`${m.id} entregó ${nombre}`, s.pedido);
  } else if (s.tipo === "W") {
    if (ahora() < s.listo_ts) return false;
    // Pasó la espera: devuelve el pedido al restaurante.
    const r = p?.restaurante ?? s.punto;
    s.tipo = "V";
    s.punto = r;
    delete s.listo_ts;
    m.llegada_ts = null;
    registrar(`${m.id}: el cliente de ${nombre} nunca contestó, lo devuelve al restaurante`, s.pedido);
    return false;
  } else if (s.tipo === "V") {
    if (p) p.estado = "devuelto";
    registrar(`${m.id} devolvió ${nombre} al restaurante`, s.pedido);
  }
  m.paradas.shift();
  m.llegada_ts = null;
  if (!m.paradas.length) m.disponible_desde_ts = ahora();
  return true;
}

// ---------------------------------------------------------------------------
// Intervenciones
// ---------------------------------------------------------------------------

function clienteNoContesta(m) {
  const i = m.paradas.findIndex((s) => s.tipo === "C");
  if (i < 0) throw new Error(`${m.id} no tiene entregas pendientes`);
  const c = m.paradas[i];
  // La moto ya está donde el cliente: llega ahí y espera.
  [m.lat, m.lon] = c.punto;
  m.paradas.splice(i, 1);
  m.paradas.unshift({ tipo: "W", punto: c.punto, pedido: c.pedido, listo_ts: ahora() + ESPERA_CLIENTE_MIN * 60 });
  m.llegada_ts = ahora();
  const p = pedidos.get(c.pedido);
  if (p) p.estado = "cliente no contesta";
  registrar(`${m.id}: el cliente de ${p?.codigo ?? c.pedido} no contesta. Espera ${ESPERA_CLIENTE_MIN} min y la moto no recibe pedidos nuevos`, c.pedido);
}

function clienteRespondio(m) {
  const s = m.paradas[0];
  if (s?.tipo !== "W") throw new Error(`${m.id} no está esperando a un cliente`);
  s.tipo = "C";
  delete s.listo_ts;
  const p = pedidos.get(s.pedido);
  if (p) p.estado = "recogido";
  registrar(`${m.id}: el cliente contestó, entrega ${p?.codigo ?? s.pedido}`, s.pedido);
}

/** La moto se desconecta: sus pedidos sin recoger vuelven a la cola y se reasignan solos. */
function apagarMoto(m) {
  m.activa = false;
  const sinRecoger = new Set(m.paradas.filter((s) => s.tipo === "R").map((s) => s.pedido));
  m.paradas = m.paradas.filter((s) => !sinRecoger.has(s.pedido));
  for (const id of sinRecoger) {
    const p = pedidos.get(id);
    if (!p) continue;
    p.estado = "esperando";
    p.moto = null;
    registrar(`${p.codigo} vuelve a la cola: ${m.id} se desconectó`, id);
  }
  registrar(`${m.id} se desconectó${m.paradas.length ? " (termina lo que ya recogió)" : ""}`);
}

// ---------------------------------------------------------------------------
// Ciclo
// ---------------------------------------------------------------------------

reiniciar();
let ocupado = false;
setInterval(async () => {
  if (ocupado) return;
  ocupado = true;
  try {
    mover();
    await leerBase();
    await evaluarPendientes();
  } finally {
    ocupado = false;
  }
}, 1000);
setInterval(leerChat, 1500);
setInterval(leerBotones, 1500);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function estado() {
  return {
    ahora: ahora(), velocidad, config, estadoDb, cuota: cuota(),
    whatsapp: wa.whatsappActivo ? (wa.motorizadoDemo ? `fichas a ${wa.motorizadoDemo}` : "falta DEMO_MOTORIZADO") : "sin configurar",
    motos, pedidos: [...pedidos.values()], eventos,
    mensajes: [...mensajes, ...enviados].sort((a, b) => new Date(a.hora) - new Date(b.hora)).slice(-80),
  };
}

const acciones = {
  async config(b) {
    if ("modo" in b) config.modo = b.modo || null;
    if ("multipedido" in b) config.multipedido = Boolean(b.multipedido);
    if ("radio_km" in b) config.radio_km = Number(b.radio_km);
    if ("velocidad" in b) cambiarVelocidad(Number(b.velocidad));
  },
  async reiniciar() {
    reiniciar();
  },
  async pedido(b) {
    const id = siguienteManual++;
    pedidos.set(id, {
      id, codigo: `M-${id - 9000}`, origen: "manual", estado: "esperando", moto: null,
      restaurante_nombre: b.nombre || "Pedido manual", restaurante: b.restaurante, cliente: b.cliente,
      listo_ts: ahora() + Number(b.listo_en ?? 0) * 60, creado_ts: ahora(), evaluacion: null,
    });
    registrar(`Pedido manual M-${id - 9000} (listo en ${b.listo_en ?? 0} min)`, id);
  },
  async ubicar(b) {
    const p = pedidos.get(b.pedido);
    p[b.campo === "restaurante" ? "restaurante" : "cliente"] = b.punto;
  },
  async asignar(b) {
    const p = pedidos.get(b.pedido);
    if (p.estado !== "esperando") quitarDeRuta(p);
    await asignarManual(p, b.moto);
  },
  async forzar(b) {
    // Asigna ya a la ganadora, sin esperar el momento de despacho.
    const p = pedidos.get(b.pedido);
    if (!p.evaluacion?.ganador) throw new Error("Ninguna moto es elegible");
    asignar(p, p.evaluacion.ganador, p.evaluacion.plan, "(sin esperar el despacho diferido)");
  },
  async terminar(b) {
    terminar(pedidos.get(b.pedido));
  },
  async cancelar(b) {
    cancelar(pedidos.get(b.pedido), "desde el simulador");
  },
  async moto(b) {
    const m = motos.find((x) => x.id === b.moto);
    if (b.accion === "no_contesta") clienteNoContesta(m);
    else if (b.accion === "contesto") clienteRespondio(m);
    else if (b.accion === "apagar") apagarMoto(m);
    else if (b.accion === "encender") {
      m.activa = true;
      m.disponible_desde_ts = ahora();
      registrar(`${m.id} se conectó`);
    } else if (b.accion === "mover") {
      [m.lat, m.lon] = b.punto;
    }
  },
  async nueva_moto(b) {
    const id = b.id || `Moto ${motos.length + 1}`;
    motos.push({ id, lat: b.punto[0], lon: b.punto[1], entregas: Math.round(cuota()), disponible_desde_ts: ahora(), activa: true, paradas: [], llegada_ts: null });
    registrar(`${id} se conectó`);
  },
};

const html = () => readFileSync(join(DIR, "index.html"));

http
  .createServer(async (req, res) => {
    const json = (codigo, datos) => {
      res.writeHead(codigo, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(datos));
    };
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html());
      }
      if (req.method === "GET" && req.url === "/api/estado") return json(200, estado());
      const accion = req.method === "POST" && req.url.startsWith("/api/") && acciones[req.url.slice(5)];
      if (!accion) return json(404, { error: "No encontrado" });
      let cuerpo = "";
      for await (const parte of req) cuerpo += parte;
      await accion(cuerpo ? JSON.parse(cuerpo) : {});
      json(200, { ok: true });
    } catch (e) {
      json(400, { error: e.message });
    }
  })
  .listen(PUERTO, () => console.log(`Simulador en http://localhost:${PUERTO}  (base: ${estadoDb})`));
