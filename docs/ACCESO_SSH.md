# Cómo conectarte al servidor de staging

Guía paso a paso para entrar por primera vez. Hazla junto al administrador de infraestructura (David): hay pasos que haces tú y pasos que hace él.

> En los comandos, cambia `TU_USUARIO` por tu nombre de usuario: en minúsculas, sin espacios ni tildes (por ejemplo `juan`).

---

## Paso 1 · Tú: crea tu llave SSH

La llave SSH es como un par de llaves: una **privada** que nunca sale de tu computador y una **pública** que le das al servidor.

Copia y pega en tu terminal:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/clapi_ed25519 -C "TU_USUARIO@clapi"
```

Te va a preguntar:
- `Enter passphrase`: escribe una contraseña para proteger la llave. No se ve mientras escribes, es normal.
- `Enter same passphrase again`: repítela.

**No olvides esa contraseña:** te la va a pedir cada vez que te conectes.

> **Windows:** usa PowerShell; el comando es igual. Si `ssh-keygen` no existe, activa «Cliente OpenSSH» en *Configuración → Aplicaciones → Características opcionales*.

✅ Quedan dos archivos en `~/.ssh/`: `clapi_ed25519` (privada) y `clapi_ed25519.pub` (pública).

---

## Paso 2 · Tú: envía tu llave pública

Muéstrala:

```bash
cat ~/.ssh/clapi_ed25519.pub
```

Sale una sola línea parecida a:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...muchos caracteres... TU_USUARIO@clapi
```

Cópiala **completa** y envíasela a David por chat, junto con el usuario que elegiste. Es seguro mandarla: la pública no es secreta.

> ⚠️ **Nunca envíes el archivo `clapi_ed25519` (sin `.pub`).** Esa es tu llave privada: quien la tenga puede entrar como tú. Si la enviaste por error, avisa y crea una nueva.

---

## Paso 3 · David: da el acceso

*Esto lo hace el administrador. Tú esperas a que te avise.*

1. Agrega tu línea a `infra/access/admins.json`:
   ```json
   {
     "jdavid": "ssh-ed25519 AAAA...",
     "TU_USUARIO": "ssh-ed25519 AAAA... (la que enviaste)"
   }
   ```
2. Sube el cambio:
   ```bash
   git add infra/access/admins.json
   git commit -m "Acceso SSH para TU_USUARIO"
   git push origin dev
   ```
3. Lo aplica en el servidor:
   ```bash
   infra/scripts/sync-admins.sh jdavid@2.31.0.79
   ```

✅ Tu usuario queda creado en el servidor, en los grupos `dispatch-admins` y `docker`.

---

## Paso 4 · Tú: conéctate por primera vez

```bash
ssh -i ~/.ssh/clapi_ed25519 TU_USUARIO@staging.dispatch.clapi.solutions
```

La primera vez aparece algo así:

```
The authenticity of host 'staging.dispatch.clapi.solutions' can't be established.
ED25519 key fingerprint is SHA256:....
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

Escribe `yes` y Enter. Luego te pide la contraseña de tu llave (la del paso 1).

✅ Si ves algo como `TU_USUARIO@dispatch-staging:~$`, ya estás dentro.

---

## Paso 5 · Tú: comprueba que todo funciona

Ya dentro del servidor:

```bash
cd /opt/dispatch
docker ps
```

Debes ver los contenedores (`caddy`, `postgres`, `bot`, `portal`, `worker`) con `(healthy)`.

```bash
cat .tag
```

Muestra la versión (hash del commit) que está desplegada.

Para salir del servidor:

```bash
exit
```

---

## Paso 6 · Tú (opcional): atajo para conectarte

Para no escribir el comando largo cada vez, crea o edita el archivo `~/.ssh/config` en **tu** computador y agrega:

```
Host clapi-staging
    HostName staging.dispatch.clapi.solutions
    User TU_USUARIO
    IdentityFile ~/.ssh/clapi_ed25519
```

Desde ahora te conectas con:

```bash
ssh clapi-staging
```

---

## Si algo falla

| Mensaje | Qué pasa | Qué hacer |
|---|---|---|
| `Permission denied (publickey)` | El servidor no reconoce tu llave | Revisa que el usuario sea exactamente el que le diste a David y que uses `-i ~/.ssh/clapi_ed25519`. Si sigue, confirma con David que corrió el paso 3 |
| `Host key verification failed` | Tu computador tiene guardada otra huella del servidor | Avísale a David antes de hacer nada: puede ser normal (servidor recreado) o no |
| `Connection timed out` | No llegas al servidor | Revisa tu internet; prueba `ping staging.dispatch.clapi.solutions` |
| Olvidaste la contraseña de la llave | No se puede recuperar | Crea una llave nueva (paso 1) y repite desde el paso 2 |

---

## Reglas

- La llave privada se queda en tu computador. No la copies a otros equipos ni la subas a ningún lado.
- **Para desplegar no necesitas SSH:** basta con mergear tu PR a `dev`.
- Los secretos del servidor (`/opt/dispatch/.env`) no se leen ni se pegan en el chat. Se cambian con `./set-secret.sh`.
- Si cambias de computador o pierdes la llave, avisa a David y repite desde el paso 1.

Lo que puedes hacer ya dentro (ver logs, desplegar, diagnosticar) está en [`OPERACION.md`](OPERACION.md).
