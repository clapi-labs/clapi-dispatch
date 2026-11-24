/**
 * Evaluación de los encargos contra OpenAI de verdad: que el bot distinga un
 * domicilio normal (recoger la comida del restaurante y llevarla a un cliente)
 * de un encargo (comprar o traer algo para el restaurante). Confundirlos en
 * cualquiera de los dos sentidos es grave: un encargo tomado como domicilio
 * crea un viaje al revés, y un domicilio tomado como encargo se le quita al
 * algoritmo. No va en CI porque gasta la llave y el modelo puede cambiar de
 * respuesta. Correrlo al cambiar el prompt o el modelo:
 *
 *   npm run bot:eval:encargos            # una vuelta
 *   npm run bot:eval:encargos -- 3       # tres vueltas (el modelo no siempre responde igual)
 *
 * Termina con error si algún caso falla en alguna vuelta. Los restaurantes y
 * clientes son inventados; las tiendas (Ara, D1, Éxito…) son cadenas públicas.
 */
import { emptyDraft, looksLikeErrand, mergeTripFields, type OrderDraft } from "@dispatch/shared";

import { interpretMessage } from "../src/services/openai/extract";

type Case = {
  id: string;
  /** Los mensajes del restaurante, en orden; cada uno es un turno. */
  turns: string[];
  errand: boolean;
  /** Un pedido normal ya en curso antes del primer turno. */
  withOrder?: boolean;
};

const CASES: Case[] = [
  // Encargos reales (los nombres de los restaurantes se quitaron).
  { id: "R1", errand: true, turns: ["de ir al ara a comprar 3 paquetes de tortillas en el ara tamaño XL", "por favor"] },
  { id: "R2", errand: true, turns: ["Holiii", "Necesito un Domi", "(Foto de un envase de icopor) De estos envases k1", "Me traes 30 porfis"] },
  { id: "R3", errand: true, turns: ["necesito que me compren un queso tajado en la salsamentaria ciudadela"] },
  // Encargos simulados con el mismo patrón.
  { id: "S1", errand: true, turns: ["Buenas, me hacen el favor de comprarme 2 bolsas de hielo en el D1 de la 100"] },
  { id: "S2", errand: true, turns: ["necesito un domi que me traiga 5 kilos de papa de la galería"] },
  { id: "S3", errand: true, turns: ["Me compran una pipeta de gas? se nos acabó"] },
  { id: "S4", errand: true, turns: ["porfa un domi para el Éxito, comprar 2 litros de leche y una crema y traerlos acá"] },
  { id: "S5", errand: true, turns: ["se nos acabaron las servilletas, me pueden traer 3 paquetes de la papelería?"] },
  { id: "S6", errand: true, turns: ["domi para ir a la droguería por un acetaminofén y traérmelo"] },
  { id: "S7", errand: true, turns: ["necesito que vayan al Ara y me traigan 4 coca colas de 1.5"] },
  { id: "S8", errand: true, turns: ["Hola, un favor: comprar pan tajado en la panadería del frente y traerlo"] },
  { id: "S9", errand: true, turns: ["Me consiguen 20 tapas para vasos de 12 oz en la desechables de la 25?"] },
  { id: "S10", errand: true, turns: ["Necesito un domi", "es para comprar unas salsas en el Makro"] },
  { id: "S11", errand: true, turns: ["¿Me pueden hacer una vuelta? comprar 2 aguacates en la frutería"] },
  { id: "S12", errand: true, turns: ["que me traigan 2 cajas de huevos del D1 porfa, le pago al domi cuando llegue"] },
  { id: "S13", errand: true, turns: ["Necesito un domi que pase por el supermercado y me traiga 3 paquetes de mozarella"] },
  { id: "S14", errand: true, turns: ["Compra 1 bolsa de carbón en la estación y me la traes"] },
  // Más encargos, escritos distinto.
  { id: "S15", errand: true, turns: ["se me acabó el aceite, alguien que vaya al D1 por 2 botellas?"] },
  { id: "S16", errand: true, turns: ["Buenas tardes", "necesito 3 bolsas de leche de la tienda de la esquina, ya le transfiero"] },
  { id: "S17", errand: true, turns: ["Necesito un domi", "(Foto de una bolsa de pan) 2 de estas de la panadería Dulce Hogar porfa"] },
  // Encargos que no son compras y mezclados: también van a la central.
  { id: "O1", errand: true, turns: ["necesito un domi que vaya a recoger unas cajas donde mi proveedor y me las traiga"] },
  {
    id: "O2",
    errand: true,
    turns: ["Domi para la Cra 98 # 45-30, Valle del Lili, Laura 3001234567, listo en 10", "y de camino le compras una coca cola de 400 al cliente"],
  },

  // Domicilios normales que se parecen a un encargo.
  { id: "N1", errand: false, turns: ["Necesito un domi"] },
  { id: "N2", errand: false, turns: ["2 hamburguesas cheese, efectivo con billete de 100 mil, Calle 18 # 122-35, Ana 3001234567"] },
  { id: "N3", errand: false, turns: ["Domi para el D1 de la 100, el cliente trabaja ahí, Andrés 3105550101, ya está"] },
  { id: "N4", errand: false, turns: ["¿Cuánto vale un domi al Ara de Ciudad Jardín?"] },
  { id: "N5", errand: false, turns: ["Domi a la droguería de la 5, entregar a Camila 3001112233, en 10"] },
  { id: "N6", errand: false, turns: ["Reenviado: Hola quiero comprar 2 combos para la Cra 85 # 15-40, soy Mario 3014445566"] },
  { id: "N7", errand: false, turns: ["El cliente compró 3 pizzas, cobrar 85 mil, Bosques del Lili torre 2 apto 301, Sofía 3009998877"] },
  { id: "N8", errand: false, turns: ["lleve datáfono, paga con tarjeta, Cra 100 # 11-60, Pedro 3157778899"] },
  { id: "N9", errand: false, turns: ["¿A qué hora me traen la plata?"] },
  { id: "N10", errand: false, turns: ["necesito el datáfono que se llevó el domi"] },
  { id: "N11", errand: false, turns: ["llevar cambio de 50 mil, Calle 13 # 100-20, Rosa 3001239876, listo en 15"] },
  { id: "N12", errand: false, turns: ["Domi a la galería Alameda puesto 23, Don Jorge 3156667788, ya está"] },
  { id: "N13", errand: false, withOrder: true, turns: ["Me traes la factura firmada cuando entregues porfa"] },
  // Más domicilios normales, escritos distinto, para no ajustar solo a los de arriba.
  { id: "N14", errand: false, turns: ["mi cliente quiere comprar una pizza familiar y que se la lleven a la Calle 5 # 40-10, Julián 3012223344"] },
  { id: "N15", errand: false, turns: ["Pedido: compra de 2 almuerzos ejecutivos, Cra 102 # 14-55 casa 8, doña Luz 3168889900, en 20"] },
  { id: "N16", errand: false, turns: ["Hola!! necesito domi", "Unidad Portal de las Garzas torre 5 apto 1102, Kevin 3227776655, ya está listo"] },
  { id: "N17", errand: false, turns: ["la clienta dice que compra siempre acá, que por favor se lo lleven rápido, Calle 48 # 95-30, Marta 3104441122"] },
  { id: "N18", errand: false, turns: ["Envíame una moto al Unicentro, local 245, para Esteban 3005556677, listo en 5"] },
];

