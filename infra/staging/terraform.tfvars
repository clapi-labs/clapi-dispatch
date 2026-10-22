# Solo llaves PÚBLICAS: es seguro que estén en el repositorio.
# Para dar acceso a alguien: agregar su línea y correr `tofu apply`.
# (Un usuario nuevo en un servidor que ya existe lo crea un paso aparte: ver README de infra.)
admins = {
  jdavid = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKQJEKquohZo2ZsE753ObpJKPJr90zshaw/r/Hru7Sv3"
}

# Llave de GitHub Actions. La privada está en los secretos del repositorio.
deploy_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJfYwL7xDcskANIpYZPqlvme3sl+JmlCY3joMjGeooVr"
