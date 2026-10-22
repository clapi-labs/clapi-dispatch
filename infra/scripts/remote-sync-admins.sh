#!/usr/bin/env bash
# Corre EN EL SERVIDOR, como root. Deja las cuentas de administradores igual
# que infra/access/admins.json: crea las que falten, actualiza llaves y borra
# las que ya no estén. No se ejecuta a mano: lo lanza infra/scripts/sync-admins.sh.
#
# Recibe el JSON en base64 por la variable ADMINS_B64.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Debe correr como root." >&2; exit 1; }
[ -n "${ADMINS_B64:-}" ] || { echo "Falta ADMINS_B64." >&2; exit 1; }

GROUP=dispatch-admins
CALLER="${SUDO_USER:-}"
SSHD_DROPIN=/etc/ssh/sshd_config.d/99-hardening.conf

# Lista "nombre llave" validada: nombres seguros y llaves con formato SSH.
# Se captura primero en una variable: un fallo dentro de `mapfile < <(...)` no lo
# detecta `set -e` y el script seguiría con una lista vacía (borrando a todos).
VALIDATED="$(echo "$ADMINS_B64" | base64 -d | python3 -c '
import json, re, sys
data = json.load(sys.stdin)
if not data:
    sys.exit("admins.json está vacío: no se puede dejar el servidor sin administradores.")
for name, key in data.items():
    if not re.fullmatch(r"[a-z][a-z0-9_-]{1,30}", name):
        sys.exit(f"Nombre de usuario inválido: {name!r}")
    if not re.fullmatch(r"(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( \S+)?", key.strip()):
        sys.exit(f"Llave inválida para {name}")
    print(name, key.strip())
')" || { echo "Lista de administradores inválida: no se cambió nada." >&2; exit 1; }
mapfile -t DESIRED <<< "$VALIDATED"

getent group "$GROUP" >/dev/null || groupadd "$GROUP"
echo "%$GROUP ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-dispatch-admins
chmod 440 /etc/sudoers.d/90-dispatch-admins

declare -A WANTED=()
for line in "${DESIRED[@]}"; do
  name="${line%% *}"; key="${line#* }"
  WANTED[$name]=1

  if ! id "$name" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$name"
    echo "  + usuario creado: $name"
  fi
  usermod -aG "$GROUP" "$name"
  getent group docker >/dev/null && usermod -aG docker "$name"
  passwd -l "$name" >/dev/null

  install -d -m 700 -o "$name" -g "$name" "/home/$name/.ssh"
  printf '%s\n' "$key" > "/home/$name/.ssh/authorized_keys"
  chown "$name:$name" "/home/$name/.ssh/authorized_keys"
  chmod 600 "/home/$name/.ssh/authorized_keys"
done

# Quien esté en el grupo pero ya no en la lista, se va. Nunca quien ejecuta
# esto (no te puedes echar a ti mismo a mitad de la operación).
for name in $(getent group "$GROUP" | cut -d: -f4 | tr ',' ' '); do
  [ -n "${WANTED[$name]:-}" ] && continue
  if [ "$name" = "$CALLER" ]; then
    echo "  ! $name no está en la lista, pero es quien ejecuta: se deja. Corre de nuevo desde otra cuenta." >&2
    continue
  fi
  pkill -KILL -u "$name" 2>/dev/null || true
  userdel --remove "$name"
  echo "  - usuario eliminado: $name"
done

# Solo estos usuarios (más deploy) pueden entrar por SSH.
if [ -f "$SSHD_DROPIN" ]; then
  sed -i '/^AllowUsers /d' "$SSHD_DROPIN"
  echo "AllowUsers deploy ${!WANTED[*]}" >> "$SSHD_DROPIN"
  if command -v sshd >/dev/null; then
    sshd -t
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  fi
fi

echo "Administradores: ${!WANTED[*]}"
