import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { eq } from "drizzle-orm";

import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  browser,
  createUser,
  followCookies,
  forgetSessions,
  installMocks,
  openSession,
  params,
  PASSWORD,
  request,
  resetMocks,
  restoreMocks,
  sessionCount,
  sessionRow,
  setCookieOf,
  signedIn,
} from "@/test-support/portal-env";

/**
 * Sesiones del portal: login, logout, la sesión instalada, la lista de
 * sesiones abiertas y cerrarlas a distancia. Las rutas se llaman tal cual,
 * contra la base de pruebas; el «navegador» (`browser`) guarda la cookie que
 * la respuesta le pide guardar. Sin `TEST_DATABASE_URL` se salta.
 */

type Login = typeof import("./login/route");
type Logout = typeof import("./logout/route");
type Session = typeof import("./session/route");
type Sessions = typeof import("../sessions/route");
type SessionById = typeof import("../sessions/[id]/route");
type Auth = typeof import("@/lib/auth");
type Tokens = typeof import("@/lib/session");
let login: Login;
let logout: Logout;
let session: Session;
let sessions: Sessions;
let sessionById: SessionById;
let auth: Auth;
let tokens: Tokens;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  login = await import("./login/route");
  logout = await import("./logout/route");
  session = await import("./session/route");
  sessions = await import("../sessions/route");
  sessionById = await import("../sessions/[id]/route");
  auth = await import("@/lib/auth");
  tokens = await import("@/lib/session");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
});

