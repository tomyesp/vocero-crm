#!/bin/sh
# =============================================================================
# 017 Fase 8 — Arma el .env de producción con secretos nuevos.
#
# Se corre UNA vez, en el servidor, antes de levantar el stack:
#
#     sh deploy/generar-env.sh
#
# Genera los seis secretos con `openssl rand` (nadie los tipea, nadie los
# reutiliza de otro lado) y pregunta lo poco que no se puede adivinar: los dos
# dominios, la key del LLM y tu número de WhatsApp para las pruebas.
#
# Por qué existe: el paso de llenar el .env a mano es el más propenso a errores
# de todo el despliegue. Hay SEIS secretos, y dos de ellos —VERIFY_TOKEN y
# META_WEBHOOK_VERIFY_TOKEN— se llaman casi igual y hacen cosas distintas.
# Ponerles el mismo valor "no falla": el stack levanta igual y el error recién
# aparece cuando Meta rechaza el webhook, sin decir por qué.
#
# NO pisa un .env existente. Si ya tenés uno, este script no te lo toca.
# =============================================================================
set -e

if [ -f .env ]; then
	echo "Ya existe un .env acá. Este script no lo pisa."
	echo "Si querés empezar de cero: mv .env .env.viejo && sh deploy/generar-env.sh"
	exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
	echo "Falta openssl. Instalalo con:  apt-get update && apt-get install -y openssl"
	exit 1
fi

echo "=============================================="
echo " Configuración de RPM — se hace una sola vez"
echo "=============================================="
echo

pedir() {
	# $1 = texto, $2 = ejemplo, $3 = nombre de la variable a exportar
	while true; do
		printf "%s\n  (ej: %s)\n> " "$1" "$2"
		read -r valor
		[ -n "$valor" ] && break
		echo "  No puede quedar vacío."
	done
	eval "$3=\$valor"
	echo
}

pedir "Dominio del CRM — donde vas a entrar vos a trabajar" \
	"crm.rpmconstrucciones.com" DOM_CRM
pedir "Dominio del agente — la URL que le vas a dar a Meta como webhook" \
	"bot.rpmconstrucciones.com" DOM_BOT
pedir "API key de OpenRouter (openrouter.ai → Keys)" \
	"sk-or-v1-..." LLM_KEY
pedir "TU número de WhatsApp, para probar antes de salir a producción
  Con código de país y sin el +. Mientras esté acá, el agente SOLO te contesta a vos" \
	"5493511111111" MI_NUMERO

cat > .env <<EOF
# Generado por deploy/generar-env.sh el $(date -u +"%Y-%m-%d %H:%M UTC").
# Los secretos son de esta instalación y no se comparten con nadie.

# --- Dominios ----------------------------------------------------------------
DOMAIN=$DOM_CRM
BOT_DOMAIN=$DOM_BOT
APP_BASE_URL=https://$DOM_CRM

# --- Base de datos -----------------------------------------------------------
POSTGRES_PASSWORD=$(openssl rand -hex 24)

# --- Secretos de la aplicación -----------------------------------------------
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
# Cifra el token de WhatsApp en la base. Si la cambiás, hay que volver a cargar
# la conexión de WhatsApp desde la UI.
ENCRYPTION_KEY=$(openssl rand -base64 32)

# --- Los dos verify tokens (SON DISTINTOS A PROPÓSITO) -----------------------
# El que Meta verifica al dar de alta el webhook. Este va en developers.facebook.com.
VERIFY_TOKEN=$(openssl rand -hex 32)
# El segmento secreto de la URL interna por la que el agente le pasa el mensaje
# al CRM. Meta no lo ve nunca.
META_WEBHOOK_VERIFY_TOKEN=$(openssl rand -hex 32)
# App Secret de tu app de Meta (Configuración → Básica). Opcional pero
# recomendado: con valor, se verifica la firma de cada webhook.
META_APP_SECRET=
META_GRAPH_API_VERSION=v25.0

# --- Bot gateway -------------------------------------------------------------
BOT_API_KEY=$(openssl rand -hex 32)

# --- LLM ---------------------------------------------------------------------
OPENAI_API_KEY=$LLM_KEY
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=openai/gpt-4o-mini
AUDIO_MODEL=google/gemini-2.5-flash-lite
HISTORY_WINDOW=10

# El CRM usa el mismo proveedor para el Laboratorio.
OPENROUTER_API_TOKEN=$LLM_KEY
OPENROUTER_BASE_URL=https://openrouter.ai/api
OPENROUTER_MODEL=openai/gpt-4o-mini
# El juez del Laboratorio necesita razonar sobre una rúbrica larga: no le
# pongas el mismo modelo chico que conversa.
OPENROUTER_JUDGE_MODEL=anthropic/claude-haiku-4.5

# --- Guardarraíles -----------------------------------------------------------
# Mientras tenga tu número, el agente SOLO te contesta a vos. Vaciarla es
# "salir a producción" — recién cuando hayas visto una conversación completa.
ALLOWED_WA_IDS=$MI_NUMERO
TESTER_WA_IDS=$MI_NUMERO
COALESCE_SECONDS=4
TYPING_DELAY_SECONDS=0.5
FOLLOWUP_HOURS=4
AGENT_NAME=Nea
AGENT_TIMEZONE=America/Argentina/Buenos_Aires

# --- Módulos -----------------------------------------------------------------
INVENTARIO=on
ATRIBUCION=on

# --- Registro ----------------------------------------------------------------
# Abierto para que puedas crear TU cuenta. Apagalo (vacío) apenas la crees.
ALLOW_SIGNUP=on
AGENT_COALESCE_MS=6000
MEDIA_DIR=/data/media

# --- Respaldos ---------------------------------------------------------------
BACKUP_EVERY_HOURS=24
BACKUP_KEEP_DAYS=14
EOF

chmod 600 .env

echo "=============================================="
echo " Listo: .env creado (solo lo puede leer root)"
echo "=============================================="
echo
echo "Antes de levantar, revisá que estos dos dominios ya resuelvan a este servidor:"
echo "  $DOM_CRM"
echo "  $DOM_BOT"
echo
echo "Después:"
echo "  docker compose -f docker-compose.rpm.yml up -d --build"
echo
echo "Este es el token que después vas a pegar en Meta como Verify Token:"
grep '^VERIFY_TOKEN=' .env | cut -d= -f2
echo
