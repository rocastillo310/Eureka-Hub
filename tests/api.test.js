// Pruebas de las rutas /api contra una D1 falsa: identidad, modo desarrollo, permisos y sincronización.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { d1Falso } from './d1-falso.js';
import { llavesDePrueba, EQUIPO, AUD } from './jwt-prueba.js';
import { _reiniciarCache } from '../src/access.js';
import { correosDelEquipo } from '../src/access-politica.js';

const { buscar, identidad } = await llavesDePrueba();
globalThis.fetch = buscar; // las llaves públicas de Access salen de aquí, no de la red

const PROD = 'https://eureka-hub.cuenta.workers.dev';
const LOCAL = 'http://localhost:8787';

// Usuarios ficticios de prueba (no son el equipo real).
const ADMIN = { id: 'ana', name: 'Ana', role: 'admin', email: 'ana@agencia.test', aprueba: true, hue: 0, cap: 6 };
const NORMAL = { id: 'beto', name: 'Beto', role: '', email: 'beto@agencia.test', aprueba: false, hue: 1, cap: 6 };

async function entorno({ dev = false, semilla = false } = {}) {
	_reiniciarCache();
	const env = { DB: d1Falso(), ACCESS_EQUIPO: EQUIPO, ACCESS_AUD: AUD, ASSETS: { fetch: () => new Response('estático') } };
	if (dev) env.DEV_LOGIN = '1';
	if (semilla) env.PERMITIR_SEMILLA = '1';
	// Carga directa del equipo, como hace `npm run seed:equipo`.
	for (const u of [ADMIN, NORMAL]) {
		await env.DB.batch([
			env.DB.prepare('UPDATE contador SET seq = seq + 1 WHERE id = 1'),
			env.DB.prepare("INSERT INTO entidades (tipo, id, datos, version, seq, creado, actualizado, borrado, por) SELECT 'user', ?1, ?2, 1, seq, seq, 'ahora', 0, 'semilla' FROM contador WHERE id = 1")
				.bind(u.id, JSON.stringify(u)),
		]);
	}
	await env.DB.prepare("INSERT INTO meta (clave, valor) VALUES ('semillado', '1')").run();
	return env;
}

async function pedir(env, ruta, { base = PROD, cuerpo, como, devUser } = {}) {
	const headers = { 'content-type': 'application/json' };
	if (como) headers['Cf-Access-Jwt-Assertion'] = await identidad(como);
	if (devUser) headers['X-Dev-User'] = devUser;
	const r = await worker.fetch(new Request(base + '/api/' + ruta, { method: cuerpo === undefined ? 'GET' : 'POST', headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) }), env);
	return { estado: r.status, json: await r.json() };
}
const sync = (env, cambios, op = {}) => pedir(env, 'sync', { ...op, cuerpo: { desde: op.desde || 0, cambios } });
const fila = async (env, tipo, id) => {
	const f = await env.DB.prepare('SELECT datos, borrado FROM entidades WHERE tipo = ?1 AND id = ?2').bind(tipo, id).first();
	return f && !f.borrado ? JSON.parse(f.datos) : null;
};

// ---------- X-Dev-User: imposible en producción ----------
test('X-Dev-User NO funciona en producción aunque DEV_LOGIN esté puesto', async () => {
	const env = await entorno({ dev: true });
	const yo = await pedir(env, 'yo', { devUser: 'ana' });
	assert.equal(yo.json.dev, false);
	assert.equal(yo.json.yo, null);
	const s = await sync(env, [{ tipo: 'task', id: 't1', base: null, datos: { id: 't1' } }], { devUser: 'ana' });
	assert.equal(s.estado, 401);
	assert.equal(await fila(env, 'task', 't1'), null);
});

test('X-Dev-User NO funciona en localhost sin DEV_LOGIN', async () => {
	const env = await entorno();
	const yo = await pedir(env, 'yo', { base: LOCAL, devUser: 'ana' });
	assert.equal(yo.json.dev, false);
	assert.equal((await sync(env, [], { base: LOCAL, devUser: 'ana' })).estado, 401);
});

