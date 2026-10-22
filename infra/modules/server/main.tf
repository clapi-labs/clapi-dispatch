terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.50"
    }
  }
}

locals {
  labels = {
    project = "clapi-dispatch"
    managed = "opentofu"
  }
}

# --- Llaves SSH -------------------------------------------------------------
# Hetzner las guarda como recursos del proyecto. Se inyectan al crear el
# servidor para que no mande una contraseña de root por correo. Después el
# acceso real lo da cloud-init (un usuario por persona) y root queda cerrado.
resource "hcloud_ssh_key" "admin" {
  for_each   = var.admins
  name       = "${var.name}-${each.key}"
  public_key = each.value
  labels     = local.labels
}

# --- Firewall ---------------------------------------------------------------
# Corre en la red de Hetzner, ANTES de que el tráfico llegue al servidor. Es
# la defensa que cuenta con Docker: ufw/iptables dentro del servidor no
# protegen los puertos que Docker publica, porque Docker escribe sus propias
# reglas por encima. Solo entran SSH, HTTP y HTTPS.
resource "hcloud_firewall" "main" {
  name   = "${var.name}-fw"
  labels = local.labels

  rule {
    description = "SSH"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.ssh_allowed_cidrs
  }

  rule {
    description = "HTTP (Caddy lo redirige a HTTPS y valida el certificado)"
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "HTTPS"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "HTTP/3"
    direction   = "in"
    protocol    = "udp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "Ping"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

# --- IP fija ----------------------------------------------------------------
# Una IP propia, separada del servidor. Si el servidor se recrea, la IP se
# conserva y no hay que tocar el DNS ni el webhook de Meta.
resource "hcloud_primary_ip" "v4" {
  name        = "${var.name}-v4"
  type        = "ipv4"
  location    = var.location
  auto_delete = false
  labels      = local.labels
}

# --- Servidor ---------------------------------------------------------------
resource "hcloud_server" "main" {
  name         = var.name
  server_type  = var.server_type
  image        = var.image
  location     = var.location
  ssh_keys     = [for key in hcloud_ssh_key.admin : key.id]
  firewall_ids = [hcloud_firewall.main.id]
  backups      = var.backups
  labels       = local.labels

  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.v4.id
    ipv6_enabled = true
  }

  # cloud-init corre una sola vez, en el primer arranque.
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    admins            = var.admins
    deploy_public_key = var.deploy_public_key
  })

  lifecycle {
    # Cambiar user_data o image obligaría a DESTRUIR y recrear el servidor
    # (con su base de datos). Como cloud-init solo corre al primer arranque,
    # esos cambios no harían nada en un servidor vivo: se ignoran. Si hay que
    # rehacerlo de verdad: tofu apply -replace=module.server.hcloud_server.main
    ignore_changes = [user_data, image, ssh_keys]
  }
}
