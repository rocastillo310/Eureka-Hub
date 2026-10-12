// Pruebas de los contactos (F4): validación, autor estampado por el servidor y permisos de borrado.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { d1Falso } from './d1-falso.js';
import { llavesDePrueba, EQUIPO, AUD } from './jwt-prueba.js';
import { _reiniciarCache } from '../src/access.js';
import { validarContacto } from '../src/contactos.js';

const { buscar, identidad } = await llavesDePrueba();
globalThis.fetch = buscar;
const PROD = 'https://eureka-hub.cuenta.workers.dev';

// Datos ficticios de prueba (no son el equipo ni los clientes reales).
const ana = 'ana@agencia.test', beto = 'beto@agencia.test', caro = 'caro@agencia.test';

async function poner(env, tipo, id, datos) {
	await env.DB.batch([
		env.DB.prepare('UPDATE contador SET seq = seq + 1 WHERE id = 1'),
		env.DB.prepare("INSERT INTO entidades (tipo, id, datos, version, seq, creado, actualizado, borrado, por) SELECT ?1, ?2, ?3, 1, seq, seq, 'ahora', 0, 'semilla' FROM contador WHERE id = 1")
			.bind(tipo, id, JSON.stringify(datos)),
	]);
}
async function entorno() {
	_reiniciarCache();
	const env = { DB: d1Falso(), ACCESS_EQUIPO: EQUIPO, ACCESS_AUD: AUD, ASSETS: { fetch: () => new Response('') } };
	await poner(env, 'user', 'ana', { id: 'ana', name: 'Ana', role: 'admin', email: ana });
	await poner(env, 'user', 'beto', { id: 'beto', name: 'Beto', role: '', email: beto });
	await poner(env, 'user', 'caro', { id: 'caro', name: 'Caro', role: '', email: caro });
	await poner(env, 'account', 'c1', { id: 'c1', name: 'Cliente Uno' });
	await poner(env, 'account', 'c2', { id: 'c2', name: 'Cliente Dos' });
	return env;
}
async function sync(env, como, cambios) {
	const r = await worker.fetch(new Request(PROD + '/api/sync', {
		method: 'POST', headers: { 'content-type': 'application/json', 'Cf-Access-Jwt-Assertion': await identidad(como) }, body: JSON.stringify({ desde: 0, cambios }),
	}), env);
	return r.json();
}
const fila = async (env, id) => {
	const f = await env.DB.prepare("SELECT datos, borrado FROM entidades WHERE tipo = 'contacto' AND id = ?1").bind(id).first();
	return f && !f.borrado ? JSON.parse(f.datos) : null;
};
const nuevo = (d) => ({ tipo: 'contacto', id: d.id, base: null, datos: d });

test('crear un contacto: el servidor estampa quién y cuándo, y normaliza el correo', async () => {
	const env = await entorno();
	const r = await sync(env, beto, [nuevo({ id: 'k1', cuentaId: 'c1', nombre: ' Laura Pérez ', cargo: 'Gerente de marca', correo: 'Laura@Cliente.TEST', telefono: '+52 33 1234 5678', notas: '', creadoPor: 'ana', creadoEn: '2000-01-01' })]);
	assert.equal(r.rechazados, undefined);
	const k = await fila(env, 'k1');
	assert.equal(k.nombre, 'Laura Pérez');
	assert.equal(k.correo, 'laura@cliente.test');
	assert.equal(k.creadoPor, 'beto');
	assert.notEqual(k.creadoEn, '2000-01-01');
});

test('editar conserva quién lo creó aunque lo edite otra persona', async () => {
	const env = await entorno();
	await sync(env, beto, [nuevo({ id: 'k1', cuentaId: 'c1', nombre: 'Laura' })]);
	const k = await fila(env, 'k1');
	const r = await sync(env, caro, [{ tipo: 'contacto', id: 'k1', base: k, datos: { ...k, cargo: 'Directora', creadoPor: 'caro' } }]);
	assert.equal(r.rechazados, undefined);
	const k2 = await fila(env, 'k1');
	assert.equal(k2.cargo, 'Directora');
	assert.equal(k2.creadoPor, 'beto');
});

test('se rechazan contactos sin nombre, sin cuenta, con cuenta inexistente, correo inválido o campos de más', async () => {
	const env = await entorno();
	const r = await sync(env, beto, [
		nuevo({ id: 'a', cuentaId: 'c1', nombre: '  ' }),
		nuevo({ id: 'b', nombre: 'Sin cuenta' }),
		nuevo({ id: 'c', cuentaId: 'no-existe', nombre: 'X' }),
		nuevo({ id: 'd', cuentaId: 'c1', nombre: 'X', correo: 'no-es-correo' }),
		nuevo({ id: 'e', cuentaId: 'c1', nombre: 'X', html: '<script>' }),
		nuevo({ id: 'f', cuentaId: 'c1', nombre: 'X', notas: 'x'.repeat(4001) }),
		nuevo({ id: 'g', cuentaId: 'c1', nombre: 'Bien' }),
	]);
	assert.deepEqual(r.rechazados.map((x) => x.id), ['a', 'b', 'c', 'd', 'e', 'f']);
	assert.equal((await fila(env, 'g')).nombre, 'Bien');
	for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) assert.equal(await fila(env, id), null);
});

test('borrar: solo Dirección o quien lo creó', async () => {
	const env = await entorno();
	await sync(env, beto, [nuevo({ id: 'k1', cuentaId: 'c1', nombre: 'Laura' }), nuevo({ id: 'k2', cuentaId: 'c1', nombre: 'Pedro' })]);
	const k1 = await fila(env, 'k1'), k2 = await fila(env, 'k2');
	assert.equal((await sync(env, caro, [{ tipo: 'contacto', id: 'k1', base: k1, datos: null }])).rechazados.length, 1);
	assert.ok(await fila(env, 'k1'));
	assert.equal((await sync(env, beto, [{ tipo: 'contacto', id: 'k1', base: k1, datos: null }])).rechazados, undefined);
	assert.equal((await sync(env, ana, [{ tipo: 'contacto', id: 'k2', base: k2, datos: null }])).rechazados, undefined);
	assert.equal(await fila(env, 'k1'), null);
	assert.equal(await fila(env, 'k2'), null);
});

test('validarContacto acepta un contacto completo', () => {
	assert.equal(validarContacto({ id: 'k', cuentaId: 'c1', nombre: 'Laura', cargo: '', correo: '', telefono: '', notas: '' }), null);
});