test('X-Dev-User sí funciona en localhost con DEV_LOGIN=1', async () => {
	const env = await entorno({ dev: true });
	const yo = await pedir(env, 'yo', { base: LOCAL, devUser: 'ana' });
	assert.deepEqual(yo.json, { dev: true, yo: 'ana', aviso: null });
});

// ---------- identidad con Access ----------
test('correo dado de alta (sin importar mayúsculas): /api/yo devuelve el usuario', async () => {
	const env = await entorno();
	assert.deepEqual((await pedir(env, 'yo', { como: 'Ana@Agencia.TEST' })).json, { dev: false, yo: 'ana', aviso: null });
});

test('correo no dado de alta: yo null con aviso, y no puede leer ni escribir', async () => {
	const env = await entorno();
	const yo = await pedir(env, 'yo', { como: 'intruso@otro.test' });
	assert.equal(yo.json.yo, null);
	assert.match(yo.json.aviso, /no está dado de alta/);
	assert.equal((await pedir(env, 'bootstrap', { como: 'intruso@otro.test' })).estado, 401);
	assert.equal((await sync(env, [], { como: 'intruso@otro.test' })).estado, 401);
});

test('sin identidad de Access: 401 en bootstrap y sync', async () => {
	const env = await entorno();
	assert.equal((await pedir(env, 'bootstrap')).estado, 401);
	assert.equal((await sync(env, [])).estado, 401);
});

// ---------- bootstrap y seed ----------
test('bootstrap en producción nunca devuelve vacio:true y trae al equipo', async () => {
	const env = await entorno();
	const b = await pedir(env, 'bootstrap', { como: 'beto@agencia.test' });
	assert.equal(b.estado, 200);
	assert.equal(b.json.vacio, undefined);
	assert.deepEqual(b.json.entidades.map((e) => e.id).sort(), ['ana', 'beto']);
});

test('seed está deshabilitado en producción', async () => {
	const env = await entorno({ semilla: true });
	assert.equal((await pedir(env, 'seed', { como: 'ana@agencia.test', cuerpo: { entidades: [] } })).estado, 403);
});

test('seed en desarrollo devuelve 409 si ya hay datos', async () => {
	const env = await entorno({ dev: true, semilla: true });
	assert.equal((await pedir(env, 'seed', { base: LOCAL, devUser: 'ana', cuerpo: { entidades: [] } })).estado, 409);
});

// ---------- permisos en el servidor ----------
for (const tipo of ['user', 'auto', 'stat', 'cols']) {
	test(`quien no es admin no puede escribir «${tipo}»: se rechaza y se le devuelve lo del servidor`, async () => {
		const env = await entorno();
		const id = tipo === 'user' ? 'beto' : 'x1';
		const datos = tipo === 'user' ? { ...NORMAL, role: 'admin' } : { v: 1 };
		const s = await sync(env, [{ tipo, id, base: null, datos }], { como: 'beto@agencia.test' });
		assert.equal(s.estado, 200);
		assert.equal(s.json.rechazados.length, 1);
		const devuelto = s.json.entidades.find((e) => e.tipo === tipo && e.id === id);
		assert.ok(devuelto, 'debe devolver el estado del servidor');
		if (tipo === 'user') assert.equal((await fila(env, 'user', 'beto')).role, '');
		else { assert.equal(devuelto.datos, null); assert.equal(await fila(env, tipo, id), null); }
	});
}

test('el admin sí puede escribir esos tipos', async () => {
	const env = await entorno();
	const s = await sync(env, [{ tipo: 'cols', id: 'main', base: null, datos: { cols: [{ id: 'k1', name: 'Backlog' }] } }], { como: 'ana@agencia.test' });
	assert.equal(s.json.rechazados, undefined);
	assert.equal((await fila(env, 'cols', 'main')).cols[0].name, 'Backlog');
});

