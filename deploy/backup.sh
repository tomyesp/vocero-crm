#!/bin/sh
# =============================================================================
# 017 Fase 8 — Respaldo de las dos bases, con retención.
#
# Un `pg_dump` comprimido de `vocero` y de `nea` cada BACKUP_EVERY_HOURS, a un
# volumen local. Sin S3 ni servicios de terceros (Constitución II): el respaldo
# queda en el disco del servidor, y sacarlo de ahí es una decisión del dueño.
#
# Un respaldo que nadie probó restaurar no es un respaldo. El procedimiento de
# restauración está en docs/deploy-rpm.md y conviene ensayarlo UNA vez, en
# frío, antes de necesitarlo.
#
# Hace el primer dump al arrancar (no espera un ciclo entero): así, si algo
# está mal configurado, se ve en los logs enseguida y no dentro de 24 horas.
# =============================================================================
set -e

DIR=/backups
EVERY_HOURS="${BACKUP_EVERY_HOURS:-24}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

mkdir -p "$DIR"

dump_one() {
	db="$1"
	stamp="$(date -u +%Y%m%d-%H%M%S)"
	tmp="$DIR/.${db}-${stamp}.sql.gz.partial"
	final="$DIR/${db}-${stamp}.sql.gz"

	# Se escribe a un .partial y se renombra al final: un dump cortado a la
	# mitad (contenedor reiniciado, disco lleno) NUNCA queda con nombre de
	# respaldo bueno. Encontrar eso el día de la restauración es peor que no
	# tener nada, porque uno cree que tiene.
	if pg_dump --no-owner --no-privileges "$db" | gzip -9 > "$tmp"; then
		mv "$tmp" "$final"
		echo "[backup] $final ($(du -h "$final" | cut -f1))"
	else
		rm -f "$tmp"
		echo "[backup] ERROR volcando '$db' — se conservan los respaldos anteriores" >&2
		return 1
	fi
}

while true; do
	ok=true
	dump_one vocero || ok=false
	dump_one nea || ok=false

	if [ "$ok" = true ]; then
		# La poda corre SOLO si los dos dumps salieron bien. Si hoy falló,
		# los viejos son lo único que hay: borrarlos por antigüedad mientras
		# el respaldo nuevo no existe es exactamente cómo se pierde todo.
		borrados=$(find "$DIR" -name '*.sql.gz' -type f -mtime +"$KEEP_DAYS" -print -delete | wc -l)
		[ "$borrados" -gt 0 ] && echo "[backup] podados $borrados respaldo(s) de más de $KEEP_DAYS días"
	else
		echo "[backup] hubo errores: NO se poda nada esta vuelta" >&2
	fi

	# Limpieza de restos de cortes anteriores (más de un día).
	find "$DIR" -name '.*.partial' -type f -mtime +1 -delete 2>/dev/null || true

	echo "[backup] próxima vuelta en ${EVERY_HOURS}h"
	sleep "$((EVERY_HOURS * 3600))"
done
