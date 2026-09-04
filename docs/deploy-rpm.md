# Poner RPM en producción

Guía del despliegue completo: el CRM, el agente, la base, HTTPS y los
respaldos, en **un solo servidor**. Está pensada para seguirse de arriba a
abajo la primera vez.

Al final hay una sección de **operación** (mirar logs, actualizar, restaurar un
respaldo) para volver a consultar después.

---

## Lo que vas a necesitar

| Qué | Dónde | Costo aprox. |
|---|---|---|
| Un VPS Linux | Hostinger, Hetzner, DigitalOcean… | USD 5–15/mes |
| Un dominio | Namecheap, Cloudflare, NIC.ar… | USD 10–15/año |
| Cuenta de Meta for Developers con WhatsApp Business | developers.facebook.com | gratis |
| Créditos de LLM | openrouter.ai | ~USD 3 cada 1.000 conversaciones |

### Cuánto servidor hace falta

Medido sobre este stack, no estimado:

| | |
|---|---|
| Los cinco contenedores en reposo | **228 MB de RAM** |
| Imágenes en disco | ~1,1 GB |
| Construir la imagen del CRM | anda con **1 vCPU y 2 GB**, tarda ~7 min |

Con eso, un **Hostinger KVM 1** (1 vCPU, 4 GB, 50 GB NVMe) sobra: le queda más
de 3 GB libre con todo corriendo, y como el build sobrevive con 2 GB, actualizar
sin bajar el stack es seguro.

Lo único que se nota con 1 vCPU es el **tiempo de despliegue**: construir la
imagen tarda 6–7 minutos, contra uno o dos en una máquina con varios núcleos.
No falla, tarda. Durante ese rato el sitio sigue arriba: Docker recién
reemplaza cada servicio cuando su imagen nueva está lista.

Lo que NO se nota es la conversación: un turno del agente se va casi entero en
esperar al LLM, no en CPU. Si escriben varios leads a la vez, los turnos se
encolan unos milisegundos — con el volumen de un negocio de alquiler, invisible.

Con 1 GB de RAM, en cambio, el build del CRM sí se queda sin memoria.

### ¿Y Coolify?

Coolify es un panel que se instala EN tu VPS para manejar despliegues con
botones en vez de comandos. **No hace falta**: esta guía usa `docker compose`
directo, que es lo que Coolify termina ejecutando por debajo. Si ya tenés
Coolify andando y lo preferís, el `docker-compose.rpm.yml` funciona igual
pegándolo como un recurso de tipo "Docker Compose".

---

## 1. El servidor y el dominio

Creá el VPS con Ubuntu 24.04 e instalá Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

En el panel de tu dominio, creá **dos registros A** apuntando a la IP del
servidor:

| Nombre | Tipo | Valor |
|---|---|---|
| `crm` | A | la IP del VPS |
| `bot` | A | la IP del VPS |

> **Hacelo antes de levantar el stack.** Caddy pide los certificados TLS al
> arrancar y necesita que el DNS ya resuelva. Si levantás primero, Caddy falla,
> reintenta con espera creciente y podés quedarte diez minutos sin HTTPS
> mirando un log confuso.

Comprobá que propagó (puede tardar unos minutos):

```bash
dig +short crm.tudominio.com bot.tudominio.com
```

## 2. Traer el código

Los dos repos van **uno al lado del otro**: el compose construye el agente
desde `../nea-agent`.

```bash
git clone -b 017-inventario-maquinaria https://github.com/tomyesp/vocero-crm.git
git clone -b 017-maquinaria https://github.com/tomyesp/nea-agent.git
cd vocero-crm
```

> **La rama no es opcional.** En los dos forks, `main` sigue siendo el proyecto
> original: sin catálogo de maquinaria, sin las herramientas de alquiler del
> agente y sin `docker-compose.rpm.yml`. Si clonás sin `-b`, el primer comando
> del paso 4 falla con "no such file". Cuando estas ramas se fusionen a `main`,
> el `-b` sobra.

## 3. Configurar

```bash
sh deploy/generar-env.sh
```

Te pregunta cuatro cosas —los dos dominios, la API key de OpenRouter y tu
número de WhatsApp— y genera los seis secretos solo. Al terminar te muestra el
`VERIFY_TOKEN`, que es el que vas a pegar en Meta en el paso 6.

Se hace con script y no a mano por una razón concreta: **`VERIFY_TOKEN` y
`META_WEBHOOK_VERIFY_TOKEN` se llaman casi igual y hacen cosas distintas.**
El primero es el que Meta verifica; el segundo es el segmento secreto de la URL
interna por la que el agente le pasa el mensaje al CRM, y Meta no lo ve nunca.
Ponerles el mismo valor no rompe nada al levantar: el error aparece después,
cuando Meta rechaza el webhook sin explicar por qué.

Si preferís hacerlo a mano, `cp .env.example .env` y seguí las guías inline;
están todas ahí.

