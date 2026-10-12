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

```bash
npm install
npm run dev
```

Abre <http://localhost:8787>. `GET /api/salud` responde `{"ok":true}`.

## Desplegar

```bash
npm run deploy
```

## Estructura

```
src/            Worker
public/         archivos estáticos (la app)
migrations/     migraciones de D1 (desde F1)
tests/          pruebas (node --test)
docs/prototipo/ prototipo de referencia (fuera de git hasta limpiarlo en F1)
```

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| F0 | Estructura, D1 y R2 creados, "hola" desplegado detrás de Access | en curso |
| F1 | `/api/yo`, `bootstrap`, `sync`, `merge3`, migraciones, equipo | pendiente |
| F2 | Entregas con R2 | pendiente |
| F3 | Área general, aprobaciones, inbox | pendiente |
| F4 | Contactos y base de datos | pendiente |
| F5 | Respaldo y restauración | pendiente |
| F6 | Endurecimiento y README de operación | pendiente |
