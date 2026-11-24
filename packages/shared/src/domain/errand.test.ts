import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ERRAND_REASON_PREFIX, errandReason, isErrandReason, looksLikeErrand } from "./errand";

/**
 * La red de seguridad de los encargos (errand.ts). Los casos contra el modelo
 * real están en apps/bot/scripts/errand-eval.ts (npm run bot:eval:encargos).
 */
describe("looksLikeErrand", () => {
  it("reconoce los encargos reales y los del mismo patrón", () => {
    for (const text of [
      "de ir al ara a comprar 3 paquetes de tortillas en el ara tamaño XL",
      "Me traes 30 porfis",
      "necesito que me compren un queso tajado en la salsamentaria ciudadela",
      "Buenas, me hacen el favor de comprarme 2 bolsas de hielo en el D1 de la 100",
      "necesito un domi que me traiga 5 kilos de papa de la galería",
      "Me compran una pipeta de gas? se nos acabó",
      "porfa un domi para el Éxito, comprar 2 litros de leche y una crema y traerlos acá",
      "se nos acabaron las servilletas, me pueden traer 3 paquetes de la papelería?",
      "domi para ir a la droguería por un acetaminofén y traérmelo",
      "necesito que vayan al Ara y me traigan 4 coca colas de 1.5",
      "Hola, un favor: comprar pan tajado en la panadería del frente y traerlo",
      "Me consiguen 20 tapas para vasos de 12 oz en la desechables de la 25?",
      "es para comprar unas salsas en el Makro",
      "¿Me pueden hacer una vuelta? comprar 2 aguacates en la frutería",
      "que me traigan 2 cajas de huevos del D1 porfa",
      "Necesito un domi que pase por el supermercado y me traiga 3 paquetes de mozarella",
      "Compra 1 bolsa de carbón en la estación y me la traes",
      "necesito un domi que vaya a recoger unas cajas donde mi proveedor y me las traiga",
      "y de camino le compras una coca cola de 400 al cliente",
      "CÓMPRAME UNA LIBRA DE ARROZ EN EL ARA",
      "necesito un mandado",
    ]) {
      assert.equal(looksLikeErrand(text), true, text);
    }
  });

  it("no confunde un domicilio normal con un encargo", () => {
    for (const text of [
      "Necesito un domi",
      "Necesito una moto para la Cra 98 # 45-30, listo en 10",
      "2 hamburguesas cheese, efectivo con billete de 100 mil, Calle 18 # 122-35, Ana 3001234567",
      "Domi para el D1 de la 100, el cliente trabaja ahí, Andrés 3105550101, ya está",
      "¿Cuánto vale un domi al Ara de Ciudad Jardín?",
      "Domi a la droguería de la 5, entregar a Camila 3001112233, en 10",
      "Reenviado: Hola quiero comprar 2 combos para la Cra 85 # 15-40, soy Mario 3014445566",
      "El cliente compró 3 pizzas, cobrar 85 mil, Bosques del Lili torre 2 apto 301",
      "lleve datáfono, paga con tarjeta, Cra 100 # 11-60, Pedro 3157778899",
      "llevar cambio de 50 mil, Calle 13 # 100-20, Rosa 3001239876, listo en 15",
      "Domi a la galería Alameda puesto 23, Don Jorge 3156667788, ya está",
      "Gracias por la compra",
      "el cliente paga cuando le llegue",
      "por favor que sea rápido, la comida está caliente",
      "hola buenas noches, un domi por favor",
      "dale, mándalo",
    ]) {
      assert.equal(looksLikeErrand(text), false, text);
    }
  });

  it("pedir que le traigan su plata, su datáfono o papeles del pedido no es un encargo", () => {
    for (const text of [
      "¿A qué hora me traen la plata?",
      "necesito el datáfono que se llevó el domi",
      "me traes la factura firmada cuando entregues porfa",
      "me traen los 50 mil del pedido de ayer",
      "si el cliente no contesta me traes el pedido",
      "nos traen el datáfono antes de cerrar",
      "me traes el cambio porfa",
    ]) {
      assert.equal(looksLikeErrand(text), false, text);
    }
  });

  it("sin texto, no", () => {
    assert.equal(looksLikeErrand(""), false);
    assert.equal(looksLikeErrand("   "), false);
    assert.equal(looksLikeErrand(null), false);
  });
});

describe("errandReason", () => {
  it("el motivo lleva lo que pidió el restaurante, en una línea y recortado", () => {
    assert.equal(errandReason("me compran\n un queso   tajado"), "Encargo: «me compran un queso tajado»");
    const long = errandReason("a".repeat(500));
    assert.ok(long.length < 220);
    assert.ok(long.endsWith("…»"));
    assert.equal(errandReason("  "), `${ERRAND_REASON_PREFIX} pidió comprar o traer algo (ver el chat)`);
  });

  it("se reconoce por su prefijo", () => {
    assert.equal(isErrandReason(errandReason("me traes 30 envases")), true);
    assert.equal(isErrandReason("El restaurante dio datos confusos o pidió hablar con una persona."), false);
    assert.equal(isErrandReason(null), false);
  });
});
