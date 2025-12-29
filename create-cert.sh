#!/bin/bash
# Create self-signed certificate for local HTTPS development
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/C=US/ST=Local/L=Local/O=Dev/CN=172.20.10.14"