output "ipv4" {
  description = "IP pública. Es la que va en los registros DNS."
  value       = hcloud_primary_ip.v4.ip_address
}

output "ipv6" {
  value = hcloud_server.main.ipv6_address
}

output "ssh" {
  description = "Cómo entrar (cada persona con su propio usuario)."
  value       = { for name in keys(var.admins) : name => "ssh ${name}@${hcloud_primary_ip.v4.ip_address}" }
}