/** Un pedido normal a medio armar, para los casos que llegan con uno en curso. */
function orderInProgress(): OrderDraft {
  return mergeTripFields(emptyDraft(), {
    origenRestaurante: null,
    entregas: [
      {
        direccionEntrega: "Calle 16 # 105-20, Valle del Lili",
        telefonoCliente: "3001234567",
        nombreCliente: "Ana",
        valorACobrar: null,
        metodoPago: null,
        listoEnMinutos: 10,
        notas: null,
        detalleDireccion: null,
        esConjunto: false,
        barrio: "Valle del Lili",
        dudas: null,
      },
    ],
  });
}

type Result = { errand: boolean; byModel: boolean; byText: boolean; failed: boolean; address: string | null };

async function run(c: Case): Promise<Result> {
  let draft = c.withOrder ? orderInProgress() : emptyDraft();
  const result: Result = { errand: false, byModel: false, byText: false, failed: false, address: null };
  for (const turn of c.turns) {
    const out = await interpretMessage(turn, draft);
    if (out.failed) result.failed = true;
    const byText = looksLikeErrand(turn);
    const byModel = out.errand?.byModel ?? false;
    result.byModel ||= byModel;
    result.byText ||= byText;
    draft = mergeTripFields(draft, out.fields);
  }
  result.errand = result.byModel || result.byText;
  result.address = draft.entregas[0]?.direccionEntrega ?? null;
  return result;
}

async function main() {
  const rounds = Math.max(1, Number(process.argv[2]) || 1);
  let failures = 0;
  for (let round = 1; round <= rounds; round++) {
    if (rounds > 1) console.log(`\nVuelta ${round} de ${rounds}`);
    const results = await Promise.all(CASES.map(async (c) => [c, await run(c)] as const));
    for (const [c, r] of results) {
      const ok = !r.failed && r.errand === c.errand;
      if (!ok) failures++;
      const how = r.failed ? "OpenAI falló" : `encargo: ${r.errand ? "sí" : "no"} (modelo ${r.byModel ? "sí" : "no"}, texto ${r.byText ? "sí" : "no"})`;
      const where = r.address ? ` · entrega leída: «${r.address}»` : "";
      console.log(`${ok ? "✅" : "❌"} ${c.id.padEnd(3)} ${c.errand ? "encargo " : "domicilio"} → ${how}${where}  «${c.turns.join(" / ")}»`);
    }
  }
  const total = CASES.length * rounds;
  console.log(`\n${total - failures} de ${total} correctos.`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