test('Dirección agrega una persona: queda guardada y puede entrar con su correo', async () => {
	const env = await entorno();
	const nueva = { id: 'caro', name: 'Caro', role: '', email: 'Caro@Agencia.TEST ', aprueba: false, hue: 2, cap: 6 };
	const s = await sync(env, [{ tipo: 'user', id: 'caro', base: null, datos: nueva }], { como: 'ana@agencia.test' });
	assert.equal(s.estado, 200);
	assert.equal(s.json.rechazados, undefined);
	assert.equal((await fila(env, 'user', 'caro')).email, 'caro@agencia.test'); // se guarda en minúsculas y sin espacios
	// Sin la conexión automática configurada, avisa que falta Access (pero la persona sí queda guardada).
	assert.match(s.json.aviso, /Cloudflare Access no se actualizó/);
	// Ya puede entrar con su correo (si Access la deja pasar).
	assert.deepEqual((await pedir(env, 'yo', { como: 'caro@agencia.test' })).json, { dev: false, yo: 'caro', aviso: null });
	assert.equal((await sync(env, [], { como: 'caro@agencia.test' })).estado, 200);
});

test('un cambio rechazado no impide guardar los demás cambios de la misma solicitud', async () => {
	const env = await entorno();
	const s = await sync(env, [
		{ tipo: 'auto', id: 'au1', base: null, datos: { on: false } },
		{ tipo: 'task', id: 't1', base: null, datos: { id: 't1', title: 'Post' } },
	], { como: 'beto@agencia.test' });
	assert.equal(s.json.rechazados.length, 1);
	assert.equal((await fila(env, 'task', 't1')).title, 'Post');
});

// ---------- dos personas editando la misma tarea ----------
test('dos personas editan la misma tarea a la vez y no se pisan', async () => {
	const env = await entorno();
	const base = { id: 't1', title: 'Post', status: 'redaccion', priority: null, com: [] };
	await sync(env, [{ tipo: 'task', id: 't1', base: null, datos: base }], { como: 'ana@agencia.test' });
	// Ambas parten de la misma versión: Ana cambia la prioridad y comenta; Beto cambia la etapa y comenta.
	await sync(env, [{ tipo: 'task', id: 't1', base, datos: { ...base, priority: 'alta', com: [{ u: 'ana', x: 'de Ana' }] } }], { como: 'ana@agencia.test' });
	await sync(env, [{ tipo: 'task', id: 't1', base, datos: { ...base, status: 'diseno', com: [{ u: 'beto', x: 'de Beto' }] } }], { como: 'beto@agencia.test' });
	const t = await fila(env, 'task', 't1');
	assert.equal(t.priority, 'alta');
	assert.equal(t.status, 'diseno');
	assert.deepEqual(t.com.map((c) => c.x), ['de Ana', 'de Beto']);
});

test('sync devuelve solo lo que cambió desde el cursor y borra con datos:null', async () => {
	const env = await entorno();
	const b = await pedir(env, 'bootstrap', { como: 'ana@agencia.test' });
	const s1 = await sync(env, [{ tipo: 'task', id: 't1', base: null, datos: { id: 't1' } }], { como: 'ana@agencia.test', desde: b.json.cursor });
	assert.deepEqual(s1.json.entidades.map((e) => e.id), ['t1']);
	const s2 = await sync(env, [{ tipo: 'task', id: 't1', base: { id: 't1' }, datos: null }], { como: 'beto@agencia.test', desde: s1.json.cursor });
	assert.equal(s2.json.entidades[0].borrado, true);
	assert.equal(await fila(env, 'task', 't1'), null);
});

test('tipos desconocidos se rechazan con 400', async () => {
	const env = await entorno();
	assert.equal((await sync(env, [{ tipo: 'hack', id: 'x', base: null, datos: {} }], { como: 'ana@agencia.test' })).estado, 400);
});

test('las rutas fuera de /api se sirven como archivos estáticos', async () => {
	const env = await entorno();
	const r = await worker.fetch(new Request(PROD + '/'), env);
	assert.equal(await r.text(), 'estático');
});

