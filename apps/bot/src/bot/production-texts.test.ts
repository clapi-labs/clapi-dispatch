import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/**
 * Con el simulador apagado (producción), ningún mensaje del bot puede hablar
 * del simulador, de números de prueba ni de staging (#121). Dos capas:
 *
 * 1. **Los textos del código.** Se leen todos los textos (literales y
 *    plantillas, no comentarios) de lo que el bot le escribe a la gente. Los que
 *    nombran el simulador solo pueden estar en `courier.ts`, en las ramas de
 *    `testNumber`, que solo existen con `SIMULATOR_ENABLED`.
 * 2. **La red de seguridad en `say`**: aunque un texto así se colara, con el
 *    simulador apagado no sale por WhatsApp.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
/** Lo que le escribe a restaurantes y domiciliarios: el bot, sus servicios y los textos compartidos. */
const SCANNED = ["apps/bot/src/bot", "apps/bot/src/services", "packages/shared/src/domain"];
const TEST_ONLY = /🧪|simulad[oa]r?|n[uú]meros? de prueba|staging/i;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Cada texto del archivo, con su línea. */
function texts(path: string): { line: number; text: string }[] {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
    }
    // Los imports y los nombres de módulos no son mensajes.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("textos de pruebas en producción (#121)", () => {
  it("los únicos textos que nombran el simulador están en las ramas de número de prueba de courier.ts", () => {
    const offenders: string[] = [];
    for (const dir of SCANNED) {
      for (const path of sources(join(ROOT, dir))) {
        const lines = readFileSync(path, "utf8").split("\n");
        for (const { line, text } of texts(path)) {
          if (!TEST_ONLY.test(text)) continue;
          const file = relative(ROOT, path);
          // Las ramas del simulador en courier.ts se deciden con `testNumber`, que
          // solo es verdadero con SIMULATOR_ENABLED (la línea del texto o la de antes).
          const guarded = file === "apps/bot/src/bot/courier.ts" && /\btestNumber\b/.test(`${lines[line - 2] ?? ""}\n${lines[line - 1]}`);
          if (!guarded) offenders.push(`${file}:${line} «${text.slice(0, 60)}»`);
        }
      }
    }
    assert.deepEqual(offenders, [], "un texto de pruebas fuera de una rama del simulador");
  });

  it("courier.ts decide `testNumber` con simulatorEnabled()", () => {
    const source = readFileSync(join(ROOT, "apps/bot/src/bot/courier.ts"), "utf8");
    assert.match(source, /const testNumber = simulatorEnabled\(\) && /);
  });
});

describe("say: la red de seguridad", () => {
  const sent: string[] = [];
  const recorded: string[] = [];
  let messaging: typeof import("./messaging");

  before(async () => {
    delete process.env.SIMULATOR_ENABLED;
    const whatsapp = await import("@/services/whatsapp/client");
    const ok = async (_phone: string, text: string) => {
      sent.push(text);
      return { ok: true as const, messageId: "wamid.x" };
    };
    mock.module("@/services/whatsapp/client", { namedExports: { ...whatsapp, sendText: ok, sendButtons: ok, sendList: ok } });
    mock.module("@/db/queries/conversation", {
      namedExports: {
        recordMessage: async (_id: number, _role: string, text: string) => {
          recorded.push(text);
          return 1;
        },
      },
    });
    messaging = await import("./messaging");
  });

  after(() => {
    mock.reset();
    delete process.env.SIMULATOR_ENABLED;
  });

  it("con el simulador apagado, un texto de pruebas no sale y queda anotado en el portal", async () => {
    sent.length = recorded.length = 0;
    const result = await messaging.say(1, "573000000000", "🧪 Estás libre como número de prueba");
    assert.equal(result.ok, false);
    assert.deepEqual(sent, []);
    assert.match(recorded[0], /No se envió: es un texto de pruebas/);
  });

  it("con el simulador encendido sí sale (staging)", async () => {
    sent.length = recorded.length = 0;
    process.env.SIMULATOR_ENABLED = "1";
    const result = await messaging.say(1, "573000000000", "🧪 Estás libre como número de prueba");
    delete process.env.SIMULATOR_ENABLED;
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
  });

  it("un texto normal sale igual con el simulador apagado", async () => {
    sent.length = recorded.length = 0;
    const result = await messaging.say(1, "573000000000", "👋 Pedro, quedaste conectado.");
    assert.equal(result.ok, true);
    assert.deepEqual(sent, ["👋 Pedro, quedaste conectado."]);
  });

  it("el saludo del día va solo en el primer mensaje del turno", async () => {
    sent.length = recorded.length = 0;
    await messaging.inGreetingTurn(1, "¡Buenas tardes!", async () => {
      assert.equal(messaging.greetingPending(1), true);
      await messaging.say(1, "573000000000", "Uno");
      await messaging.say(1, "573000000000", "Dos");
      assert.equal(messaging.greetingPending(1), false);
    });
    assert.deepEqual(sent, ["¡Buenas tardes!\n\nUno", "Dos"]);
  });

  it("el saludo no se pega a mensajes de otra conversación", async () => {
    sent.length = recorded.length = 0;
    await messaging.inGreetingTurn(1, "¡Buenas tardes!", async () => {
      await messaging.say(2, "573000000001", "Para otro chat");
      await messaging.say(1, "573000000000", "Para este");
    });
    assert.deepEqual(sent, ["Para otro chat", "¡Buenas tardes!\n\nPara este"]);
  });

  it("si con el saludo no cabe en un mensaje con botones, se queda para el siguiente", async () => {
    sent.length = recorded.length = 0;
    const long = "x".repeat(1020);
    await messaging.inGreetingTurn(1, "¡Buenas tardes!", async () => {
      await messaging.say(1, "573000000000", long, { buttons: [{ id: "a", title: "A" }] });
      await messaging.say(1, "573000000000", "Corto");
    });
    assert.deepEqual(sent, [long, "¡Buenas tardes!\n\nCorto"]);
  });
});
