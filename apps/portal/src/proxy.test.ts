import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import { createUser, forgetSessions, installMocks, openSession, resetMocks, restoreMocks, SESSION_SECRET } from "@/test-support/portal-env";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * `proxy.ts`: la puerta del portal. Las rutas de la API no se protegen a sí
 * mismas (salvo las que piden la sesión para saber quién es): lo que hace que
 * `/api/trips` o `/api/couriers` contesten 401 sin sesión es este archivo. Por
 * eso aquí se descubren TODAS las rutas y páginas del proyecto desde el disco y
 * se comprueba cada una: una ruta nueva que quedara fuera de la protección
 * rompería esta prueba. El `matcher` se evalúa como lo hace Next (expresión
 * regular de `path-to-regexp`). Sin `TEST_DATABASE_URL` se salta.
 */

type Proxy = typeof import("./proxy");
let mod: Proxy;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  mod = await import("./proxy");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
});

const SRC = path.resolve(process.cwd(), "apps/portal/src/app");

/** Las rutas de la API y las páginas, tal como se piden (`[id]` → 1). */
function discover(dir: string, file: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(SRC, dir), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name !== file) continue;
    const relative = path.relative(path.join(SRC, dir), entry.parentPath).split(path.sep);
    // `(dashboard)` es un grupo de rutas: no forma parte de la dirección.
    const segments = relative.filter((s) => s && !/^\(.*\)$/.test(s)).map((s) => s.replace(/^\[.+\]$/, "1"));
    found.push(`${dir === "api" ? "/api" : ""}/${segments.join("/")}`.replace(/\/$/, "") || "/");
  }
  return found.sort();
}
const API_ROUTES = discover("api", "route.ts");
const PAGES = discover(".", "page.tsx");

/** ¿El `matcher` de Next deja pasar esta dirección por el proxy? (sintaxis de path-to-regexp con una expresión regular) */
const proxied = (pathname: string) => mod.config.matcher.some((m) => new RegExp(`^${m}$`).test(pathname));

