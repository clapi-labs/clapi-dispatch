variable "location" {
  type    = string
  default = "nbg1"
}

variable "server_type" {
  type    = string
  default = "cx23"
}

variable "admins" {
  type = map(string)
}

variable "deploy_public_key" {
  type = string
}
