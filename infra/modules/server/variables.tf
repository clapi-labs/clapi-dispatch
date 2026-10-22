variable "name" {
  description = "Nombre base de los recursos en Hetzner, por ejemplo dispatch-staging."
  type        = string
}

variable "location" {
  description = "Ubicación de Hetzner: nbg1, fsn1 o hel1 (Europa), ash o hil (EE. UU.)."
  type        = string
}

variable "server_type" {
  description = "Tamaño del servidor. cx23 = 2 vCPU, 4 GB RAM, 40 GB de disco."
  type        = string
}

variable "image" {
  description = "Sistema operativo."
  type        = string
  default     = "ubuntu-24.04"
}

variable "admins" {
  description = "Personas con acceso SSH: nombre de usuario => llave pública. Revocar a alguien es borrar su línea."
  type        = map(string)

  validation {
    condition     = alltrue([for name in keys(var.admins) : can(regex("^[a-z][a-z0-9_-]{1,30}$", name))])
    error_message = "Los nombres de usuario van en minúsculas, sin espacios (a-z, 0-9, - y _)."
  }
}

variable "deploy_public_key" {
  description = "Llave pública con la que GitHub Actions entra a desplegar. Solo puede ejecutar /opt/dispatch/deploy.sh."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "Desde dónde se permite SSH. Por defecto todo internet (fail2ban frena la fuerza bruta); se puede limitar a IPs fijas."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "backups" {
  description = "Copias de seguridad automáticas de Hetzner (suman ~20% al precio)."
  type        = bool
  default     = true
}
