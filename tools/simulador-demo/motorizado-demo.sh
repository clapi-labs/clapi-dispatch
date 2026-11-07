#!/usr/bin/env bash
# Registra en staging al motorizado de la demo, que recibe las fichas de todas
# las motos del simulador. Queda activo (el bot lo reconoce: botones y
# novedades) pero en pausa, para que la cola real nunca le asigne pedidos.
#   tools/simulador-demo/motorizado-demo.sh tu_usuario 573001234567 "Nombre"
set -euo pipefail
USUARIO="${1:?uso: $0 tu_usuario telefono nombre}"
TEL="$(echo "${2:?falta el teléfono}" | tr -cd '0-9')"
NOMBRE="${3:?falta el nombre}"
[[ "$TEL" =~ ^[0-9]+$ ]] || exit 1
ssh -i "${SSH_KEY:-$HOME/.ssh/clapi_ed25519}" "$USUARIO@staging.dispatch.clapi.solutions" \
  "docker exec -i dispatch-postgres-1 psql -U dispatch -d dispatch -v ON_ERROR_STOP=1 -v tel='$TEL' -v nombre='$NOMBRE'" <<'SQL'
begin;
delete from couriers where right(phone, 10) = right(:'tel', 10) and not exists (select 1 from assignments a where a.courier_id = couriers.id);
update couriers set active = false where right(phone, 10) = right(:'tel', 10);
insert into couriers (name, phone, status, active) values (:'nombre', :'tel', 'paused', true) returning id, name, phone, status;
commit;
SQL
echo "Listo. Que le escriba «hola» al bot para abrir la ventana de 24 h de WhatsApp."
echo "En .env.simulador: DEMO_MOTORIZADO=$TEL y reinicia el simulador."
