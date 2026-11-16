import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  demandLevel,
  idlePayText,
  modeForDemand,
  orderRoute,
  routeText,
  sameRestaurant,
  sameTripReturnText,
  type RouteLine,
} from "./route";

/**
 * La ruta del domiciliario con sus regresos (#60): dónde entra un regreso
 * según la demanda, cuál es del mismo restaurante y cómo se le escribe.
 */

const key = (stops: { tipo: string; pedido: number }[]) => stops.map((s) => `${s.tipo}${s.pedido}`);
const datafono = { id: 40, inRoute: true };

describe("demandLevel: mientras no se mida (#59), el horario del engine", () => {
  it("alta de 7:00 a 9:30 p.m. de Cali, baja el resto", () => {
    assert.equal(demandLevel(new Date("2026-11-16T00:00:00Z")), "alta"); // 7:00 p.m.
    assert.equal(demandLevel(new Date("2026-11-16T02:29:00Z")), "alta"); // 9:29 p.m.
    assert.equal(demandLevel(new Date("2026-11-16T02:30:00Z")), "baja"); // 9:30 p.m.
    assert.equal(demandLevel(new Date("2026-11-15T23:59:00Z")), "baja"); // 6:59 p.m.
    assert.equal(demandLevel(new Date("2026-11-15T17:00:00Z")), "baja"); // mediodía
  });

  it("alta = pico, baja = valle", () => {
    assert.equal(modeForDemand("alta"), "pico");
    assert.equal(modeForDemand("baja"), "valle");
  });
});

describe("orderRoute: solo regresos reales", () => {
  it("sin pendientes no hay regreso", () => {
    const trips = [{ id: 7, stops: ["C" as const] }, { id: 8, stops: ["R" as const, "C" as const] }];
    assert.deepEqual(key(orderRoute(null, trips, [], "baja")), ["C7", "R8", "C8"]);
  });

  it("la plata que no está en la ruta no aparece", () => {
    assert.deepEqual(key(orderRoute(null, [{ id: 7, stops: ["C"] }], [{ id: 41, inRoute: false }], "baja")), ["C7"]);
  });
});

describe("orderRoute: dónde entra un regreso nuevo", () => {
  const trips = [
    { id: 7, stops: ["C" as const] },
    { id: 8, stops: ["R" as const, "C" as const] },
  ];

  it("con demanda baja, apenas entrega lo que lleva y antes de la siguiente recogida", () => {
    assert.deepEqual(key(orderRoute(null, trips, [datafono], "baja")), ["C7", "B40", "R8", "C8"]);
  });

  it("con demanda alta, al final", () => {
    assert.deepEqual(key(orderRoute(null, trips, [datafono], "alta")), ["C7", "R8", "C8", "B40"]);
  });

  it("nunca con comida a bordo: si recoge antes de entregar lo que lleva, espera a entregar los dos", () => {
    const plan = [
      { tipo: "R" as const, pedido: 8 },
      { tipo: "C" as const, pedido: 7 },
      { tipo: "C" as const, pedido: 8 },
    ];
    assert.deepEqual(key(orderRoute(plan, trips, [datafono], "baja")), ["R8", "C7", "C8", "B40"]);
  });

  it("libre: el regreso es lo primero", () => {
    assert.deepEqual(key(orderRoute(null, [{ id: 8, stops: ["R", "C"] }], [datafono], "baja")), ["B40", "R8", "C8"]);
  });

  it("el que el plan ya conoce se queda donde el engine lo puso", () => {
    const plan = [
      { tipo: "C" as const, pedido: 7 },
      { tipo: "R" as const, pedido: 8 },
      { tipo: "C" as const, pedido: 8 },
      { tipo: "B" as const, pedido: 40 },
    ];
    assert.deepEqual(key(orderRoute(plan, trips, [datafono], "baja")), ["C7", "R8", "C8", "B40"]);
  });

  it("un regreso cerrado sale de la ruta aunque el plan lo tenga", () => {
    const plan = [{ tipo: "B" as const, pedido: 40 }, { tipo: "C" as const, pedido: 7 }];
    assert.deepEqual(key(orderRoute(plan, [{ id: 7, stops: ["C"] }], [], "baja")), ["C7"]);
  });
});

