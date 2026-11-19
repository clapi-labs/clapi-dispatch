#!/usr/bin/env bash
# Genera el enlace temporal (24 h, un solo uso) para que un usuario del portal
# escriba su contraseña por primera vez o la restablezca. Si el usuario no
# existe, lo crea con una contraseña aleatoria que nadie conoce.
#
#   ssh TU_USUARIO@IP '/opt/dispatch/reset-link.sh Admin "William"'
#
# Corre dentro del contenedor del portal (ya tiene DATABASE_URL y SESSION_SECRET)
# y firma el enlace igual que apps/portal/src/lib/password-link.ts. No pide ni
# muestra contraseñas. Al usarse el enlace, la clave anterior se sobrescribe y
# se cierran las sesiones abiertas de ese usuario.
set -euo pipefail
umask 007

LOGIN="${1:?Uso: reset-link.sh usuario [Nombre]  (ej.: reset-link.sh Admin William)}"
NAME="${2:-$LOGIN}"
cd "${DEPLOY_DIR:-/opt/dispatch}"
TAG="$(cat .tag)"
HOST="$(grep -E '^PORTAL_HOST=' .env | head -1 | cut -d= -f2- | tr -d "\"'")"
[ -n "$HOST" ] || { echo "Falta PORTAL_HOST en .env." >&2; exit 1; }

IMAGE_TAG="$TAG" docker compose --env-file .env -f compose.yml exec -T \
  -e LINK_LOGIN="$LOGIN" -e LINK_NAME="$NAME" -e LINK_HOST="$HOST" portal node - <<'JS'
const { createHash, createHmac, randomBytes, scryptSync } = require("node:crypto");
const { Pool } = require("pg");

(async () => {
  const key = process.env.SESSION_SECRET;
  if (!key || key.length < 32) throw new Error("Falta SESSION_SECRET en el portal.");
  const login = process.env.LINK_LOGIN.trim().toLowerCase();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  let { rows } = await pool.query("select id, password_hash, active from users where email = $1", [login]);
  if (rows.length === 0) {
    const salt = randomBytes(16);
    const derived = scryptSync(randomBytes(32).toString("base64url"), salt, 64, { N: 16384, r: 8, p: 1 });
    const hash = `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
    ({ rows } = await pool.query("insert into users (email, name, password_hash) values ($1, $2, $3) returning id, password_hash, active", [login, process.env.LINK_NAME, hash]));
    console.error(`Usuario creado: ${login}`);
  }
  const user = rows[0];
  if (!user.active) throw new Error(`El usuario ${login} está desactivado.`);

  const payload = {
    u: user.id,
    exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    f: createHash("sha256").update(user.password_hash).digest("hex").slice(0, 16),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", key).update(`clave:${body}`).digest("base64url");
  console.log(`https://${process.env.LINK_HOST}/clave/${body}.${sig}`);
  await pool.end();
})().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
JS
