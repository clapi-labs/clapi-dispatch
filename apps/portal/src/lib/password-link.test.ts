import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  createPasswordLinkToken,
  PASSWORD_LINK_TTL_SECONDS,
  passwordFingerprint,
  verifyPasswordLinkToken,
} from "@/lib/password-link";
import { createSessionToken } from "@/lib/session";
import { SESSION_SECRET } from "@/test-support/portal-env";

const HASH = "scrypt$c2Fs$aGFzaA==";

beforeEach(() => {
  process.env.SESSION_SECRET = SESSION_SECRET;
});

describe("enlace de contraseña (token firmado)", () => {
  it("lleva el usuario, vence a las 24 horas y trae la huella de la contraseña actual", () => {
    const now = Date.now();
    const parsed = verifyPasswordLinkToken(createPasswordLinkToken(7, HASH, now), now)!;
    assert.equal(parsed.userId, 7);
    assert.equal(parsed.expiresAt, Math.floor(now / 1000) + 24 * 3600);
    assert.equal(PASSWORD_LINK_TTL_SECONDS, 24 * 3600);
    assert.equal(parsed.fingerprint, passwordFingerprint(HASH));
    assert.equal(parsed.fingerprint.length, 16);
  });

  it("la huella cambia cuando cambia la contraseña guardada", () => {
    assert.notEqual(passwordFingerprint(HASH), passwordFingerprint(`${HASH}x`));
  });

  it("vencido: se rechaza", () => {
    const now = Date.now();
    const token = createPasswordLinkToken(7, HASH, now);
    assert.ok(verifyPasswordLinkToken(token, now + 24 * 3600_000 - 5_000));
    assert.equal(verifyPasswordLinkToken(token, now + 24 * 3600_000 + 5_000), null);
  });

  it("alterado, sin firma o con otra clave: se rechaza", () => {
    const token = createPasswordLinkToken(7, HASH);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ u: 1, exp: 9_999_999_999, f: passwordFingerprint(HASH) })).toString("base64url");
    assert.equal(verifyPasswordLinkToken(`${forged}.${sig}`), null);
    assert.equal(verifyPasswordLinkToken(body), null);
    assert.equal(verifyPasswordLinkToken(`${token}.x`), null);
    assert.equal(verifyPasswordLinkToken(""), null);
    assert.equal(verifyPasswordLinkToken(undefined), null);
    process.env.SESSION_SECRET = `${SESSION_SECRET}-distinto`;
    assert.equal(verifyPasswordLinkToken(token), null);
  });

  it("la cookie de sesión no sirve como enlace de contraseña", () => {
    const cookie = createSessionToken(7, 1, Math.floor(Date.now() / 1000) + 3600);
    assert.equal(verifyPasswordLinkToken(cookie), null);
  });

  it("sin SESSION_SECRET no se firma nada", () => {
    process.env.SESSION_SECRET = "corto";
    assert.throws(() => createPasswordLinkToken(7, HASH), /SESSION_SECRET/);
    assert.equal(verifyPasswordLinkToken("a.b"), null);
  });
});
