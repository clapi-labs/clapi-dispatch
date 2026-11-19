import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { eq } from "drizzle-orm";

import { verifyPassword } from "@dispatch/shared/auth/password";
import { db, schema } from "@dispatch/shared/db";
import { closeTestDatabase, integrationSkip, resetDatabase } from "@dispatch/shared/db/test-db";

import {
  browser,
  createUser,
  forgetSessions,
  installMocks,
  openSession,
  params,
  PASSWORD,
  request,
  resetMocks,
  restoreMocks,
  sessionCount,
  setCookieOf,
} from "@/test-support/portal-env";

/**
 * Usuario corto (Admin, dev) y enlace `/clave/<token>`: crear o restablecer la
 * contraseña con un enlace de un solo uso, que vence a las 24 h y cierra las
 * sesiones anteriores. Contra la base de pruebas; sin `TEST_DATABASE_URL` se salta.
 */

type Login = typeof import("./login/route");
type Setup = typeof import("./password-setup/route");
type Users = typeof import("../portal-users/route");
type UserLink = typeof import("../portal-users/[id]/link/route");
type Queries = typeof import("@/db/queries/password-link");
type Link = typeof import("@/lib/password-link");
type Admin = typeof import("@/lib/admin");
let login: Login;
let setup: Setup;
let users: Users;
let userLink: UserLink;
let queries: Queries;
let link: Link;
let admin: Admin;

before(async () => {
  if (integrationSkip) return;
  await installMocks();
  login = await import("./login/route");
  setup = await import("./password-setup/route");
  users = await import("../portal-users/route");
  userLink = await import("../portal-users/[id]/link/route");
  queries = await import("@/db/queries/password-link");
  link = await import("@/lib/password-link");
  admin = await import("@/lib/admin");
});

beforeEach(async () => {
  if (integrationSkip) return;
  await resetDatabase();
  resetMocks();
  delete process.env.PORTAL_ADMIN_EMAILS;
});

