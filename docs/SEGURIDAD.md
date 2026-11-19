# Seguridad

El sistema maneja datos de restaurantes, motorizados y clientes, y cuentas que cuestan plata (OpenAI, Meta, Google). Está en internet y su código es público. El objetivo no es ser invulnerables, sino **no ser una presa fácil**: que ningún ataque sencillo o barato funcione y que, si algo pasa, nos enteremos y podamos recuperarnos.

Este documento tiene las reglas que no se negocian, qué hacer si se filtra una llave y una rutina mensual corta. La auditoría que lo originó, con sus hallazgos y lo que sigue pendiente, está en el issue #32.

**Un problema de seguridad que todavía no está arreglado no se describe en público** (issues, PRs, commits) con los pasos para aprovecharlo: se le cuenta en privado al responsable de infraestructura. En público va qué falla y qué tan grave es.

## Reglas mínimas

### 1. Cuentas: 2FA y permisos mínimos

Toda persona con acceso a una de estas cuentas tiene **2FA activado** (app de autenticación o llave física; SMS solo si no hay otra opción) y **solo los permisos que usa**. Cada cuenta tiene un **dueño** que responde por ella y al menos **dos personas con acceso de administrador**, para no quedar por fuera si una pierde el suyo.

| Cuenta | Qué se protege | Mínimo exigido |
|---|---|---|
| GitHub (organización `clapi-labs`) | Código, CI, imágenes de GHCR | 2FA exigido a nivel de organización. Dos dueños. Los miembros no crean repositorios públicos. Escaneo de secretos y bloqueo de llaves al hacer push activos |
| Meta (Business Manager y la app de WhatsApp) | El número de WhatsApp de la agencia | 2FA para todos los administradores. El bot usa el token de un **usuario de sistema** con solo los permisos de WhatsApp, nunca el token personal o temporal de alguien |
| OpenAI | La llave del bot | Llave de un **proyecto** solo para este sistema. Límite de gasto mensual y alerta por correo |
| Google Cloud | La llave de Geocoding | Llave restringida a la **IP del servidor** y a la **Geocoding API**. Tope diario de consultas y alerta de presupuesto |
| Hetzner | El servidor | 2FA. Token de API solo en la máquina de quien administra la infraestructura, nunca en el repo |
| Servidor (SSH) | Todo lo de `/opt/dispatch` | Solo llaves, **con frase de paso**. La lista está en `infra/access/admins.json` |
| Portal | Chats, restaurantes, motorizados | Un usuario por persona (nada de usuarios compartidos), contraseña de 12 o más caracteres y que no se use en otro lado |

**Ojo con el grupo `docker` del servidor:** quien está en él puede hacer lo mismo que `root`. Darle ese grupo a alguien es darle el servidor completo.

### 2. Secretos

