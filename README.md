# Centro Eureka Hub

Plataforma interna de la agencia creativa Eureka Hub: entregables, calendario, agendas, contactos de clientes y base de datos en un solo lugar. La usa solo el equipo.

> **Repositorio público.** Aquí va el código, nunca los datos: ni correos del equipo, ni contactos de clientes, ni tokens, ni exportaciones de la base. Los secretos viven como secretos de Cloudflare.

## Arquitectura

- **Un Worker** (`eureka-hub`) que sirve `public/` y las rutas `/api`.
- **D1** (`eureka-hub-db`): la base de datos.
- **R2** (`eureka-hub-entregas`): bucket privado para los archivos entregados. Toda descarga pasa por el Worker.
- **Cloudflare Access** frente al Worker; el Worker además valida el JWT de Access (desde F1).
- Dominio: `eureka-hub.<subdominio>.workers.dev` por ahora.

## Herramientas

- **wrangler** (dependencia del proyecto): correr y desplegar el Worker. Lee `wrangler.jsonc`.
- **cf** (CLI de Cloudflare, global): crear y consultar recursos de la cuenta (D1, R2, Access).
- **gh**: ramas y pull requests.

La cuenta de Cloudflare se toma de la variable `CLOUDFLARE_ACCOUNT_ID`; no se escribe en el repositorio.

## Correr en local

Requisito: Node.js 22.18 o superior.

1. Crea `.dev.vars` (fuera de git) con la línea `DEV_LOGIN=1`. Activa el selector de usuario de desarrollo.
2. Crea `seed/equipo.local.json` (ver "Dar de alta al equipo") y carga la base local:

```bash
npm install
npm run seed:equipo
npm run dev
```

Abre <http://localhost:8787> y entra escribiendo el usuario (por ejemplo `rodrigo`), sin contraseña.

**Modo desarrollo:** el encabezado `X-Dev-User` solo funciona si `DEV_LOGIN=1` **y** la petición llega a `localhost`. En producción es imposible activarlo (lo comprueba `tests/api.test.js`).

## Pruebas

```bash
npm test
```

Cubren la mezcla de tres vías (`merge3`, servidor y copia de la pantalla), la verificación del JWT de Access, los permisos del servidor, el modo desarrollo y la sincronización entre dos personas.

## Dar de alta al equipo

El equipo real vive en `seed/equipo.local.json`, que **nunca** se commitea:

```json
{ "equipo": [ { "id": "usuario", "name": "Nombre", "email": "correo@dominio", "role": "admin", "aprueba": true } ] }
```

- `role`: `admin`, `community`, `diseno` o `""` (por definir). Al menos una persona debe ser `admin`.
- La carga es repetible: lo que ya existe no se sobrescribe.
- Local: `npm run seed:equipo`. Producción: `npm run seed:equipo -- --remote`.
- Ya con la app en uso, Dirección agrega personas desde la pantalla **Equipo**. Con la conexión automática configurada (abajo), su correo se agrega solo a la política de Cloudflare Access; si no, la app avisa que falta hacerlo a mano.

Las cuentas (clientes) se cargan igual desde `seed/cuentas.local.json`, también fuera de git: `{ "cuentas": [ { "id": "a-cliente", "name": "Cliente", "drive": "https://drive.google.com/drive/folders/…" } ] }`. Cada una nace con dos listas (redes del mes y diseño) y el equipo sin asignar.

## Cloudflare Access

El Worker valida el JWT de Access (firma con las llaves del equipo de Zero Trust, `aud`, emisor y vencimiento). Necesita dos secretos:

```bash
npx wrangler secret put ACCESS_EQUIPO
npx wrangler secret put ACCESS_AUD
```

- `ACCESS_EQUIPO`: el nombre del equipo de Zero Trust (lo que va antes de `.cloudflareaccess.com`).
- `ACCESS_AUD`: la etiqueta AUD de la aplicación de Access del Worker.

Sin ellos, la API falla cerrado: nadie ve datos.

### Conexión automática con la política de Access

Cuando Dirección agrega o cambia a alguien en **Equipo**, el Worker deja la lista de correos de la política de Access igual a la del equipo (conserva el resto de la política). Necesita tres secretos:

- `CF_ACCOUNT_ID`: id de la cuenta de Cloudflare.
- `ACCESS_POLITICA_ID`: id de la política reutilizable de Access de la app.
- `CF_API_TOKEN`: token de API con **un solo permiso**: *Account · Access: Apps and Policies · Edit*, limitado a esta cuenta. Lo crea Dirección en el dashboard y lo guarda con `npx wrangler secret put CF_API_TOKEN`; nunca se pega en el chat ni en el repositorio.

## Desplegar

```bash
npm run deploy
```

## Estructura

```
src/            Worker: index.js (entrada), api.js (rutas), merge3.js, access.js
public/         la app (prototipo sin datos de ejemplo, en modo servidor)
migrations/     migraciones de D1
seed/           base.json (configuración inicial); equipo.local.json fuera de git
scripts/        seed-equipo.mjs
tests/          pruebas (node --test)
docs/prototipo/ prototipo original de referencia (fuera de git)
```

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| F0 | Estructura, D1 y R2 creados, "hola" desplegado detrás de Access | hecho |
| F1 | `/api/yo`, `bootstrap`, `sync`, `merge3`, migraciones, equipo | hecho |
| F2 | Entregas con R2 | pendiente |
| F3 | Área general, aprobaciones, inbox | pendiente |
| F4 | Contactos y base de datos | pendiente |
| F5 | Respaldo y restauración | pendiente |
| F6 | Endurecimiento y README de operación | pendiente |