let ipSeq = 0;
const freshIp = () => `10.2.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
const signIn = (usuario: string, password: string) =>
  login.POST(request("POST", "/api/auth/login", { body: { email: usuario, password }, headers: { "x-forwarded-for": freshIp() } }));
const submit = (token: string, password: string, confirm = password, ip = freshIp()) =>
  setup.POST(request("POST", "/api/auth/password-setup", { body: { token, password, confirm }, headers: { "x-forwarded-for": ip } }));
const tokenFor = (user: { id: number; passwordHash: string }) => link.createPasswordLinkToken(user.id, user.passwordHash);
const reload = async (id: number) => (await db.select().from(schema.users).where(eq(schema.users.id, id)))[0];

describe("usuario corto y enlace de contraseña (Postgres)", { skip: integrationSkip }, () => {
  after(async () => {
    restoreMocks();
    await closeTestDatabase();
  });

  describe("login con usuario corto", () => {
    it("Admin, admin y ADMIN entran al usuario «admin», sin @", async () => {
      await createUser({ email: "admin", name: "William" });
      for (const usuario of ["Admin", "admin", "  ADMIN "]) {
        const res = await signIn(usuario, PASSWORD);
        assert.equal(res.status, 200, usuario);
        assert.deepEqual(await res.json(), { ok: true, name: "William" });
      }
    });

    it("«dev» entra con su clave y la equivocada da 401", async () => {
      await createUser({ email: "dev", password: "clave-de-dev-larga" });
      assert.equal((await signIn("dev", "clave-de-dev-larga")).status, 200);
      assert.equal((await signIn("dev", "otra")).status, 401);
    });

    it("PORTAL_ADMIN_EMAILS=dev: dev es administrador y Admin no (se compara en minúsculas)", async () => {
      process.env.PORTAL_ADMIN_EMAILS = "Dev";
      const dev = await createUser({ email: "dev" });
      const william = await createUser({ email: "admin" });

      browser.cookie = (await openSession(dev.id)).token;
      assert.equal(await admin.isAdmin(), true);
      assert.equal(await admin.isUserAdmin(), true);

      browser.cookie = (await openSession(william.id)).token;
      assert.equal(await admin.isAdmin(), false);
      assert.equal(await admin.isUserAdmin(), false);
    });
  });

  describe("POST /api/auth/password-setup", () => {
    it("con el enlace válido guarda la clave nueva con scrypt y se puede entrar con ella", async () => {
      const user = await createUser({ email: "admin", name: "William" });
      const res = await submit(tokenFor(user), "una-clave-nueva-1");
      assert.equal(res.status, 200);

      const saved = await reload(user.id);
      assert.match(saved.passwordHash, /^scrypt\$/);
      assert.equal(await verifyPassword("una-clave-nueva-1", saved.passwordHash), true);
      assert.equal((await signIn("Admin", "una-clave-nueva-1")).status, 200);
      assert.equal((await signIn("Admin", PASSWORD)).status, 401, "la clave anterior se sobrescribió");
    });

    it("es de un solo uso: el mismo enlace una segunda vez da 410", async () => {
      const user = await createUser({ email: "admin" });
      const token = tokenFor(user);
      assert.equal((await submit(token, "una-clave-nueva-1")).status, 200);
      const again = await submit(token, "otra-clave-nueva-2");
      assert.equal(again.status, 410);
      assert.match((await again.json()).error, /ya fue utilizado o expiró/);
      assert.equal(await verifyPassword("una-clave-nueva-1", (await reload(user.id)).passwordHash), true, "no se tocó");
    });

    it("un enlace emitido antes de un cambio de clave ya no sirve", async () => {
      const user = await createUser({ email: "admin" });
      const first = tokenFor(user);
      const second = tokenFor(user);
      assert.equal((await submit(second, "una-clave-nueva-1")).status, 200);
      assert.equal((await submit(first, "otra-clave-nueva-2")).status, 410);
    });

    it("dos envíos a la vez con el mismo enlace: solo uno lo usa", async () => {
      const user = await createUser({ email: "admin" });
      const token = tokenFor(user);
      const results = await Promise.all([submit(token, "clave-numero-uno"), submit(token, "clave-numero-dos")]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 410]);
    });

    it("vencido (más de 24 h): 410 y la clave no cambia", async () => {
      const user = await createUser({ email: "admin" });
      const old = link.createPasswordLinkToken(user.id, user.passwordHash, Date.now() - 25 * 3600_000);
      assert.equal((await submit(old, "una-clave-nueva-1")).status, 410);
      assert.equal(await verifyPassword(PASSWORD, (await reload(user.id)).passwordHash), true);
    });

    it("token inventado, de un usuario que no existe o de uno desactivado: 410", async () => {
      const ghost = link.createPasswordLinkToken(9999, "scrypt$a$b");
      assert.equal((await submit("basura.basura", "una-clave-nueva-1")).status, 410);
      assert.equal((await submit(ghost, "una-clave-nueva-1")).status, 410);
      const off = await createUser({ email: "baja", active: false });
      assert.equal((await submit(tokenFor(off), "una-clave-nueva-1")).status, 410);
    });

    it("exige confirmación igual y mínimo 8 caracteres, sin gastar el enlace", async () => {
      const user = await createUser({ email: "admin" });
      const token = tokenFor(user);
      const mismatch = await submit(token, "una-clave-nueva-1", "una-clave-nueva-2");
      assert.equal(mismatch.status, 400);
      assert.match((await mismatch.json()).error, /no coinciden/);
      assert.equal((await submit(token, "corta")).status, 400);
      assert.equal((await setup.POST(request("POST", "/api/auth/password-setup", { body: { password: "una-clave-nueva-1", confirm: "una-clave-nueva-1" } }))).status, 400);
      assert.equal((await submit(token, "una-clave-nueva-1")).status, 200, "el enlace sigue sirviendo");
    });

    it("cierra todas las sesiones abiertas del usuario y deja las de los demás", async () => {
      const user = await createUser({ email: "admin" });
      const other = await createUser({ email: "dev" });
      const mine = await openSession(user.id);
      const phone = await openSession(user.id, true);
      const theirs = await openSession(other.id);
      assert.equal(await sessionCount(), 3);

      assert.equal((await submit(tokenFor(user), "una-clave-nueva-1")).status, 200);

      const { getSession } = await import("@/lib/auth");
      assert.equal(await getSession(mine.token), null);
      assert.equal(await getSession(phone.token), null);
      forgetSessions();
      assert.equal(await getSession(mine.token), null, "tampoco tras olvidar la memoria: se borró de la base");
      assert.ok(await getSession(theirs.token));
      assert.equal(await sessionCount(), 1);
    });

    it("el enlace sirve para un usuario que se acaba de crear (clave aleatoria desconocida)", async () => {
      process.env.PORTAL_ADMIN_EMAILS = "dev";
      const dev = await createUser({ email: "dev" });
      browser.cookie = (await openSession(dev.id)).token;

      const created = await users.POST(request("POST", "/api/portal-users", { body: { usuario: " Admin ", nombre: "William" } }));
      assert.equal(created.status, 201);
      const { user } = await created.json();
      assert.equal(user.email, "admin");
      assert.equal((await signIn("admin", PASSWORD)).status, 401);

      const res = await userLink.POST(request("POST", `/api/portal-users/${user.id}/link`, { headers: { host: "portal.clapi.test", "x-forwarded-proto": "https" } }), params({ id: user.id }));
      assert.equal(res.status, 200);
      const { url } = await res.json();
      assert.match(url, /^https:\/\/portal\.clapi\.test\/clave\/[\w-]+\.[\w-]+$/);

      const token = url.split("/clave/")[1];
      assert.equal((await queries.userForPasswordLink(token))?.email, "admin");
      assert.equal((await submit(token, "clave-de-william-1")).status, 200);
      assert.equal(setCookieOf(await signIn("ADMIN", "clave-de-william-1")) !== null, true);
      assert.equal(await queries.userForPasswordLink(token), null, "quemado");
    });
  });

  describe("administración de usuarios (PORTAL_ADMIN_EMAILS)", () => {
    it("quien no es administrador recibe 403, y sin PORTAL_ADMIN_EMAILS nadie", async () => {
      const william = await createUser({ email: "admin" });
      browser.cookie = (await openSession(william.id)).token;
      process.env.PORTAL_ADMIN_EMAILS = "dev";
      assert.equal((await users.GET()).status, 403);
      assert.equal((await users.POST(request("POST", "/api/portal-users", { body: { usuario: "x1", nombre: "X" } }))).status, 403);
      assert.equal((await userLink.POST(request("POST", `/api/portal-users/${william.id}/link`), params({ id: william.id }))).status, 403);
      delete process.env.PORTAL_ADMIN_EMAILS;
      assert.equal((await users.GET()).status, 403, "con la variable vacía no es de todos: es de nadie");
    });

    it("el administrador ve la lista sin contraseñas, no repite usuarios y valida los datos", async () => {
      process.env.PORTAL_ADMIN_EMAILS = "dev";
      const dev = await createUser({ email: "dev", name: "Equipo" });
      browser.cookie = (await openSession(dev.id)).token;

      const list = await (await users.GET()).json();
      assert.deepEqual(list.users, [{ id: dev.id, email: "dev", name: "Equipo", active: true }]);

      const create = (body: unknown) => users.POST(request("POST", "/api/portal-users", { body }));
      assert.equal((await create({ usuario: "Admin", nombre: "William" })).status, 201);
      assert.equal((await create({ usuario: "ADMIN", nombre: "Otro" })).status, 409);
      assert.equal((await create({ usuario: "con espacio", nombre: "X" })).status, 400);
      assert.equal((await create({ usuario: "nuevo", nombre: " " })).status, 400);
    });
  });
});