const call = (pathname: string, opts: { cookie?: string; method?: string; search?: string } = {}) =>
  mod.proxy(
    new NextRequest(`http://portal.test${pathname}${opts.search ?? ""}`, {
      method: opts.method ?? "GET",
      headers: opts.cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${opts.cookie}` },
    }),
  );

const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";
/** Lo que se queda fuera del proxy a propósito: el login, su API y lo que el celular pide sin cookie para instalar el portal. */
const PUBLIC = (p: string) => p === "/login" || p.startsWith("/api/auth/");

describe("proxy.ts: protección de las rutas (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  describe("qué rutas y páginas existen (para que la comprobación no se quede mirando nada)", () => {
    it("se descubren las rutas de la API y las páginas del proyecto", () => {
      assert.ok(API_ROUTES.length >= 25, `solo se vieron ${API_ROUTES.length} rutas de API`);
      for (const known of ["/api/trips", "/api/trips/1/assign", "/api/trips/1/deliver", "/api/couriers", "/api/couriers/1/gps", "/api/settlement", "/api/sessions/1", "/api/pendientes", "/api/zonas", "/api/fares/ranges", "/api/conversations/1", "/api/auth/login"]) {
        assert.ok(API_ROUTES.includes(known), `falta ${known}`);
      }
      assert.ok(PAGES.length >= 8, `solo se vieron ${PAGES.length} páginas`);
      for (const known of ["/viajes", "/flota", "/arqueo", "/conversaciones", "/pendientes", "/tarifas", "/zonas", "/login"]) {
        assert.ok(PAGES.includes(known), `falta la página ${known}`);
      }
    });
  });

  describe("el matcher", () => {
    it("deja fuera solo el login, su API (/api/auth) y lo que el celular pide sin cookie para instalar el portal", () => {
      for (const open of ["/login", "/api/auth/login", "/api/auth/logout", "/api/auth/session", "/_next/static/chunk.js", "/_next/image", "/favicon.ico", "/manifest.webmanifest", "/sw.js", "/icons/icon-192.png"]) {
        assert.equal(proxied(open), false, `${open} no debería pasar por el proxy`);
      }
    });

    it("y deja dentro todo lo demás: ninguna ruta de la API ni página queda fuera de la protección por descuido", () => {
      const unprotected = [...API_ROUTES, ...PAGES].filter((p) => !proxied(p));
      const unexpected = unprotected.filter((p) => !PUBLIC(p));
      assert.deepEqual(unexpected, [], `quedan fuera del proxy sin ser públicas: ${unexpected.join(", ")}`);
      // Y lo público es justo lo esperado, ni más ni menos.
      assert.deepEqual(unprotected.filter(PUBLIC).sort(), [...API_ROUTES, ...PAGES].filter(PUBLIC).sort());
    });

    it("la lista de lo público es corta y conocida (si crece, que sea a propósito)", () => {
      assert.deepEqual([...API_ROUTES, ...PAGES].filter(PUBLIC).sort(), ["/api/auth/login", "/api/auth/logout", "/api/auth/session", "/login"]);
    });
  });

  describe("sin sesión válida: 401 en la API y redirección en las páginas", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      it(`${method}: todas las rutas de la API protegidas contestan 401 «No autenticado»`, async () => {
        const protectedRoutes = API_ROUTES.filter((p) => !PUBLIC(p));
        assert.ok(protectedRoutes.length >= 25);
        for (const route of protectedRoutes) {
          const res = await call(route, { method });
          assert.equal(res.status, 401, `${method} ${route}`);
          assert.deepEqual(await res.json(), { error: "No autenticado" }, `${method} ${route}`);
        }
      });
    }

    it("con una cookie basura, firmada con otro secreto, vencida o de una sesión cerrada: también 401", async () => {
      const user = await createUser();
      const valid = await openSession(user.id);
      const closed = await openSession(user.id);
      await db.delete(schema.portalSessions).where(eq(schema.portalSessions.id, closed.sessionId));
      forgetSessions();
      const { createSessionToken } = await import("@/lib/session");
      const expired = createSessionToken(user.id, valid.sessionId, Math.floor(Date.now() / 1000) - 5);
      process.env.SESSION_SECRET = "otro-secreto-distinto-de-al-menos-32-caracteres!";
      const foreign = createSessionToken(user.id, valid.sessionId, Math.floor(Date.now() / 1000) + 3600);
      process.env.SESSION_SECRET = SESSION_SECRET;
      for (const cookie of ["basura", "a.b", "", expired, foreign, closed.token]) {
        const res = await call("/api/trips", { cookie });
        assert.equal(res.status, 401, `cookie «${cookie.slice(0, 20)}»`);
      }
    });

    it("las páginas redirigen a /login (y guardan a dónde ir con ?next=, salvo en la portada)", async () => {
      for (const page of PAGES.filter((p) => !PUBLIC(p))) {
        const res = await call(page);
        assert.equal(res.status, 307, page);
        const target = new URL(res.headers.get("location")!);
        assert.equal(target.pathname, "/login", page);
        assert.equal(target.searchParams.get("next"), page === "/" ? null : page, page);
      }
    });

    it("conserva la búsqueda de la dirección a la que iba", async () => {
      const res = await call("/viajes", { search: "?filtro=hoy&q=a%20b" });
      assert.equal(new URL(res.headers.get("location")!).searchParams.get("next"), "/viajes?filtro=hoy&q=a%20b");
    });
  });

  describe("con sesión válida", () => {
    it("deja pasar todas las rutas y páginas protegidas", async () => {
      const user = await createUser();
      const session = await openSession(user.id);
      for (const route of [...API_ROUTES, ...PAGES].filter((p) => !PUBLIC(p))) {
        const res = await call(route, { cookie: session.token });
        assert.ok(passes(res), `${route} debería pasar con sesión`);
      }
    });

    it("la sesión cerrada desde otro equipo deja de servir en el acto", async () => {
      const user = await createUser();
      const session = await openSession(user.id);
      assert.ok(passes(await call("/api/trips", { cookie: session.token })));
      const { closeSession } = await import("@/lib/auth");
      await closeSession(session.sessionId);
      assert.equal((await call("/api/trips", { cookie: session.token })).status, 401);
    });

    it("un usuario desactivado ya no pasa", async () => {
      const user = await createUser();
      const session = await openSession(user.id);
      await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, user.id));
      forgetSessions();
      assert.equal((await call("/api/trips", { cookie: session.token })).status, 401);
    });
  });

  describe("AUTH_DISABLED (solo para desarrollo)", () => {
    it("con AUTH_DISABLED=1 entra todo sin sesión", async () => {
      process.env.AUTH_DISABLED = "1";
      for (const route of ["/api/trips", "/api/couriers", "/viajes", "/"]) assert.ok(passes(await call(route)), route);
    });

    it("el simulador sigue pidiendo sesión aunque el login esté apagado (desde ahí se crean pedidos y se reinicia lo simulado)", async () => {
      process.env.AUTH_DISABLED = "1";
      assert.equal((await call("/api/simulador", { method: "POST" })).status, 401);
      assert.equal((await call("/simulador")).status, 307);
      assert.equal((await call("/simulador/mapa")).status, 307);
      const user = await createUser();
      const session = await openSession(user.id);
      assert.ok(passes(await call("/api/simulador", { cookie: session.token })));
    });

    it("solo el valor exacto «1» lo enciende: «true», «0» o vacío no", async () => {
      for (const value of ["true", "0", "", "yes", " 1"]) {
        process.env.AUTH_DISABLED = value;
        assert.equal((await call("/api/trips")).status, 401, `AUTH_DISABLED=${JSON.stringify(value)}`);
      }
    });

    it("sin la variable, el portal exige sesión", async () => {
      delete process.env.AUTH_DISABLED;
      assert.equal((await call("/api/trips")).status, 401);
    });
  });
});
