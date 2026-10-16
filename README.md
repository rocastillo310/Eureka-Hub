# Centro Eureka Hub

Plataforma interna de la agencia creativa Eureka Hub: entregables, calendario, agendas, contactos de clientes y base de datos en un solo lugar. La usa solo el equipo.

> **¿Algo falla o hay que dar de alta a alguien?** Ve a [Operación](#operación-para-dirección).

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

**Trabajo simultáneo:** con `npm run dev` corriendo, `node scripts/prueba-concurrencia.mjs 4 40` simula a 4 personas a la vez: cada una crea sus tareas y todas editan y comentan la misma tarea. Al final comprueba que no se perdió ningún cambio (15 oct 2026: 320 cambios en 4 s, 0 perdidos). Cada elemento se guarda por separado, los cambios a un mismo elemento se mezclan campo por campo (`merge3`) y las listas (comentarios, historial) se suman.

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
- `CF_API_TOKEN`: token de API de la cuenta con **un solo permiso**: *Access: Policies Write*, limitado a esta cuenta. Ojo: *Access: Apps Write* no alcanza (sirve para aplicaciones, no para políticas) y Cloudflare responde 403 con código 1010. Lo crea Dirección en el dashboard y lo guarda con `npx wrangler secret put CF_API_TOKEN`; nunca se pega en el chat ni en el repositorio.

## Entregas (archivos)

Se suben desde la vista **Entregas** (o arrastrando archivos a cualquier pantalla) y quedan en el bucket privado `eureka-hub-entregas`. Nadie descarga directo del bucket: todo pasa por el Worker con la identidad ya verificada.

- **Subida en partes.** Un Worker no recibe peticiones de más de 100 MB (planes Free y Pro), así que el navegador manda el archivo en partes de 50 MiB por el Worker (`/api/entregas/iniciar`, `parte`, `completar`, `abortar`). R2 pide partes de al menos 5 MiB, todas iguales salvo la última, y como máximo 10,000. Un reel de 4 GB son 82 partes. Cada parte se reintenta sola 4 veces; después aparece «Reintentar», que manda solo las que faltan.
- **Máximo por archivo:** `MAX_ARCHIVO_MB` en `wrangler.jsonc` (4096 = 4 GB).
- **Tipos aceptados:** la lista está en `src/entregas.js` (`TIPOS_ARCHIVO`). El tipo se decide por la extensión en el servidor; ejecutables, páginas web y similares se rechazan. Se ven dentro de la app imágenes, video, audio y PDF; lo demás (incluido SVG) solo se descarga.
- **Versiones:** subir sobre una entrega crea la versión siguiente y conserva las anteriores. La llave en R2 la arma el servidor: `entregas/{cuenta}/{entrega}/{versión}-{nombre-seguro}`.
- **Borrado:** solo Dirección o quien creó la entrega. Primero va a la papelera (no toca R2); «Borrar para siempre» pide escribir BORRAR, borra todas sus versiones de R2 y queda en la actividad.
- **Almacenamiento:** Ajustes muestra lo usado contra los 10 GB gratis de R2 (son de toda la cuenta de Cloudflare) y avisa desde el 80 %. Lo que pase se cobra por GB al mes; descargar no cuesta.
- Las subidas que se quedan a medias las cancela R2 solo a los 7 días.

## Tareas: lo obligatorio

**Área «Tareas»** (menú): las de cada quien, las que asignó y las de todo el equipo, por fecha (atrasadas, hoy, próximos 7 días, más adelante). Sirve para cualquier área: la **tarea general** (`type: "general"`) no tiene lista ni formato, la cuenta es opcional y sus etapas son fijas: Pendiente → En proceso → En revisión → Hecha (`STAT_GENERAL`, no se sincroniza como `stat`). Sus archivos se suben sin elegir cuenta (en R2 bajo `entregas/general/`). Las tareas de redes y diseño siguen en las listas de cada cuenta; «Nueva tarea» pregunta el tipo de trabajo y es general por defecto.


Toda tarea creada a mano («Nueva tarea», la fila rápida de una lista, el formulario de solicitudes) exige **a quién se le asigna** (la persona o uno mismo), **qué tiene que hacer** y **para cuándo**. La fila rápida ya no crea la tarea solo con el título: abre el formulario con lo escrito. Al crearla se pueden adjuntar archivos (PDF, presentaciones, documentos…): se suben como entregas ligadas a la tarea y se ven en su sección «Archivos y entregas», con versiones y aprobación. Las tareas que crea el sistema (calendario aprobado, pendientes de junta, nota de la pizarra) toman su responsable de la cuenta o de la nota; si alguna queda sin nadie, la tarea lo avisa.

## Área general y aprobaciones (F3)

- **Área general** es la pantalla de inicio: la actividad del equipo (entregas, aprobaciones, tareas creadas, movidas o asignadas) y «Quién tiene qué» (tareas abiertas por persona contra su capacidad).
- **«Ya se realizó» / «hecha»:** las actividades del equipo tienen una casilla «Ya se realizó» (Mi día, Área general, Agenda y su formulario); quedan tachadas con quién las marcó. Las tareas tienen casilla en «Tareas», Mi día y dentro de la tarea: marcarla la pasa a su etapa final; desmarcarla la regresa a la anterior.
- **Limpieza semanal:** cada lunes a las 0:00 en Guadalajara (cron `0 6 * * 1`, `src/semanal.js`), las actividades de tareas en su etapa final o borradas y de entregas aprobadas, en la papelera o borradas salen de «Actividad del equipo» y pasan a su pestaña «Historial» (se marcan `archivada`, no se borran). Cada limpieza queda en el historial del panel de administración.
- **Actividad:** solo se añade. El servidor la crea para entregas y aprobaciones; la pantalla la crea para tareas, pero el servidor pone quién y cuándo, y no deja editarla ni borrarla.
- **Aprobación:** aprueba quien tiene «Aprueba entregas» en Equipo (`POST /api/entregas/decidir`). «Pedir cambios» exige comentario y regresa la entrega a quien la subió. Una versión nueva vuelve a «pendiente»; las decisiones de cada versión se conservan.
- **Ajustes de aprobación** (solo Dirección): una o todas las aprobaciones, y si quien sube puede aprobar lo suyo. Valores iniciales **provisionales**: basta una y no puede aprobar lo suyo.
- **Avisos en la Bandeja:** a quienes aprueban cuando llega una entrega o una versión; a quien la subió cuando le piden cambios o queda aprobada; a cada quien por sus pendientes de junta.
- **Pendientes de junta:** se pega el mensaje de la junta (`@Nombre:` y pendientes con viñetas). Cada pendiente se vuelve tarea asignada en la cuenta que se menciona, o tarea personal en la Agenda si no hay cuenta.

## Contactos (F4)

- Vista **Contactos**: la base de datos de clientes (nombre, cargo, empresa, correo, teléfono y notas). La cuenta del Hub es opcional (prospectos, proveedores o empresas que no son cuenta); el filtro tiene «Sin cuenta». Búsqueda en todas las cuentas, filtro por cuenta, y en cada cuenta su lista de contactos. Correo y WhatsApp con un toque.
- **Permisos:** cualquiera del equipo agrega y edita; borrar lo hace Dirección o quien lo agregó. El servidor valida los campos (`src/contactos.js`) y pone quién y cuándo lo creó.
- **CSV:** exportar (lo que se ve con el filtro) e importar. Columnas: `Cuenta, Nombre, Cargo, Correo, Teléfono, Notas`; solo «Nombre» es obligatorio. Acepta coma, punto y coma o tabulador (Excel en español usa punto y coma). Antes de importar muestra qué se crea, qué se actualiza (mismo correo, o mismo nombre sin correo, en esa cuenta) y qué filas tienen error; nunca borra ni crea cuentas. Al exportar, un dato que empiece con `=`, `@` u otro carácter de fórmula sale con un apóstrofo para que Excel no lo ejecute.
- Son datos personales de clientes: viven solo en D1. Nunca se commitean ni se pegan en el chat.

## Tema

Ajustes → **Apariencia**: claro, oscuro o «como el sistema». Se guarda por persona y se aplica antes de pintar la pantalla.

## Panel de administración y niveles

Tres niveles:

| Nivel | Quién | Qué puede |
|---|---|---|
| **Administración** | Rodrigo y Dani (`nivel: "administracion"` en su usuario) | Todo, más el panel: personas (alta, baja, nivel, rol, quién aprueba), reglas de aprobación, Google Calendar, almacenamiento, eliminar cuentas e historial. |
| **Dirección** | rol `admin` sin nivel (hoy, Jessy) | Cuentas, listas, tareas, entregas, automatizaciones, estados y columnas de la pizarra. |
| **Equipo** | los demás | Su trabajo, como hasta ahora. |

- El panel vive en **`/admin`** (la misma app); se entra desde Ajustes → «Abrir panel de administración». Cloudflare Access lo protege con **otra aplicación y otra política** que solo permite los correos de Administración, así que vuelve a pedir correo y código. Además, el servidor revisa el nivel en cada cambio (`src/api.js`: `SOLO_ADMINISTRACION`, `esAdministracion`).
- Siempre queda al menos una persona de Administración activa y nadie se da de baja a sí mismo.
- Al cambiar el nivel de alguien, el Worker actualiza también la política del panel (secreto `ACCESS_POLITICA_ADMIN_ID`).
- **Historial:** tabla `bitacora` (migración `0003`), solo se añade; lo leen Administración en `/api/admin/bitacora`. No se sincroniza a las pantallas del resto.
- **Respaldo:** solo lo ve y lo lanza la persona de `RESPALDO_DUENO` (variable en `wrangler.jsonc`, hoy `rodrigo`), y solo ella recibe el aviso si falla. Se cambia en Cloudflare, no en el panel, para que nadie se dé ese permiso desde el Hub.

## Invitaciones de Google Calendar

Cuando una actividad de la Agenda es **«Para todo el equipo»** y tiene **enlace de reunión** (Google Meet u otro), el Worker crea el evento en el Google Calendar de la cuenta que conectó Dirección e invita a cada persona activa del equipo. **Google les manda el correo de invitación** y les queda en su calendario con recordatorio. Cambiar fecha, hora, título o enlace actualiza la invitación; borrar la actividad o quitarle el enlace la cancela. Editar solo las notas no vuelve a mandar correos. Quien está dado de baja no recibe invitaciones.

- Código: `src/calendario.js`. Zona horaria: Guadalajara; duración: 1 hora (sin hora, evento de todo el día).
- La llave para usar el calendario la guarda el Worker en `meta` al conectar; las claves `google…` nunca entran al respaldo.
- Sin costo: usa la API de Google Calendar con la cuenta de Google de Dirección.

### Configurar (una vez, lo hace Dirección)

1. <https://console.cloud.google.com> → crea un proyecto (p. ej., «Eureka Hub»).
2. APIs y servicios → Biblioteca → **Google Calendar API** → Habilitar.
3. **Google Auth Platform** (pantalla de consentimiento) → Comenzar: nombre «Eureka Hub», tu correo de soporte, público **Externo**, correo de contacto → Crear.
4. **Acceso a los datos** → Agregar permisos → `.../auth/calendar.events` → Guardar.
5. **Público** → **Publicar app** (queda «En producción»). Si se queda en «Prueba», Google retira el permiso a los 7 días.
6. **Clientes** → Crear cliente → **Aplicación web** → en «URI de redireccionamiento autorizados» pon `https://eureka-hub.<subdominio>.workers.dev/api/google/callback` → Crear. Copia el ID y el secreto del cliente (no los pegues en el chat ni en el repo).
7. Guárdalos como secretos del Worker:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

8. En el Hub: Panel de administración → «Integraciones y respaldo» → **Conectar Google Calendar** → elige la cuenta desde la que saldrán las invitaciones. Google avisa «Google no verificó esta app» (es normal en una app interna): Configuración avanzada → Ir a Eureka Hub → permite ver y editar eventos → Continuar. Al volver, se mandan solas las invitaciones de las reuniones del equipo que aún no pasan.

Si Google retira el permiso (cambias la contraseña, lo quitas en tu cuenta de Google), Ajustes muestra el error: vuelve a dar «Conectar Google Calendar».

## Respaldo y restauración (F5)

Cada día a las **3:00 a. m. (Guadalajara)** el Worker guarda en el repo **privado** `rocastillo310/eureka-hub-backups`, en un solo commit:

- `datos/AAAA-MM-DD.json`: la base completa (también lo borrado), lista para restaurar.
- `archivos-r2/AAAA-MM-DD.json`: la lista de archivos de Entregas en R2 (llave, tamaño y huella). **Los archivos no se copian** (ver abajo).

Antes de escribir, el Worker revisa por la API de GitHub que el repo exista, sea el configurado y sea **privado**; si no, **aborta sin mandar nada**. Cada resultado queda en el Panel de administración → «Integraciones y respaldo» → «Respaldo de la base», con botón «Respaldar ahora»; ese panel y el aviso de falla son solo para la persona de `RESPALDO_DUENO`.

Los Cron Triggers corren en UTC: `0 9 * * *` en `wrangler.jsonc` son las 3:00 a. m. en Guadalajara (UTC−6, sin horario de verano). El mismo cron, después del respaldo, vacía la papelera de la Pizarra Kanban (notas con 7 días o más; `src/limpieza.js`).

### Conectar GitHub (una vez, lo hace Dirección)

1. Crea el repo: <https://github.com/new> → nombre `eureka-hub-backups` → **Private** → Create repository.
2. Crea el token: GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
   - Nombre: `eureka-hub-respaldo`. Vencimiento: 1 año (pon un recordatorio; si vence, el respaldo falla y llega el aviso).
   - Repository access: **Only select repositories** → `eureka-hub-backups`.
   - Permissions → Repository permissions → **Contents: Read and write** (Metadata queda en lectura sola).
3. Guárdalo como secreto del Worker (pega el token cuando lo pida; nunca en el chat ni en el repo):

```bash
npx wrangler secret put GITHUB_TOKEN_RESPALDO
```

En Windows, si PowerShell bloquea `npx`, usa `npx.cmd`.

### Restaurar

Descarga el `datos/AAAA-MM-DD.json` que quieras del repo de respaldos (o haz una copia al momento con `npm run respaldo -- --remote`) y:

```bash
npm run restore -- respaldos/2026-10-13.json
```

Eso restaura la base **local**. Para **producción**:

```bash
npm run restore -- respaldos/2026-10-13.json --remote --si-produccion
```

- Antes de tocar producción guarda una copia de cómo estaba en `respaldos/antes-de-restaurar-….json` (para deshacer).
- Deja la base igual al respaldo: lo que cambió se regresa y lo creado después queda borrado. Al final **compara** la base contra el respaldo y avisa si algo no coincide.
- Las pantallas abiertas reciben los cambios solas en su siguiente sincronización.
- Los registros grandes (más de 100 KB, el máximo por sentencia de D1) se escriben en pedazos.
- `respaldos/` está fuera de git: los respaldos llevan datos personales.

Probado de punta a punta en la base local: exportar 68 elementos (uno de 240 KB), vaciar la base, restaurar y comparar: idénticos.

### Límite: los archivos de R2 no quedan en GitHub

GitHub bloquea archivos de más de 100 MiB y advierte desde 50 MiB (documentación de GitHub, «About large files on GitHub»), y un reel pesa hasta 4 GB. Por eso el respaldo diario guarda solo la **lista** de archivos (para saber qué había y comprobar una copia), no los archivos.

**Propuesta (sin implementar, falta tu decisión):** copia semanal de los archivos de R2 a la unidad compartida de Google Drive del equipo con [rclone](https://rclone.org/), que copia solo lo nuevo o cambiado, programada en una computadora de la oficina. Ventajas: el equipo ya vive en Drive y su espacio probablemente ya está pagado; la copia queda fuera de Cloudflare (protege si algo le pasa a la cuenta). Necesita un token de R2 de solo lectura y conectar rclone a Drive una vez. Alternativas: un segundo bucket de R2 (simple, pero cuenta contra los mismos 10 GB gratis y no protege si falla la cuenta) o Backblaze B2 (barato, otro proveedor más).

## Operación (para Dirección)

Lo del día a día: dar de alta a alguien, qué hacer si algo falla y cómo regresar los datos. Los comandos se corren en PowerShell desde la carpeta del proyecto, con la cuenta puesta:

```bash
$env:CLOUDFLARE_ACCOUNT_ID="<id de la cuenta>"
```

En Windows usa `npx.cmd` si PowerShell bloquea `npx`.

### Dar de alta a alguien

1. Entra al **Panel de administración** (`/admin`) → «Personas y permisos» → «Agregar persona».
   - **Nombre** y **Usuario** (corto, sin espacios, p. ej. `benja`; es su identificador interno y no se cambia después).
   - **Rol** y **Correo con el que entra**: el correo donde le llegará el código para entrar.
   - **Cuentas a las que se suma** y, si aplica, marca «Aprueba entregas» en su fila.
2. El correo se agrega solo a la política de Cloudflare Access. Si sale el aviso «Cloudflare Access no se actualizó», agrégalo a mano: dashboard de Cloudflare → Zero Trust → Access → Policies → la política del Hub → Include → Emails → agrega el correo → Save. Luego revisa el token (ver la tabla de abajo).
3. La persona abre la dirección del Hub, escribe su correo, recibe un código de un solo uso y lo pega. Listo.

### Dar de baja a alguien

Panel de administración → «Personas y permisos» → en su fila, «Dar de baja» → toca de nuevo para confirmar.

- Pierde el acceso al momento: el servidor ya no la deja entrar y su correo sale de la política de Access.
- No se borra: su nombre se conserva en el historial, actividad y comentarios. Deja de aparecer para asignar, mencionar, avisar o aprobar, y sale del equipo de cada cuenta.
- Sus tareas abiertas siguen asignadas y aparecen en «Quién tiene qué» marcadas «de baja, reasígnalas».
- «Reactivar» (en «Dados de baja», abajo de la lista) le devuelve el acceso. Vuelve a marcar «Aprueba entregas» y su lugar en las cuentas si hace falta.
- Nadie se da de baja a sí mismo y siempre queda al menos una persona de Dirección activa (lo revisa el servidor).

### Si algo falla

| Lo que ves | Qué significa | Qué hacer |
|---|---|---|
| «Sin conexión con el servidor…» | No hay internet o el servidor no responde. Tus cambios siguen en la pantalla. | No cierres la pestaña; se guardan solos al volver. Si dura más de 5 minutos, revisa <https://www.cloudflarestatus.com>. |
| «No se pudo guardar: …» | El servidor respondió con un error. | Se vuelve a intentar solo. Si no se quita, recarga. Si se repite, manda captura y revisa los registros (abajo). |
| «No se guardó un cambio: …» | El servidor rechazó ese cambio (p. ej., solo Dirección puede hacerlo) y lo regresó a como estaba. | Lee el motivo; no es una falla. |
| «Tu sesión terminó» | Venció la sesión de Cloudflare Access. | Recarga y vuelve a entrar con el código. |
| «Algo falló al mostrar esta pantalla» | La pantalla no pudo mostrar algún dato. Los datos están a salvo en el servidor. | «Volver al inicio». Si se repite, manda el mensaje que aparece. |
| Access no deja entrar a alguien, o dice «Ese correo no está dado de alta» | Su correo no está en la política de Access o no está en **Equipo** (tienen que ser el mismo). | Revisa los dos; corrige el correo en el que falte. |
| Aviso «Cloudflare Access no se actualizó» | El token `CF_API_TOKEN` venció o perdió el permiso *Access: Policies Write*. | Agrega el correo a mano (arriba), renueva el token en el dashboard y guárdalo: `npx wrangler secret put CF_API_TOKEN`. |
| Aviso en la Bandeja «El respaldo diario falló: …» | Venció el token de GitHub, cambió el repo o dejó de ser privado (el Worker aborta antes de mandar datos). | Panel de administración → «Integraciones y respaldo» → «Respaldo de la base» (solo Rodrigo) dice el motivo. Renueva el token ([Conectar GitHub](#conectar-github-una-vez-lo-hace-dirección)) y da «Respaldar ahora». |
| No llegan las invitaciones de una reunión | Google Calendar no está conectado o Google retiró el permiso. | Panel de administración → «Integraciones y respaldo» dice el motivo; da «Conectar Google Calendar». Solo invita a actividades «Para todo el equipo» con enlace. |
| Una subida se detiene | Se cortó la conexión a medio archivo. | «Reintentar» manda solo las partes que faltan. Más de 4 GB no se acepta. |
| Aviso de almacenamiento al 80 % | Las entregas se acercan a los 10 GB gratis de R2. | Vacía la papelera de Entregas o decide si se paga el excedente. |

**Fechas para el calendario:** el token de GitHub del respaldo vence el **15 de octubre de 2027**; revisa en el dashboard cuándo vence `CF_API_TOKEN`. Renueva cada uno unos días antes.

### Ver qué pasó (registros)

Los errores del servidor quedan registrados (no se le muestran a la persona). Para verlos en vivo mientras alguien repite el problema:

```bash
npx wrangler tail
```

O en el dashboard: Workers → `eureka-hub` → Logs.

### Regresar a la versión anterior del código

Si algo se rompe justo después de desplegar:

```bash
npx wrangler deployments list
```

```bash
npx wrangler rollback
```

`rollback` regresa a la versión anterior del Worker en segundos. Solo cambia el código: no toca la base ni los archivos.

### Regresar los datos

Para recuperar la base de un día anterior, sigue [Restaurar](#restaurar). El respaldo de cada día está en el repo privado de respaldos, en `datos/AAAA-MM-DD.json`; se descarga con:

```bash
gh api repos/<dueño>/eureka-hub-backups/contents/datos/AAAA-MM-DD.json -H "Accept: application/vnd.github.raw" > respaldos/AAAA-MM-DD.json
```

Restaura primero en local para revisar que sea el que buscas y después en producción. Borra la copia local al terminar: lleva datos personales.

### Límites

| Qué | Límite | Qué pasa al pasarlo |
|---|---|---|
| Archivo de entrega | 4 GB (`MAX_ARCHIVO_MB`) | No se acepta y se dice por qué. |
| Un elemento (tarea, tablero con imágenes…) | 1.5 MB | Ese cambio no se guarda y aparece el motivo; lo demás sí se guarda. |
| Cambios por envío | 300 | La pantalla manda de 250 en 250 (p. ej., una importación grande). |
| Almacenamiento de entregas | 10 GB gratis de R2 | Aviso desde el 80 %; el excedente se cobra por GB al mes. |

## Desplegar

Si hay migraciones nuevas en `migrations/`, primero se aplican a la base de producción:

```bash
npx wrangler d1 migrations apply eureka-hub-db --remote
```

```bash
npm run deploy
```

## Estructura

```
src/            Worker: index.js (entrada y cron), api.js (rutas), entregas.js (archivos en R2), respaldo.js y formato-respaldo.js (F5), calendario.js (invitaciones de Google), limpieza.js, contactos.js, entidades.js, merge3.js, access.js, access-politica.js
public/         la app (prototipo sin datos de ejemplo, en modo servidor)
migrations/     migraciones de D1
seed/           base.json (configuración inicial); equipo.local.json fuera de git
scripts/        seed-equipo.mjs, respaldo.mjs, restaurar.mjs
tests/          pruebas (node --test)
docs/prototipo/ prototipo original de referencia (fuera de git)
```

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| F0 | Estructura, D1 y R2 creados, "hola" desplegado detrás de Access | hecho |
| F1 | `/api/yo`, `bootstrap`, `sync`, `merge3`, migraciones, equipo | hecho |
| F2 | Entregas con R2 | hecho (falta la prueba con un video real en producción) |
| F3 | Área general, aprobaciones, inbox (y pendientes de junta) | hecho |
| F4 | Contactos y base de datos (y tema claro u oscuro) | hecho |
| F5 | Respaldo y restauración | hecho (repo privado conectado el 15 oct 2026) |
| F6 | Endurecimiento (errores visibles, teclado, contraste) y README de operación | hecho |
