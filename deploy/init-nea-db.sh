#!/bin/sh
# =============================================================================
# 017 Fase 8 — Crea la base del agente en el primer arranque de Postgres.
#
# La imagen oficial solo crea la de POSTGRES_DB (`vocero`). El agente lleva su
# propia memoria en `nea`, en el mismo motor pero en otra base: son dos
# servicios que no comparten una sola tabla, y mezclarlas invitaría a que
# alguien haga un JOIN entre ellas y ate lo que el diseño dejó suelto a
# propósito.
#
# Solo corre con el volumen VACÍO (comportamiento de docker-entrypoint-initdb.d).
# Es idempotente igual, por si alguien lo ejecuta a mano.
# =============================================================================
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	SELECT 'CREATE DATABASE nea'
	WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'nea')\gexec
EOSQL

echo "[init] base 'nea' lista"