describe("sameRestaurant", () => {
  it("por id si los dos lo tienen", () => {
    assert.ok(sameRestaurant({ restaurantId: 3, restaurantName: "A" }, { restaurantId: 3, restaurantName: "B" }));
    assert.ok(!sameRestaurant({ restaurantId: 3, restaurantName: "Donde Lucho" }, { restaurantId: 4, restaurantName: "Donde Lucho" }));
  });

  it("si no, por el nombre sin tildes ni mayúsculas", () => {
    assert.ok(sameRestaurant({ restaurantId: null, restaurantName: "Café Óscar" }, { restaurantId: 4, restaurantName: "cafe oscar" }));
    assert.ok(!sameRestaurant({ restaurantId: null, restaurantName: "" }, { restaurantId: null, restaurantName: "" }));
  });
});

describe("routeText: la ruta al principio de cada mensaje", () => {
  const tres: RouteLine[] = [
    { tipo: "C", code: "A-07", restaurant: "Donde Lucho", zone: "San Fernando" },
    { tipo: "R", code: "A-08", restaurant: "La Brasa", zone: "El Peñón" },
    { tipo: "C", code: "A-08", restaurant: "La Brasa", zone: "El Peñón" },
    { tipo: "B", reason: "datafono", restaurant: "Donde Lucho" },
  ];

  it("numerada, con lo que sigue marcado", () => {
    assert.equal(
      routeText(tres),
      [
        "🧭 *Tu ruta:*",
        "1. ➡️ Entrega A-07 (San Fernando)",
        "2. Recoge A-08 en La Brasa",
        "3. Entrega A-08 (El Peñón)",
        "4. Devuelve el datáfono en Donde Lucho",
      ].join("\n"),
    );
  });

  it("con tres paradas sale; con una sola no", () => {
    assert.ok(routeText(tres.slice(0, 3))?.startsWith("🧭 *Tu ruta:*\n1. ➡️ Entrega A-07"));
    assert.equal(routeText(tres.slice(0, 1)), null);
    assert.equal(routeText([]), null);
  });

  it("un solo pedido (recoger y entregar) no lleva lista: el mensaje ya lo dice", () => {
    assert.equal(routeText(tres.slice(1, 3)), null);
  });

  it("un pedido y un regreso sí", () => {
    assert.equal(routeText([tres[0], tres[3]]), "🧭 *Tu ruta:*\n1. ➡️ Entrega A-07 (San Fernando)\n2. Devuelve el datáfono en Donde Lucho");
  });

  it("la plata, la espera y la devolución del pedido", () => {
    const text = routeText([
      { tipo: "W", code: "A-09", restaurant: "X", zone: null },
      { tipo: "V", code: "A-09", restaurant: "X", zone: null },
      { tipo: "B", reason: "plata", restaurant: "La Brasa" },
    ]);
    assert.equal(text, "🧭 *Tu ruta:*\n1. ➡️ Espera al cliente de A-09\n2. Devuelve A-09 en X\n3. Paga en La Brasa");
  });

  it("cada línea es corta para leerla en el celular", () => {
    for (const line of routeText(tres)!.split("\n")) assert.ok(line.length <= 45, line);
  });
});

describe("mensajes de los regresos", () => {
  it("«Aprovecha y…» cuando recoge donde tiene un pendiente", () => {
    assert.equal(sameTripReturnText(["datafono"], "Donde Lucho"), "♻️ *Aprovecha y devuelve el datáfono en Donde Lucho.*");
    assert.equal(sameTripReturnText(["plata"], "Donde Lucho"), "♻️ *Aprovecha y paga en Donde Lucho.*");
    assert.equal(sameTripReturnText(["plata", "datafono"], "X"), "♻️ *Aprovecha y devuelve el datáfono y paga en X.*");
    assert.equal(sameTripReturnText([], "X"), null);
  });

  it("«Aprovecha: pasa por X a pagar» con la moto libre", () => {
    assert.equal(idlePayText("Donde Lucho", "A-07 y A-08"), "💵 Aprovecha: pasa por Donde Lucho a pagar (A-07 y A-08). Cuando lo hagas, toca «Ya pagué».");
  });
});
