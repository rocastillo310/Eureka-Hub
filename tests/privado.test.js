// Pruebas del panel privado (solo su dueño, con contraseña, bloqueo tras intentos fallidos).
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { d1Falso } from './d1-falso.js';
import { llavesDePrueba, EQUIPO, AUD } from './jwt-prueba.js';
import { _reiniciarCache } from '../src/access.js';
import { hashClave, entrar } from '../src/privado.js';

const { buscar, identidad } = await llavesDePrueba();
globalThis.fetch = buscar;
const PROD = 'https://eureka-hub.cuenta.workers.dev';
const CLAVE = 'clave-de-prueba'; // no es la real

async function entorno() {
	_reiniciarCache();
	const env = { DB: d1Falso(), ACCESS_EQUIPO: EQUIPO, ACCESS_AUD: AUD, PRIVADO_DUENO: 'ana', PRIVADO_CLAVE: await hashClave(CLAVE, 1000), ASSETS: { fetch: () => new Response('') } };
	for (const u of [{ id: 'ana', name: 'Ana', role: 'admin', nivel: 'administracion', email: 'ana@agencia.test' }, { id: 'dora', name: 'Dora', role: 'admin', nivel: 'administracion', email: 'dora@agencia.test' }]) {
		await env.DB.batch([
			env.DB.prepare('UPDATE contador SET seq = seq + 1 WHERE id = 1'),
			env.DB.prepare("INSERT INTO entidades (tipo, id, datos, version, seq, creado, actualizado, borrado, por) SELECT 'user', ?1, ?2, 1, seq, seq, 'ahora', 0, 'semilla' FROM contador WHERE id = 1").bind(u.id, JSON.stringify(u)),
		]);
	}
	return env;
}
const pedir = async (env, ruta, como, { cuerpo, llave } = {}) => {
	const headers = { 'content-type': 'application/json', 'Cf-Access-Jwt-Assertion': await identidad(como) };
	if (llave) headers['X-Privado'] = llave;
	const r = await worker.fetch(new Request(PROD + '/api/' + ruta, { method: cuerpo ? 'POST' : 'GET', headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined }), env);
	return { estado: r.status, json: await r.json() };
};

test('el secreto guarda la contraseña cifrada, nunca tal cual', async () => {
	const h = await hashClave(CLAVE, 1000);
	assert.match(h, /^pbkdf2\$1000\$[\w-]+\$[\w-]+$/);
	assert.ok(!h.includes(CLAVE));
});

test('solo su dueño lo ve; con la contraseña correcta guarda y lee enlaces', async () => {
	const env = await entorno();
	assert.equal((await pedir(env, 'yo', 'ana@agencia.test')).json.privado, true);
	assert.equal((await pedir(env, 'yo', 'dora@agencia.test')).json.privado, undefined);
	assert.equal((await pedir(env, 'privado/entrar', 'dora@agencia.test', { cuerpo: { clave: CLAVE } })).estado, 403, 'otra persona de Administración tampoco');
	assert.equal((await pedir(env, 'privado/enlaces', 'ana@agencia.test')).estado, 401, 'sin contraseña no hay enlaces');
	const ok = await pedir(env, 'privado/entrar', 'ana@agencia.test', { cuerpo: { clave: CLAVE } });
	assert.equal(ok.estado, 200);
	const llave = ok.json.llave;
	const g = await pedir(env, 'privado/enlaces', 'ana@agencia.test', { cuerpo: { enlaces: [{ nombre: 'Notebook', url: 'https://notebook.example.com/?a=1' }] }, llave });
	assert.equal(g.estado, 200);
	assert.deepEqual((await pedir(env, 'privado/enlaces', 'ana@agencia.test', { llave })).json.enlaces, [{ nombre: 'Notebook', url: 'https://notebook.example.com/?a=1' }]);
	assert.equal((await pedir(env, 'privado/enlaces', 'ana@agencia.test', { cuerpo: { enlaces: [{ nombre: 'X', url: 'javascript:alert(1)' }] }, llave })).estado, 400);
	assert.equal((await pedir(env, 'privado/enlaces', 'dora@agencia.test', { llave })).estado, 403, 'la llave no sirve a otra persona');
});

test('tras 5 intentos fallidos se bloquea 15 minutos, aunque luego pongan la correcta', async () => {
	const env = await entorno();
	const u = { id: 'ana' }, t0 = Date.UTC(2026, 9, 16, 12);
	for (let i = 0; i < 5; i++) assert.equal((await entrar(env, u, '000000', t0 + i)).estado, 401);
	const b = await entrar(env, u, CLAVE, t0 + 10);
	assert.equal(b.estado, 429);
	assert.equal((await entrar(env, u, CLAVE, t0 + 16 * 60_000)).ok, true, 'pasados 15 minutos, la correcta entra');
});

test('la llave del panel vence a los 30 minutos', async () => {
	const env = await entorno();
	const { llaveValida } = await import('../src/privado.js');
	const t0 = Date.now();
	const r = await entrar(env, { id: 'ana' }, CLAVE, t0);
	assert.equal(await llaveValida(env, { id: 'ana' }, r.llave, t0 + 29 * 60_000), true);
	assert.equal(await llaveValida(env, { id: 'ana' }, r.llave, t0 + 31 * 60_000), false);
});