Dos cosas para tener presentes:

- **`ALLOWED_WA_IDS`** queda con tu número. Mientras esté ahí, el agente solo
  te contesta a vos. Vaciarla es "salir a producción", y es el paso 7.
- **`ENCRYPTION_KEY`** cifra el token de WhatsApp en la base. Si la cambiás,
  hay que volver a cargar la conexión de WhatsApp desde la UI.

## 4. Levantar

```bash
docker compose -f docker-compose.rpm.yml up -d --build
```

La primera vez tarda unos minutos (construye las dos imágenes). Cuando
termine:

```bash
docker compose -f docker-compose.rpm.yml ps
```

Los cinco servicios tienen que decir `healthy` o `Up`:

```
SERVICE    STATUS
app        Up (healthy)
backup     Up
caddy      Up (healthy)
nea        Up (healthy)
postgres   Up (healthy)
```

> Todos los comandos del stack llevan `-f docker-compose.rpm.yml`. Sin eso,
> Docker usa el `docker-compose.yml` de al lado, que es el de Vocero a secas
> (solo el CRM). Para no repetirlo:
> `export COMPOSE_FILE=docker-compose.rpm.yml`

## 5. Crear tu cuenta

Entrá a `https://crm.tudominio.com/register` y registrate. **Ese primer
registro crea la organización del negocio.**

Después de crearla, cerrá la puerta: poné `ALLOW_SIGNUP=` (vacío) en el `.env`
y `docker compose -f docker-compose.rpm.yml up -d app`. Si no, cualquiera que
llegue a la URL puede abrirse una cuenta.

> **Una instancia = una organización.** No crees una segunda a mano: el bot
> gateway resuelve "la organización de esta instancia" tomando la primera que
> encuentra, y con dos puede tomar la vacía. Pasó en desarrollo y el catálogo
> salía sin máquinas.

## 6. Conectar WhatsApp

En `Configuración → WhatsApp` cargá los tres datos de tu app de Meta:

| Dato | Dónde sacarlo |
|---|---|
| **WABA ID** | developers.facebook.com → tu app → WhatsApp → API Setup |
| **Phone Number ID** | ídem, debajo del número |
| **Token permanente** | Business Settings → Usuarios del sistema → generar token con `whatsapp_business_messaging` y `whatsapp_business_management` |

Estos tres **no van en el `.env`**: se guardan cifrados en la base (AES-256-GCM)
y por eso se cargan desde la pantalla. El CRM los valida contra Meta antes de
guardarlos, así que si algo está mal te lo dice en el momento en vez de fallar
callado el día que entre un lead.

Después, en Meta → WhatsApp → Configuration → Webhook:

- **Callback URL**: `https://bot.tudominio.com/webhook`
- **Verify token**: el `VERIFY_TOKEN` de tu `.env`
- Suscribite al campo **`messages`**

Meta hace una verificación en el momento; si el DNS y el token están bien, pasa
sola.

> El webhook apunta al **agente**, no al CRM. El agente le releva el mensaje
> crudo al CRM por la red interna de Docker y además decide la respuesta. De
> Nea solo se publica `/webhook`: todo lo demás responde 404 desde afuera.

## 7. Probar y salir a producción

Con tu número todavía en `ALLOWED_WA_IDS`, escribile al número del negocio
desde tu WhatsApp. Tenés que ver:

1. El mensaje en la bandeja del CRM, en tiempo real.
2. "Escribiendo…" y después la respuesta del agente.
3. Si pedís una máquina para unas fechas, la reserva tentativa en `/reservas`.

Si algo no aparece:

```bash
docker compose -f docker-compose.rpm.yml logs -f nea app
```

Cuando una conversación completa salga bien —incluida una reserva—, vaciá la
allowlist y recargá el agente:

```bash
# en .env:  ALLOWED_WA_IDS=
docker compose -f docker-compose.rpm.yml up -d nea
```

**Desde ese momento el agente le contesta a todos los leads.**

Antes de dar ese paso, cargá el catálogo real (`/maquinas` y `/tarifas`) y el
perfil del negocio. Un agente que atiende con el catálogo vacío no puede
ofrecer nada.

---

# Operación

## Ver qué está pasando

```bash
docker compose -f docker-compose.rpm.yml logs -f            # todo
docker compose -f docker-compose.rpm.yml logs -f nea        # solo el agente
docker compose -f docker-compose.rpm.yml logs --tail=200 app
```

En los logs del agente vas a ver una línea por turno con qué hizo y cuánto
tardó.

## Actualizar

```bash
cd vocero-crm && git pull
cd ../nea-agent && git pull
cd ../vocero-crm
docker compose -f docker-compose.rpm.yml up -d --build
```

Las migraciones de base corren solas al arrancar cada contenedor. No hace falta
bajar el stack: Docker reemplaza cada servicio cuando su imagen nueva está
lista.

## Espacio en disco