- Los secretos viven **solo** en `/opt/dispatch/.env` del servidor (y en la máquina de quien los genera, mientras los genera). **Nunca** en el repositorio, en un chat, en un issue, en una captura de pantalla ni en el historial de la terminal. Cómo cambiarlos: [OPERACION.md](OPERACION.md), «Secretos y configuración».
- Cada PR pasa por **gitleaks** (job «Secretos» del CI, reglas en `.gitleaks.toml`). Además, GitHub tiene activos el **escaneo de secretos** y el **bloqueo de llaves al hacer push**. Si alguno avisa, no se ignora: se sigue [«Si se filtra una llave»](#si-se-filtra-una-llave). Solo un falso positivo comprobado se excluye, con su *fingerprint* en `.gitleaksignore`.
- Mientras el repositorio sea público: nada de teléfonos, nombres, direcciones ni coordenadas reales en el código, las pruebas, los commits o los documentos ([PLAN.md](PLAN.md), I-6).

### 3. Backups

- **Copia diaria** de la base, **cifrada**, guardada **fuera del servidor**.
- **Restauración probada** al menos una vez al mes (rutina mensual): una copia que nunca se restauró no cuenta como backup.
- Se guardan al menos 30 días.

> **Estado: pendiente.** Hoy no hay backups. Falta decidir adónde van las copias (issue #32).

### 4. Gasto: límites y alertas

OpenAI, Google y Meta cobran por uso, y una llave filtrada o un abuso se notan primero en la factura. Cada una tiene un **límite de gasto** y una **alerta** que le llega al dueño de la cuenta, con valores que él decide según el uso normal del mes. Una alerta de gasto inesperada se trata como una posible llave filtrada.

Del lado del sistema:
- Solo piden domicilios los **números registrados** en Restaurantes ([BOT.md](BOT.md), «Números no registrados»): un número desconocido no gasta OpenAI.
- Las respuestas de OpenAI tienen tope de tamaño.

### 5. Todo al día

- **Servidor:** las actualizaciones de seguridad se instalan solas (`unattended-upgrades`). Si el servidor pide reinicio (`/var/run/reboot-required`), se reinicia en un horario sin servicios.
- **Dependencias:** `npm audit --omit=dev` sin vulnerabilidades altas ni críticas. Las alertas de Dependabot se atienden en la rutina mensual o antes, si son críticas.
- **Imágenes:** las versiones base (`node`, `python`, `postgres`, `caddy`) se suben cuando salen correcciones de seguridad.

### 6. Accesos: altas y bajas

**Cuando alguien sale del equipo, se le quitan todos los accesos el mismo día:**

- [ ] GitHub: sacarlo de la organización `clapi-labs`.
- [ ] Servidor: borrar su línea de `infra/access/admins.json` y correr `infra/scripts/sync-admins.sh` ([OPERACION.md](OPERACION.md), «Quitar o dar acceso»).
- [ ] Portal: desactivar su usuario. Lo saca del portal en menos de 30 segundos. Todavía no hay botón para esto; en el servidor:
  ```bash
  docker exec dispatch-postgres-1 psql -U dispatch -d dispatch -c "update users set active = false where email = 'correo@dominio.com'"
  ```
- [ ] Meta, OpenAI, Google Cloud y Hetzner: quitarlo de cada cuenta en la que esté.
- [ ] Secretos que conocía o pudo ver (los del `.env` si tenía acceso al servidor): cambiarlos ([«Si se filtra una llave»](#si-se-filtra-una-llave)).
- [ ] Anotar la fecha y quién lo hizo en el issue de la salida.

**Cuando alguien entra:** se le da solo lo que necesita para su trabajo, con su propia cuenta y 2FA desde el primer día.

### 7. Producción

- `DEPLOY_ENV=production` en su `.env`. `AUTH_DISABLED` y `SIMULATOR_ENABLED` **vacías**: `deploy.sh` se niega a desplegar si no lo están.
- Ningún usuario de prueba ni contraseña débil.
- Backups, alertas de gasto y avisos funcionando **desde el primer día**.

### 8. Desde dónde se administra

- El portal y el servidor no se administran desde **redes con inspección de HTTPS** (algunas redes de empresas o universidades descifran el tráfico y pueden ver contraseñas y cookies). Ante la duda, se usan los datos del celular.
- Las llaves SSH tienen frase de paso y no se copian a otros equipos.

## Si se filtra una llave

Una llave «filtrada» es cualquiera que haya quedado donde no debía: en un commit (aunque se borre después; el historial es público), en un chat, en un issue, en una captura o en el equipo de alguien que ya no está en el equipo.

1. **Cambiarla ya.** No se espera a confirmar si alguien la usó. Orden: generar la nueva en el proveedor → `./set-secret.sh NOMBRE` → `./deploy.sh deploy "$(cat .tag)"` → comprobar que todo responde → **revocar la vieja** ([OPERACION.md](OPERACION.md), «Secretos y configuración»).
2. **Revisar si se usó:** el panel de uso o la facturación del proveedor, y los registros del servidor.
3. **Si estaba en el repositorio:** borrarla del código no basta, porque sigue en el historial. Lo que la deja sin valor es **revocarla**.
4. **Anotarlo** en un issue: qué se filtró, cuándo, qué se hizo. Sin el valor de la llave.

| Secreto | Dónde se cambia | Ojo |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI → el proyecto → API keys | Revisar el uso de los últimos días |
| `WHATSAPP_ACCESS_TOKEN` | Meta Business → Usuarios del sistema → generar token | Con solo los permisos de WhatsApp |
| `WHATSAPP_APP_SECRET` | Meta for Developers → la app → Configuración básica | Al cambiarlo, el webhook rechaza todo hasta que el `.env` tenga el nuevo: hacerlo seguido |
| `WHATSAPP_VERIFY_TOKEN` | Inventado por nosotros: en el `.env` y en el panel del webhook en Meta | Solo se usa al configurar el webhook |
| `WHATSAPP_PIN` | WhatsApp Manager → el número → verificación en dos pasos | — |
| `GOOGLE_MAPS_API_KEY` | Google Cloud → Credenciales | Mantener las restricciones (IP del servidor y Geocoding API) |
| `INTERNAL_SECRET` | `openssl rand -base64 36` | El bot y el portal lo leen del mismo `.env`: basta redesplegar |
| `SESSION_SECRET` | `openssl rand -base64 36` | Cierra todas las sesiones del portal |
| `POSTGRES_PASSWORD` | Primero en la base (`ALTER USER dispatch PASSWORD '…'`), después en el `.env` | Cambiar solo el `.env` deja a las apps sin base |
| `HCLOUD_TOKEN` | Hetzner → el proyecto → Seguridad → API tokens | Vive solo en la máquina de quien administra la infraestructura |
| Llave SSH personal | Generar una nueva, cambiarla en `admins.json` y correr `sync-admins.sh` | La vieja deja de funcionar al sincronizar |
| Llave de despliegue | Generar el par nuevo, la pública en `infra/staging/terraform.tfvars` y en el usuario `deploy`, la privada en los secretos de GitHub | Solo puede ejecutar `deploy.sh` |

## Rutina mensual

Unos 30 minutos, el primer lunes de cada mes. Quien la haga abre un issue «Rutina de seguridad: <mes>» con esta lista marcada, lo que encontró y lo que hizo, y lo cierra cuando todo quedó atendido o con su propio issue.

**Accesos**
- [ ] Miembros de la organización en GitHub: ¿sigue estando cada uno? ¿Todos con 2FA? ¿Siguen siendo dos los dueños?
- [ ] `infra/access/admins.json` y los usuarios del servidor (`getent group dispatch-admins docker`): ¿coinciden con el equipo actual?
- [ ] Usuarios del portal: ¿hay alguno de alguien que ya no está o alguno compartido?
- [ ] Administradores en Meta, OpenAI, Google Cloud y Hetzner.

**Dependencias y servidor**
- [ ] `npm audit --omit=dev` y alertas de Dependabot: nada alto ni crítico sin atender.
- [ ] En el servidor: `apt list --upgradable` (nada de seguridad pendiente) y si existe `/var/run/reboot-required`.
- [ ] El último job «Secretos» del CI pasó, y GitHub no tiene alertas de secretos abiertas.

**Gastos**
- [ ] Factura del mes en OpenAI, Google y Meta: ¿algo fuera de lo normal?
- [ ] Los límites y las alertas siguen configurados.

**Backups**
- [ ] Hay una copia de cada día del último mes.
- [ ] **Restaurar la última copia** en una base aparte y comprobar que tiene los datos de ayer.
