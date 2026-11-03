# Acceso al servidor de staging

Guía para alguien nuevo del equipo: crear tu llave SSH, pedir acceso y entrar al servidor. Lo que se hace una vez adentro (desplegar, secretos, registros) está en [OPERACION.md](OPERACION.md).

- Servidor: `staging.dispatch.clapi.solutions` (IP `2.31.0.79`)
- Se entra solo con llave SSH: no hay contraseña ni `root`.
- Todo vive en `/opt/dispatch`.

## Paso 1. Crear tu llave (en tu computador)

**Windows** (10 u 11 ya traen SSH). Abre **PowerShell** (menú Inicio → escribe «PowerShell») y corre:

```powershell
ssh -V                                  # debe mostrar "OpenSSH_..."; si dice que no existe, ver abajo
mkdir $HOME\.ssh -Force                 # la carpeta, por si no existe
ssh-keygen -t ed25519 -f $HOME\.ssh\clapi_ed25519 -C "tu_nombre@clapi"
```

Si `ssh` no existe: Configuración → Sistema → Características opcionales → Agregar una característica → **Cliente OpenSSH** → Instalar, y vuelve a abrir PowerShell.

**Linux o Mac**, en una terminal:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/clapi_ed25519 -C "tu_nombre@clapi"
```

Te pide una frase de contraseña: **ponle una**. Protege la llave si alguien llega a copiar el archivo.

Se crean dos archivos:

| Archivo | Qué es |
|---|---|
| `clapi_ed25519` | La llave **privada**. Nunca sale de tu computador: no se envía, no se sube al repo, no se pega en un chat |
| `clapi_ed25519.pub` | La llave **pública**. Es la que se comparte |

## Paso 2. Pedir acceso

Muestra tu llave pública y cópiala completa (es una sola línea que empieza por `ssh-ed25519`):

```powershell
Get-Content $HOME\.ssh\clapi_ed25519.pub   # Windows (PowerShell)
```
```bash
cat ~/.ssh/clapi_ed25519.pub              # Linux o Mac
```

Mándasela al administrador del servidor junto con el **nombre de usuario** que quieres (en minúsculas, sin espacios; por ejemplo `carlos`). Espera a que te confirme.

## Paso 3. Entrar

```powershell
ssh -i $HOME\.ssh\clapi_ed25519 tu_usuario@staging.dispatch.clapi.solutions   # Windows
```
```bash
ssh -i ~/.ssh/clapi_ed25519 tu_usuario@staging.dispatch.clapi.solutions       # Linux o Mac
```

La primera vez pregunta si confías en la huella del servidor: escribe `yes`. Después pide la frase de tu llave.

Ya adentro estás en la terminal del servidor (Linux), sin importar que tu computador sea Windows: los comandos de aquí en adelante son de Linux.

```bash
cd /opt/dispatch
docker ps          # todos los servicios deben decir (healthy)
cat .tag           # versión desplegada
```

### Atajo opcional

Para entrar solo con `ssh clapi-staging`, crea el archivo `config` (sin extensión) en tu carpeta `.ssh`. En Windows: `notepad $HOME\.ssh\config` (si Notepad lo guarda como `config.txt`, renómbralo quitando el `.txt`). En Linux o Mac: `~/.ssh/config`. Contenido:

```
Host clapi-staging
  HostName staging.dispatch.clapi.solutions
  User tu_usuario
  IdentityFile ~/.ssh/clapi_ed25519
```

## Paso 4. Qué puedes hacer

Tu usuario queda en los grupos `dispatch-admins` y `docker`: puedes ver el estado, leer registros, desplegar y cambiar secretos. Los comandos están en [OPERACION.md](OPERACION.md). Los más usados:

```bash
docker logs --tail 50 dispatch-bot-1                 # registros del bot
./deploy.sh deploy <hash-de-40-caracteres>           # desplegar un commit ya construido
./set-secret.sh NOMBRE_VARIABLE                      # cambiar un secreto
./deploy.sh deploy "$(cat .tag)"                     # aplicar el secreto (las apps lo leen al arrancar)
```

Reglas:

- **Los cambios de código no se hacen en el servidor.** Se hacen en el repo (rama desde `dev`, PR a `dev`), se construyen las imágenes y se despliega el hash. Un archivo editado a mano en el servidor se pierde en el siguiente despliegue.
- **Los secretos solo viven en `/opt/dispatch/.env`.** Nunca en el repo ni en un chat.
- **Para volver atrás**, despliega el hash anterior.
- Commits y PR en español, en el estilo del historial (ver `CLAUDE.md`).

## Si algo falla

| Mensaje | Qué pasa |
|---|---|
| `Permission denied (publickey)` | Tu llave aún no está dada de alta, usas otro usuario, o falta `-i ~/.ssh/clapi_ed25519` |
| `Host key verification failed` | No aceptaste la huella. Conéctate una vez a mano y responde `yes` |
| `Connection timed out` | Revisa tu internet; si sigue, avisa al administrador (el servidor o el firewall pueden estar caídos) |
| Windows: `Bad permissions` o `UNPROTECTED PRIVATE KEY FILE` | La llave quedó con permisos abiertos. En PowerShell: `icacls $HOME\.ssh\clapi_ed25519 /inheritance:r /grant:r "$($env:USERNAME):(R)"` |
| `permission denied` al usar `docker` | Sal y vuelve a entrar: los grupos se aplican al iniciar la sesión |

---

## Para el administrador: dar el acceso

1. Agrega la línea del nuevo compañero a `infra/access/admins.json` (usuario → su llave pública):
   ```json
   {
     "jdavid": "ssh-ed25519 AAAA…",
     "andres": "ssh-ed25519 AAAA…",
     "carlos": "ssh-ed25519 AAAA… carlos@clapi"
   }
   ```
2. Commitea el cambio y aplícalo desde tu computador (necesitas acceso al servidor):
   ```bash
   infra/scripts/sync-admins.sh tu_usuario@staging.dispatch.clapi.solutions
   ```
   Crea las cuentas que falten, actualiza las llaves y quita las que ya no estén en la lista.
3. Para quitarle el acceso a alguien: borra su línea y vuelve a correr el script.

El acceso al servidor no incluye el repositorio. Para clonarlo y hacer PR, hay que invitarlo también a la organización `clapi-labs` en GitHub.
