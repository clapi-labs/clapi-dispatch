terraform {
  required_version = ">= 1.8"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.50"
    }
  }
}

# El token de Hetzner NO va aquí: el proveedor lo lee de la variable de
# entorno HCLOUD_TOKEN.
provider "hcloud" {}

module "server" {
  source = "../modules/server"

  name              = "dispatch-staging"
  location          = var.location
  server_type       = var.server_type
  admins            = var.admins
  deploy_public_key = var.deploy_public_key
}

output "ipv4" {
  value = module.server.ipv4
}

output "ssh" {
  value = module.server.ssh
}