Los 50 GB de un KVM 1 alcanzan de sobra, pero tres cosas crecen con el tiempo:
los adjuntos de WhatsApp (volumen `rpm_media`), los respaldos (`rpm_backups`,
podados solos a los 14 días) y las imágenes viejas que deja cada actualización.

Las imágenes viejas son las únicas que no se limpian solas — cada rebuild deja
una de ~326 MB colgando. Después de actualizar:

```bash
docker image prune -f
```

Ver cómo va el disco:

```bash
df -h /
docker system df
```

## Respaldos

Un `pg_dump` comprimido de las dos bases, cada `BACKUP_EVERY_HOURS` (24 por
defecto), guardando `BACKUP_KEEP_DAYS` días (14). Viven en un volumen de
Docker.

Ver qué hay:

```bash
docker compose -f docker-compose.rpm.yml exec backup ls -lh /backups
```

**Bajarlos a tu máquina** (hacelo cada tanto: un respaldo que vive en el mismo
disco que la base no te salva de perder el servidor):

```bash
docker compose -f docker-compose.rpm.yml cp backup:/backups ./respaldos
```

### Restaurar

Esto borra la base actual y la reemplaza. Leelo entero antes de correrlo.

```bash
# 1. Bajar los servicios que escriben, dejando Postgres arriba
docker compose -f docker-compose.rpm.yml stop app nea

# 2. Recrear la base vacía (ejemplo con `vocero`)
docker compose -f docker-compose.rpm.yml exec postgres \
  psql -U postgres -c "DROP DATABASE vocero;"
docker compose -f docker-compose.rpm.yml exec postgres \
  psql -U postgres -c "CREATE DATABASE vocero;"

# 3. Cargar el dump
docker compose -f docker-compose.rpm.yml exec backup sh -c \
  'gunzip -c /backups/vocero-AAAAMMDD-HHMMSS.sql.gz | psql -d vocero'

# 4. Volver a levantar
docker compose -f docker-compose.rpm.yml start app nea
```

Para la base del agente es igual cambiando `vocero` por `nea`.

> **Ensayá una restauración una vez, en frío, antes de necesitarla.** Podés
> hacerlo sin riesgo restaurando sobre una base de prueba
> (`CREATE DATABASE prueba_restore;` y cargando el dump ahí). Un respaldo que
> nadie restauró nunca no es un respaldo: es un archivo.

## El Laboratorio en producción

El banco de pruebas funciona igual en el servidor y evalúa al agente real: en
`/lab` apretás "Correr evaluación" y ocho clientes simulados conversan con él.

Nada de eso toca WhatsApp ni el calendario real — las conversaciones son
`is_test` y las reservas viven en un calendario aparte. Cuesta unos centavos
de LLM por corrida.

Ojo con el score: lo pone un modelo y se mueve entre corridas aunque el agente
no cambie. Lo que se lee son los hallazgos con su transcripción.

## Costos que corren

| Concepto | Aprox. |
|---|---|
| VPS | USD 5–15/mes |
| LLM (agente) | ~USD 0,003 por conversación |
| WhatsApp | los leads que entran por anuncio son gratis las primeras 72 h |

Desde el 1/10/2026 Meta cobra los mensajes de servicio fuera de la ventana. Los
leads que llegan de un anuncio Click-to-WhatsApp mantienen su ventana gratuita
de 72 h, que es la mayoría del tráfico de este negocio.

---

## Problemas frecuentes

**Caddy no consigue certificado.** El DNS todavía no resuelve, o los puertos 80
y 443 están cerrados en el firewall del proveedor. Verificá con
`dig +short crm.tudominio.com` y abrí los dos puertos.

**Meta rechaza el webhook al darlo de alta.** El `VERIFY_TOKEN` del `.env` no
coincide con el que pegaste en Meta, o `bot.tudominio.com` todavía no tiene
HTTPS. Probalo vos:

```bash
curl "https://bot.tudominio.com/webhook?hub.mode=subscribe&hub.verify_token=TU_VERIFY_TOKEN&hub.challenge=probando"
```

Tiene que devolver `probando`.

**Entran mensajes pero no aparecen en la bandeja.** Falta cargar la conexión de
WhatsApp (paso 6). El CRM lo dice en sus logs:

```
[webhook] evento para phone_number_id desconocido (…): guarda la conexión en Configuración → WhatsApp
```

**El agente no contesta.** Por orden: ¿tu número está en `ALLOWED_WA_IDS`, o la
lista está vacía? ¿Hay créditos en OpenRouter? ¿Alguien tomó la conversación
desde la bandeja (handoff)? Los logs de `nea` dicen el motivo de cada silencio.

**El agente no ofrece máquinas.** Al arrancar sondea si el CRM tiene catálogo.
Si `INVENTARIO` no está en `on`, o el catálogo está vacío, no ofrece nada.
Buscá en los logs `inventario del CRM: disponible`.
