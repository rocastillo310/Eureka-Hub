// Pruebas de la actualización automática de la política de Cloudflare Access (API falsa, sin red).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sincronizarPoliticaAccess } from '../src/access-politica.js';

const ENV = { CF_API_TOKEN: 'token-de-prueba', CF_ACCOUNT_ID: 'cuenta', ACCESS_POLITICA_ID: 'politica' };

// API falsa: guarda la política y registra los PUT.
function apiFalsa(politica, { falla = false } = {}) {
	const llamadas = [];
	const buscar = async (url, op = {}) => {
		llamadas.push({ url, metodo: op.method || 'GET', cuerpo: op.body ? JSON.parse(op.body) : null, auth: op.headers.authorization });
		if (falla) return { ok: false, json: async () => ({ success: false }) };
		if (op.method === 'PUT') { Object.assign(politica, JSON.parse(op.body)); return { ok: true, json: async () => ({ success: true, result: politica }) }; }
		return { ok: true, json: async () => ({ success: true, result: politica }) };
	};
	return { buscar, llamadas, politica };
}
const conCorreos = (...c) => c.map((email) => ({ email: { email } }));

test('agregar a una persona: la política queda con todos los correos del equipo', async () => {
	const api = apiFalsa({ id: 'politica', name: 'Equipo', decision: 'allow', include: conCorreos('ana@x.test') });
	const r = await sincronizarPoliticaAccess(ENV, ['ana@x.test', 'nueva@x.test'], api.buscar);
	assert.deepEqual(r, { ok: true, cambio: true });
	const put = api.llamadas.find((l) => l.metodo === 'PUT');
	assert.equal(put.url, 'https://api.cloudflare.com/client/v4/accounts/cuenta/access/policies/politica');
	assert.equal(put.auth, 'Bearer token-de-prueba');
	assert.deepEqual(put.cuerpo.include, conCorreos('ana@x.test', 'nueva@x.test'));
});

test('conserva nombre, decisión, Require y Exclude de la política', async () => {
	const api = apiFalsa({ name: 'Equipo', decision: 'allow', include: conCorreos('ana@x.test'),
		require: [{ auth_method: { auth_method: 'otp' } }], exclude: [{ email: { email: 'fuera@x.test' } }], session_duration: '24h' });
	await sincronizarPoliticaAccess(ENV, ['ana@x.test', 'beto@x.test'], api.buscar);
	const put = api.llamadas.find((l) => l.metodo === 'PUT').cuerpo;
	assert.equal(put.name, 'Equipo');
	assert.equal(put.decision, 'allow');
	assert.equal(put.session_duration, '24h');
	assert.deepEqual(put.require, [{ auth_method: { auth_method: 'otp' } }]);
	assert.deepEqual(put.exclude, [{ email: { email: 'fuera@x.test' } }]);
});

test('una regla abierta en Include (por ejemplo, cualquier código) se reemplaza por la lista de correos', async () => {
	const api = apiFalsa({ name: 'Equipo', decision: 'allow', include: [{ auth_method: { auth_method: 'pin' } }, ...conCorreos('ana@x.test')] });
	const r = await sincronizarPoliticaAccess(ENV, ['ana@x.test'], api.buscar);
	assert.equal(r.cambio, true);
	assert.deepEqual(api.politica.include, conCorreos('ana@x.test'));
});

test('si ya coincide, no se toca la política', async () => {
	const api = apiFalsa({ name: 'Equipo', decision: 'allow', include: conCorreos('Ana@X.test', 'beto@x.test') });
	assert.deepEqual(await sincronizarPoliticaAccess(ENV, ['ana@x.test', 'beto@x.test'], api.buscar), { ok: true, cambio: false });
	assert.equal(api.llamadas.filter((l) => l.metodo === 'PUT').length, 0);
});

test('sin configurar (sin token): no llama a la API y lo avisa', async () => {
	const api = apiFalsa({ include: [] });
	const r = await sincronizarPoliticaAccess({}, ['ana@x.test'], api.buscar);
	assert.equal(r.ok, false);
	assert.equal(api.llamadas.length, 0);
});

test('nunca deja la política con la lista vacía', async () => {
	const api = apiFalsa({ include: conCorreos('ana@x.test') });
	assert.equal((await sincronizarPoliticaAccess(ENV, [], api.buscar)).ok, false);
	assert.equal(api.llamadas.length, 0);
});

test('si Cloudflare falla, avisa sin romper', async () => {
	const api = apiFalsa({ include: [] }, { falla: true });
	const r = await sincronizarPoliticaAccess(ENV, ['ana@x.test'], api.buscar);
	assert.equal(r.ok, false);
	assert.match(r.motivo, /No se pudo leer/);
});