let ipSeq = 0;
/** Cada prueba entra desde su propia IP: el límite de intentos se recuerda en memoria durante todo el archivo. */
const freshIp = () => `10.1.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
const attempt = (body: unknown, ip = freshIp(), headers: Record<string, string> = {}) =>
  login.POST(request("POST", "/api/auth/login", { body, headers: { "x-forwarded-for": ip, ...headers } }));

describe("autenticación y sesiones del portal (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  describe("POST /api/auth/login", () => {
    it("con credenciales válidas: 200, abre una sesión en la base y deja la cookie firmada", async () => {
      const user = await createUser({ email: "ana@clapi.test", name: "Ana Central" });
      const res = await attempt({ email: "ana@clapi.test", password: PASSWORD });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, name: "Ana Central" });

      const cookie = setCookieOf(res)!;
      assert.ok(cookie.value.includes("."), "payload.firma");
      assert.deepEqual([cookie.httpOnly, cookie.sameSite, cookie.path, cookie.secure], [true, "lax", "/", false]);
      assert.equal(cookie.maxAge, 12 * 60 * 60, "12 horas en el navegador");

      const token = tokens.verifySessionToken(cookie.value)!;
      assert.equal(token.userId, user.id);
      const row = await sessionRow(token.sessionId);
      assert.deepEqual([row.userId, row.installed], [user.id, false]);
      assert.equal(row.expiresAt.getTime(), token.expiresAt * 1000, "la cookie y la base vencen a la misma hora");
      assert.ok(Math.abs(row.expiresAt.getTime() - (Date.now() + 12 * 3600_000)) < 5_000);
    });

    it("en producción la cookie es Secure", async () => {
      await createUser({ email: "ana@clapi.test" });
      const env = process.env as Record<string, string | undefined>;
      const before = env.NODE_ENV;
      env.NODE_ENV = "production";
      try {
        const res = await attempt({ email: "ana@clapi.test", password: PASSWORD });
        assert.equal(setCookieOf(res)!.secure, true);
      } finally {
        env.NODE_ENV = before;
      }
    });

    it("el portal instalado en el celular: la sesión dura 30 días y queda marcada con el dispositivo", async () => {
      await createUser({ email: "ana@clapi.test" });
      const res = await attempt(
        { email: "ana@clapi.test", password: PASSWORD, installed: true },
        freshIp(),
        { "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36" },
      );
      const cookie = setCookieOf(res)!;
      assert.equal(cookie.maxAge, 30 * 24 * 60 * 60);
      const row = await sessionRow(tokens.verifySessionToken(cookie.value)!.sessionId);
      assert.equal(row.installed, true);
      assert.match(row.device, /Android/);
      assert.ok(Math.abs(row.expiresAt.getTime() - (Date.now() + 30 * 24 * 3600_000)) < 5_000);
    });

    it("«installed» solo cuenta si es exactamente true", async () => {
      await createUser({ email: "ana@clapi.test" });
      for (const installed of ["true", 1, "yes", null]) {
        const res = await attempt({ email: "ana@clapi.test", password: PASSWORD, installed });
        assert.equal(setCookieOf(res)!.maxAge, 12 * 3600, String(installed));
      }
    });

    it("el correo se compara sin espacios ni mayúsculas", async () => {
      await createUser({ email: "ana@clapi.test" });
      const res = await attempt({ email: "  ANA@Clapi.Test ", password: PASSWORD });
      assert.equal(res.status, 200);
    });

    it("la contraseña equivocada: 401 con el mismo mensaje y sin abrir ninguna sesión", async () => {
      await createUser({ email: "ana@clapi.test" });
      const res = await attempt({ email: "ana@clapi.test", password: "otra-clave" });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "Usuario o contraseña incorrectos" });
      assert.equal(setCookieOf(res), null, "no deja cookie");
      assert.equal(await sessionCount(), 0);
    });

    it("un correo que no existe da exactamente la misma respuesta (no revela quién tiene cuenta)", async () => {
      await createUser({ email: "ana@clapi.test" });
      const wrongPassword = await attempt({ email: "ana@clapi.test", password: "otra-clave" });
      const unknown = await attempt({ email: "nadie@clapi.test", password: PASSWORD });
      assert.equal(unknown.status, wrongPassword.status);
      assert.deepEqual(await unknown.json(), await wrongPassword.json());
    });

    it("un usuario desactivado no entra aunque la clave sea la correcta", async () => {
      await createUser({ email: "ana@clapi.test", active: false });
      const res = await attempt({ email: "ana@clapi.test", password: PASSWORD });
      assert.equal(res.status, 401);
      assert.equal(await sessionCount(), 0);
    });

    for (const [name, body] of [
      ["sin correo", { password: PASSWORD }],
      ["sin contraseña", { email: "ana@clapi.test" }],
      ["con el correo vacío", { email: "   ", password: PASSWORD }],
      ["con la contraseña vacía", { email: "ana@clapi.test", password: "" }],
      ["con tipos que no son texto", { email: 123, password: { x: 1 } }],
      ["con un cuerpo vacío", {}],
    ] as const) {
      it(`${name}: 400 «Falta usuario o contraseña»`, async () => {
        await createUser({ email: "ana@clapi.test" });
        const res = await attempt(body);
        assert.equal(res.status, 400);
        assert.deepEqual(await res.json(), { error: "Falta usuario o contraseña" });
      });
    }

    it("un cuerpo que no es JSON: 400, no un error del servidor", async () => {
      const res = await login.POST(request("POST", "/api/auth/login", { raw: "esto no es json", headers: { "x-forwarded-for": freshIp() } }));
      assert.equal(res.status, 400);
    });

    it("sin SESSION_SECRET (o más corto de 32 caracteres) no se puede abrir una sesión: falla en vez de firmar con nada", async () => {
      await createUser({ email: "ana@clapi.test" });
      process.env.SESSION_SECRET = "corto";
      await assert.rejects(() => attempt({ email: "ana@clapi.test", password: PASSWORD }), /SESSION_SECRET/);
    });

    describe("límite de intentos (5 fallos por correo e IP, 15 minutos)", () => {
      const bad = (ip: string, email = "ana@clapi.test") => attempt({ email, password: "equivocada" }, ip);

      it("al quinto fallo el siguiente intento ya es 429, aunque la clave sea la correcta", async () => {
        await createUser({ email: "ana@clapi.test" });
        const ip = freshIp();
        for (let i = 0; i < 5; i++) assert.equal((await bad(ip)).status, 401, `intento ${i + 1}`);
        const blocked = await attempt({ email: "ana@clapi.test", password: PASSWORD }, ip);
        assert.equal(blocked.status, 429);
        assert.deepEqual(await blocked.json(), { error: "Demasiados intentos. Prueba de nuevo en 15 minutos." });
        assert.equal(await sessionCount(), 0, "no se abrió ninguna sesión");
      });

      it("con 4 fallos todavía deja entrar", async () => {
        await createUser({ email: "ana@clapi.test" });
        const ip = freshIp();
        for (let i = 0; i < 4; i++) await bad(ip);
        assert.equal((await attempt({ email: "ana@clapi.test", password: PASSWORD }, ip)).status, 200);
      });

      it("un acierto borra los fallos: se vuelve a tener la cuota completa", async () => {
        await createUser({ email: "ana@clapi.test" });
        const ip = freshIp();
        for (let i = 0; i < 4; i++) await bad(ip);
        await attempt({ email: "ana@clapi.test", password: PASSWORD }, ip);
        for (let i = 0; i < 4; i++) assert.equal((await bad(ip)).status, 401);
        assert.equal((await attempt({ email: "ana@clapi.test", password: PASSWORD }, ip)).status, 200);
      });

      it("el bloqueo es por correo e IP: otra IP o otro correo no se ven afectados", async () => {
        await createUser({ email: "ana@clapi.test" });
        await createUser({ email: "luis@clapi.test" });
        const ip = freshIp();
        for (let i = 0; i < 5; i++) await bad(ip);
        assert.equal((await bad(ip)).status, 429);
        assert.equal((await bad(freshIp())).status, 401, "otra IP");
        assert.equal((await bad(ip, "luis@clapi.test")).status, 401, "otro correo");
      });

      it("el correo cuenta sin importar mayúsculas ni espacios: no se evade el límite escribiéndolo distinto", async () => {
        await createUser({ email: "ana@clapi.test" });
        const ip = freshIp();
        for (const variant of ["ana@clapi.test", "ANA@clapi.test", " ana@clapi.test", "Ana@Clapi.test", "ana@clapi.test "]) await bad(ip, variant);
        assert.equal((await bad(ip)).status, 429);
      });

      it("también bloquea un correo que no existe (no sirve para adivinar cuentas)", async () => {
        const ip = freshIp();
        for (let i = 0; i < 5; i++) assert.equal((await bad(ip, "nadie@clapi.test")).status, 401);
        assert.equal((await bad(ip, "nadie@clapi.test")).status, 429);
      });

      it("la IP es la primera de X-Forwarded-For", async () => {
        await createUser({ email: "ana@clapi.test" });
        const ip = freshIp();
        for (let i = 0; i < 5; i++) await attempt({ email: "ana@clapi.test", password: "x" }, `${ip}, 172.16.0.9`);
        assert.equal((await attempt({ email: "ana@clapi.test", password: "x" }, `${ip}, 172.16.0.77`)).status, 429, "mismo cliente detrás de otro proxy");
        assert.equal((await attempt({ email: "ana@clapi.test", password: "x" }, `${freshIp()}, 172.16.0.9`)).status, 401, "otro cliente tras el mismo proxy");
      });

      it("sin X-Forwarded-For todos comparten la clave «local»", async () => {
        const post = () => login.POST(request("POST", "/api/auth/login", { body: { email: "sinip@clapi.test", password: "x" } }));
        for (let i = 0; i < 5; i++) assert.equal((await post()).status, 401);
        assert.equal((await post()).status, 429);
      });

      it("pasados 15 minutos se vuelve a poder intentar", async () => {
        await createUser({ email: "ana@clapi.test" });
        const ip = freshIp();
        for (let i = 0; i < 5; i++) await bad(ip);
        assert.equal((await bad(ip)).status, 429);
        const real = Date.now;
        const clock = mock.method(Date, "now", () => real() + 15 * 60_000 + 1_000);
        try {
          assert.equal((await attempt({ email: "ana@clapi.test", password: PASSWORD }, ip)).status, 200);
        } finally {
          clock.mock.restore();
        }
      });

      it("a los 14 minutos sigue bloqueado", async () => {
        await createUser({ email: "ana@clapi.test" });
        const ip = freshIp();
        for (let i = 0; i < 5; i++) await bad(ip);
        const real = Date.now;
        const clock = mock.method(Date, "now", () => real() + 14 * 60_000);
        try {
          assert.equal((await bad(ip)).status, 429);
        } finally {
          clock.mock.restore();
        }
      });
    });
  });

  describe("la cookie de sesión (firma, vencimiento y lo que dice la base)", () => {
    it("una cookie manipulada o con otra firma no sirve", async () => {
      const { session } = await signedIn();
      const [body, signature] = session.token.split(".");
      assert.equal(await auth.getSession(session.token) !== null, true);
      assert.equal(await auth.getSession(`${body}.${signature.slice(0, -2)}xx`), null, "firma cambiada");
      const forged = Buffer.from(JSON.stringify({ u: 999, s: session.sessionId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
      assert.equal(await auth.getSession(`${forged}.${signature}`), null, "payload cambiado con la firma de otro");
      assert.equal(await auth.getSession(body), null, "sin firma");
      assert.equal(await auth.getSession(`${body}.`), null);
      assert.equal(await auth.getSession(undefined), null);
      assert.equal(await auth.getSession(""), null);
      assert.equal(await auth.getSession("basura"), null);
    });

    it("firmada con otro secreto: no sirve (cambiar SESSION_SECRET cierra todas)", async () => {
      const { session } = await signedIn();
      process.env.SESSION_SECRET = "otro-secreto-distinto-de-al-menos-32-caracteres!";
      forgetSessions();
      assert.equal(await auth.getSession(session.token), null);
    });

    it("con un SESSION_SECRET corto o ausente ninguna cookie sirve (falla cerrado)", async () => {
      const { session } = await signedIn();
      process.env.SESSION_SECRET = "corto";
      assert.equal(await auth.getSession(session.token), null);
      delete process.env.SESSION_SECRET;
      assert.equal(await auth.getSession(session.token), null);
    });

    it("una cookie vencida (su propia fecha) no sirve", async () => {
      const user = await createUser();
      const [row] = await db.insert(schema.portalSessions).values({ userId: user.id, expiresAt: new Date(Date.now() + 3600_000) }).returning();
      const expired = tokens.createSessionToken(user.id, row.id, Math.floor(Date.now() / 1000) - 10);
      assert.equal(await auth.getSession(expired), null);
    });

    it("una cookie de antes de las sesiones en la base (sin sesión) no sirve", async () => {
      const user = await createUser();
      const body = Buffer.from(JSON.stringify({ u: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
      const { createHmac } = await import("node:crypto");
      const signature = createHmac("sha256", process.env.SESSION_SECRET!).update(body).digest("base64url");
      assert.equal(await auth.getSession(`${body}.${signature}`), null);
    });

    it("si la sesión venció en la base aunque la cookie diga que no, no sirve", async () => {
      const { session } = await signedIn();
      await db.update(schema.portalSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.portalSessions.id, session.sessionId));
      forgetSessions();
      assert.equal(await auth.getSession(session.token), null);
    });

    it("si borran la fila de la sesión, no sirve", async () => {
      const { session } = await signedIn();
      await db.delete(schema.portalSessions).where(eq(schema.portalSessions.id, session.sessionId));
      forgetSessions();
      assert.equal(await auth.getSession(session.token), null);
    });

    it("si desactivan al usuario, sus sesiones dejan de servir", async () => {
      const { user, session } = await signedIn();
      assert.ok(await auth.getSession(session.token));
      await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, user.id));
      forgetSessions();
      assert.equal(await auth.getSession(session.token), null);
    });

    it("una cookie con el usuario de otra persona no sirve aunque la sesión exista", async () => {
      const { session } = await signedIn();
      const other = await createUser();
      const swapped = tokens.createSessionToken(other.id, session.sessionId, Math.floor(Date.now() / 1000) + 3600);
      assert.equal(await auth.getSession(swapped), null);
    });

    it("lo que se revisó hace menos de 15 s se da por bueno: una sesión cerrada en otro equipo deja de servir a más tardar a los 15 s", async () => {
      const { session } = await signedIn();
      assert.ok(await auth.getSession(session.token)); // queda recordada
      await db.delete(schema.portalSessions).where(eq(schema.portalSessions.id, session.sessionId));
      assert.ok(await auth.getSession(session.token), "dentro de la ventana todavía se acepta");
      const real = Date.now;
      const clock = mock.method(Date, "now", () => real() + 16_000);
      try {
        assert.equal(await auth.getSession(session.token), null, "pasada la ventana se vuelve a mirar la base");
      } finally {
        clock.mock.restore();
      }
    });

    it("«visto por última vez» se actualiza como mucho cada 5 minutos", async () => {
      const { session } = await signedIn();
      const long = new Date(Date.now() - 10 * 60_000);
      await db.update(schema.portalSessions).set({ lastSeenAt: long }).where(eq(schema.portalSessions.id, session.sessionId));
      forgetSessions();
      await auth.getSession(session.token);
      const touched = (await sessionRow(session.sessionId)).lastSeenAt;
      assert.ok(touched.getTime() > long.getTime() + 9 * 60_000, "se actualizó");
      forgetSessions();
      await auth.getSession(session.token);
      assert.equal((await sessionRow(session.sessionId)).lastSeenAt.getTime(), touched.getTime(), "dentro de los 5 minutos no se vuelve a escribir");
    });
  });

  describe("POST /api/auth/logout", () => {
    it("cierra la sesión de este equipo: se borra de la base, se borra la cookie y deja de servir", async () => {
      const { session } = await signedIn();
      const res = await logout.POST();
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      const cookie = setCookieOf(res)!;
      assert.deepEqual([cookie.value, cookie.maxAge, cookie.httpOnly], ["", 0, true]);
      assert.equal(await sessionRow(session.sessionId), undefined);
      assert.equal(await auth.getSession(session.token), null, "ni siquiera dentro de los 15 s de memoria");
    });

    it("sin sesión también responde 200 y borra la cookie (cerrar dos veces no falla)", async () => {
      const res = await logout.POST();
      assert.equal(res.status, 200);
      assert.equal(setCookieOf(res)!.maxAge, 0);
    });

    it("solo cierra la sesión de este equipo: las demás del mismo usuario siguen", async () => {
      const { user, session } = await signedIn();
      const phone = await openSession(user.id, true);
      await logout.POST();
      assert.equal(await sessionRow(session.sessionId), undefined);
      assert.ok(await sessionRow(phone.sessionId));
      assert.ok(await auth.getSession(phone.token));
    });

    it("al cerrar la sesión se borran las alertas de ese celular (suscripciones push)", async () => {
      const { session } = await signedIn();
      await db.insert(schema.pushSubscriptions).values({ sessionId: session.sessionId, endpoint: "https://push.test/a", p256dh: "k", auth: "a", origin: "https://portal.test" });
      await logout.POST();
      assert.equal((await db.select().from(schema.pushSubscriptions)).length, 0);
    });
  });

  describe("POST /api/auth/session (el portal se abrió instalado)", () => {
    const call = (body: unknown, headers: Record<string, string> = {}) => session.POST(request("POST", "/api/auth/session", { body, headers }));

    it("sin sesión: 401", async () => {
      const res = await call({ installed: true });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "No autenticado" });
    });

    it("una sesión de navegador pasa a durar 30 días, una sola vez, con la cookie nueva", async () => {
      const { session: opened } = await signedIn();
      const res = await call({ installed: true }, { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" });
      assert.deepEqual(await res.json(), { ok: true, changed: true });
      const cookie = followCookies(res)!;
      assert.equal(cookie.maxAge, 30 * 24 * 3600);
      const row = await sessionRow(opened.sessionId);
      assert.equal(row.installed, true);
      assert.match(row.device, /iPhone/);
      assert.ok(Math.abs(row.expiresAt.getTime() - (Date.now() + 30 * 24 * 3600_000)) < 5_000);
      assert.equal(tokens.verifySessionToken(cookie.value)!.expiresAt * 1000, row.expiresAt.getTime());
      assert.ok(await auth.getSession(cookie.value), "la cookie nueva sirve");

      const again = await call({ installed: true });
      assert.deepEqual(await again.json(), { ok: true, changed: false });
      assert.equal(setCookieOf(again), null, "los 30 días se cuentan desde que se instaló, no desde cada apertura");
    });

    it("sin installed: true no cambia nada", async () => {
      const { session: opened } = await signedIn();
      const before = (await sessionRow(opened.sessionId)).expiresAt.getTime();
      for (const body of [{}, { installed: false }, { installed: "true" }]) {
        const res = await call(body);
        assert.deepEqual(await res.json(), { ok: true, changed: false });
        assert.equal(setCookieOf(res), null);
      }
      assert.equal((await sessionRow(opened.sessionId)).expiresAt.getTime(), before);
    });

    it("una sesión que ya era instalada no se vuelve a extender", async () => {
      await signedIn({}, true);
      const res = await call({ installed: true });
      assert.deepEqual(await res.json(), { ok: true, changed: false });
    });

    it("un cuerpo que no es JSON se trata como vacío", async () => {
      await signedIn();
      const res = await session.POST(request("POST", "/api/auth/session", { raw: "no es json" }));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, changed: false });
    });
  });

  describe("GET /api/sessions (las sesiones abiertas)", () => {
    it("sin sesión: 401", async () => {
      const res = await sessions.GET();
      assert.equal(res.status, 401);
    });

    it("lista las abiertas de todos los usuarios, la más reciente primero, y dice cuál es la de este equipo", async () => {
      const { user, session: mine } = await signedIn({ name: "Ana Central" });
      const luis = await createUser({ name: "Luis Central" });
      const phone = await openSession(luis.id, true, "Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile");
      await db.update(schema.portalSessions).set({ lastSeenAt: new Date(Date.now() + 60_000) }).where(eq(schema.portalSessions.id, phone.sessionId));
      const res = await sessions.GET();
      const body = (await res.json()) as { current: number; sessions: { id: number; userName: string; device: string; installed: boolean; alerts: boolean }[] };
      assert.equal(body.current, mine.sessionId);
      assert.deepEqual(body.sessions.map((s) => s.id), [phone.sessionId, mine.sessionId], "la vista más reciente primero");
      assert.deepEqual(body.sessions.map((s) => s.userName), ["Luis Central", user.name]);
      assert.equal(body.sessions[0].installed, true);
      assert.match(body.sessions[0].device, /Android/);
      assert.ok(body.sessions.every((s) => !("passwordHash" in s) && !("token" in s)), "no expone secretos");
    });

    it("marca cuáles tienen las alertas activadas", async () => {
      const { user, session: mine } = await signedIn();
      const other = await openSession(user.id, true);
      await db.insert(schema.pushSubscriptions).values({ sessionId: other.sessionId, endpoint: "https://push.test/b", p256dh: "k", auth: "a", origin: "https://portal.test" });
      const body = (await (await sessions.GET()).json()) as { sessions: { id: number; alerts: boolean }[] };
      assert.equal(body.sessions.find((s) => s.id === other.sessionId)?.alerts, true);
      assert.equal(body.sessions.find((s) => s.id === mine.sessionId)?.alerts, false);
    });

    it("no lista las vencidas ni las de usuarios desactivados", async () => {
      const { user, session: mine } = await signedIn();
      const expired = await openSession(user.id);
      await db.update(schema.portalSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.portalSessions.id, expired.sessionId));
      const gone = await createUser({ active: false });
      await openSession(gone.id);
      const body = (await (await sessions.GET()).json()) as { sessions: { id: number }[] };
      assert.deepEqual(body.sessions.map((s) => s.id), [mine.sessionId]);
    });
  });

  describe("DELETE /api/sessions/:id (cerrar a distancia)", () => {
    const close = (id: string | number) => sessionById.DELETE(request("DELETE", `/api/sessions/${id}`), params({ id }));

    it("sin sesión: 401 y no cierra nada", async () => {
      const user = await createUser();
      const other = await openSession(user.id);
      const res = await close(other.sessionId);
      assert.equal(res.status, 401);
      assert.ok(await sessionRow(other.sessionId));
    });

    it("el celular perdido: cierra la sesión de otro equipo y esa cookie deja de servir enseguida", async () => {
      const { user } = await signedIn();
      const lost = await openSession(user.id, true);
      assert.ok(await auth.getSession(lost.token), "antes sirve (y queda en la memoria de 15 s)");
      const res = await close(lost.sessionId);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, own: false });
      assert.equal(await sessionRow(lost.sessionId), undefined);
      assert.equal(await auth.getSession(lost.token), null, "sin esperar los 15 s");
      assert.equal(setCookieOf(res), null, "la cookie de este equipo no se toca");
      assert.ok(await auth.getSession(browser.cookie), "este equipo sigue dentro");
    });

    it("también se llevan las alertas de ese celular", async () => {
      const { user } = await signedIn();
      const lost = await openSession(user.id, true);
      await db.insert(schema.pushSubscriptions).values({ sessionId: lost.sessionId, endpoint: "https://push.test/c", p256dh: "k", auth: "a", origin: "https://portal.test" });
      await close(lost.sessionId);
      assert.equal((await db.select().from(schema.pushSubscriptions)).length, 0);
    });

    it("cerrar la propia sesión borra la cookie de este equipo", async () => {
      const { session: mine } = await signedIn();
      const res = await close(mine.sessionId);
      assert.deepEqual(await res.json(), { ok: true, own: true });
      assert.equal(setCookieOf(res)!.maxAge, 0);
      assert.equal(await sessionRow(mine.sessionId), undefined);
    });

    it("un id que no es número: 400", async () => {
      await signedIn();
      for (const id of ["abc", "1.5", "NaN"]) assert.equal((await close(id)).status, 400, id);
    });

    it("cerrar una sesión que ya no existe no falla (es idempotente)", async () => {
      await signedIn();
      const res = await close(99_999);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, own: false });
    });

    it("cualquier usuario del portal puede cerrar la sesión de otro (la central es un solo equipo)", async () => {
      await signedIn();
      const luis = await createUser();
      const luisSession = await openSession(luis.id);
      assert.equal((await close(luisSession.sessionId)).status, 200);
      assert.equal(await sessionRow(luisSession.sessionId), undefined);
    });
  });

  describe("un recorrido completo", () => {
    it("entra, se instala, ve su sesión, y la central la cierra desde otro equipo", async () => {
      await createUser({ email: "ana@clapi.test", name: "Ana Central" });
      // 1. Entra desde el celular.
      const entered = await attempt({ email: "ana@clapi.test", password: PASSWORD }, freshIp(), { "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile" });
      assert.equal(entered.status, 200);
      followCookies(entered);
      const phoneCookie = browser.cookie!;
      // 2. Lo instala: pasa a 30 días.
      const installed = await session.POST(request("POST", "/api/auth/session", { body: { installed: true } }));
      assert.equal((await installed.json()).changed, true);
      followCookies(installed);
      // 3. Desde el computador (otro «navegador») entra y ve el celular en la lista.
      browser.cookie = undefined;
      const desk = await attempt({ email: "ana@clapi.test", password: PASSWORD }, freshIp());
      followCookies(desk);
      const list = (await (await sessions.GET()).json()) as { current: number; sessions: { id: number; installed: boolean }[] };
      const phone = list.sessions.find((s) => s.installed)!;
      assert.notEqual(phone.id, list.current);
      // 4. Lo cierra a distancia y el celular ya no entra.
      await sessionDelete(phone.id);
      assert.ok(await auth.getSession(browser.cookie), "el computador sigue");
      assert.equal(await auth.getSession(phoneCookie), null);
    });

    async function sessionDelete(id: number) {
      return sessionById.DELETE(request("DELETE", `/api/sessions/${id}`), params({ id }));
    }
  });
});