// ---------- F6: errores visibles ----------
test('un cambio demasiado grande se rechaza solo, con su motivo, y lo demás sí se guarda', async () => {
	const env = await entorno();
	const enorme = { id: 'big', desc: 'x'.repeat(1_600_000) };
	const s = await sync(env, [
		{ tipo: 'task', id: 'big', base: null, datos: enorme },
		{ tipo: 'task', id: 'ok', base: null, datos: { id: 'ok', title: 'Normal' } },
	], { como: ADMIN.email });
	assert.equal(s.estado, 200);
	assert.deepEqual(s.json.rechazados.map((r) => r.id), ['big']);
	assert.match(s.json.rechazados[0].motivo, /demasiado grande/);
	assert.equal(await fila(env, 'task', 'big'), null);
	assert.equal((await fila(env, 'task', 'ok')).title, 'Normal');
});

test('un error inesperado responde 500 con un mensaje para la persona, sin detalles internos', async () => {
	const env = await entorno();
	const original = console.error;
	console.error = () => {};
	try {
		env.DB.prepare = () => { throw new Error('D1_ERROR: detalle interno'); };
		const r = await pedir(env, 'sync', { cuerpo: { desde: 0, cambios: [] }, como: ADMIN.email });
		assert.equal(r.estado, 500);
		assert.doesNotMatch(r.json.error, /D1_ERROR/);
		assert.match(r.json.error, /avisa a Dirección/);
	} finally {
		console.error = original;
	}
});

test('una solicitud que no es JSON responde 400 con un mensaje claro', async () => {
	const env = await entorno();
	const r = await worker.fetch(new Request(PROD + '/api/sync', { method: 'POST', headers: { 'content-type': 'application/json', 'Cf-Access-Jwt-Assertion': await identidad(ADMIN.email) }, body: '{no es json' }), env);
	assert.equal(r.status, 400);
	assert.match((await r.json()).error, /JSON/);
});

// ---------- dar de baja ----------
test('dar de baja: la persona ya no entra, sale de la lista de Access y sus datos se conservan', async () => {
	const env = await entorno();
	const deBaja = { ...NORMAL, aprueba: false, baja: { en: 'ahora', por: ADMIN.id } };
	const s = await sync(env, [{ tipo: 'user', id: NORMAL.id, base: NORMAL, datos: deBaja }], { como: ADMIN.email });
	assert.equal(s.estado, 200);
	assert.equal(s.json.rechazados, undefined);
	const yo = await pedir(env, 'yo', { como: NORMAL.email });
	assert.equal(yo.json.yo, null);
	assert.match(yo.json.aviso, /dado de baja/);
	assert.equal((await sync(env, [], { como: NORMAL.email })).estado, 401);
	assert.deepEqual(await correosDelEquipo(env), [ADMIN.email]);
	assert.equal((await fila(env, 'user', NORMAL.id)).name, NORMAL.name, 'sigue en la base con su nombre para el historial');
	// Reactivar le devuelve el acceso.
	await sync(env, [{ tipo: 'user', id: NORMAL.id, base: deBaja, datos: { ...NORMAL } }], { como: ADMIN.email });
	assert.equal((await pedir(env, 'yo', { como: NORMAL.email })).json.yo, NORMAL.id);
});

test('nadie se da de baja a sí mismo y siempre queda una persona de Dirección activa', async () => {
	const env = await entorno();
	const yo = await sync(env, [{ tipo: 'user', id: ADMIN.id, base: ADMIN, datos: { ...ADMIN, baja: { en: 'ahora', por: ADMIN.id } } }], { como: ADMIN.email });
	assert.match(yo.json.rechazados[0].motivo, /a ti mismo/);
	const rol = await sync(env, [{ tipo: 'user', id: ADMIN.id, base: ADMIN, datos: { ...ADMIN, role: 'community' } }], { como: ADMIN.email });
	assert.match(rol.json.rechazados[0].motivo, /Dirección activa/);
	assert.equal((await fila(env, 'user', ADMIN.id)).role, 'admin');
});
