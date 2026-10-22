# Infraestructura (OpenTofu + Hetzner)

```
infra/
├── modules/server/   # receta reutilizable: servidor + firewall + IP fija + llaves + cloud-init
└── staging/          # un entorno que usa la receta con sus valores (prod será otra carpeta igual)
```

Cada entorno tiene su propio estado, así un error en staging no puede tocar prod.

## Uso

El token de Hetzner va en una variable de entorno, nunca en el código:

```bash
export HCLOUD_TOKEN=...        # o: set -a; . ~/.config/clapi/hcloud.env; set +a
cd infra/staging
tofu init                      # una vez: descarga el proveedor
tofu plan                      # muestra qué cambiaría, sin tocar nada
tofu apply                     # lo aplica (pide confirmación)
```

## Reglas

- `terraform.tfstate` guarda el estado real de lo creado y **no se sube al repo** (está en `.gitignore`). Si se pierde, OpenTofu ya no sabe qué le pertenece.
- `terraform.tfvars` solo lleva llaves públicas.
- `.terraform.lock.hcl` sí se sube: fija la versión exacta del proveedor.
- `cloud-init` solo corre al primer arranque. Cambiarlo no modifica un servidor que ya existe.
