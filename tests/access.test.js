// Pruebas de la verificación del JWT de Cloudflare Access (llaves generadas aquí, sin red).
import test from 'node:test';
import assert from 'node:assert/strict';
import { verificarAccess, _reiniciarCache } from '../src/access.js';
import { llavesDePrueba, EQUIPO, AUD } from './jwt-prueba.js';

const { firmar, buscar, otra } = await llavesDePrueba();
const ahora = Date.parse('2026-10-12T12:00:00Z');
const bueno = () => ({ iss: `https://${EQUIPO}.cloudflareaccess.com`, aud: [AUD], exp: ahora / 1000 + 600, nbf: ahora / 1000 - 10, email: 'Persona@Agencia.test' });
const env = { ACCESS_EQUIPO: EQUIPO, ACCESS_AUD: AUD };
const pedir = (jwt) => new Request('https://x.test/api/yo', { headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} });
const verificar = (jwt, e = env) => { _reiniciarCache(); return verificarAccess(pedir(jwt), e, { ahora, buscar }); };
const b64u = (x) => Buffer.from(x).toString('base64url');

test('una identidad correcta devuelve el correo', async () => {
	assert.deepEqual(await verificar(await firmar(bueno())), { ok: true, email: 'Persona@Agencia.test' });
});
test('secretos con salto de línea o espacios al final: igual funciona', async () => {
	const r = await verificar(await firmar(bueno()), { ACCESS_EQUIPO: EQUIPO + '\r\n', ACCESS_AUD: ' ' + AUD + '\n' });
	assert.equal(r.ok, true);
});
test('sin encabezado: rechaza', async () => assert.equal((await verificar(null)).ok, false));
test('sin ACCESS_EQUIPO o ACCESS_AUD: rechaza (falla cerrado)', async () => {
	assert.equal((await verificar(await firmar(bueno()), {})).ok, false);
	assert.equal((await verificar(await firmar(bueno()), { ACCESS_EQUIPO: EQUIPO })).ok, false);
});
test('firmado con otra llave: rechaza', async () => {
	const r = await verificar(await firmar(bueno(), { llave: otra }));
	assert.equal(r.ok, false);
	assert.match(r.motivo, /Firma/);
});
test('audiencia distinta: rechaza', async () => assert.equal((await verificar(await firmar({ ...bueno(), aud: ['otra'] }))).ok, false));
test('emisor distinto: rechaza', async () => assert.equal((await verificar(await firmar({ ...bueno(), iss: 'https://malo.cloudflareaccess.com' }))).ok, false));
test('vencida: rechaza', async () => assert.equal((await verificar(await firmar({ ...bueno(), exp: ahora / 1000 - 1 }))).ok, false));
test('sin vencimiento: rechaza', async () => { const p = bueno(); delete p.exp; assert.equal((await verificar(await firmar(p))).ok, false); });
test('sin correo: rechaza', async () => { const p = bueno(); delete p.email; assert.equal((await verificar(await firmar(p))).ok, false); });
test("algoritmo 'none' o HS256: rechaza", async () => {
	const cab = b64u(JSON.stringify({ alg: 'none', kid: 'k1' }));
	assert.equal((await verificar(cab + '.' + b64u(JSON.stringify(bueno())) + '.')).ok, false);
	assert.equal((await verificar(await firmar(bueno(), { alg: 'HS256' }))).ok, false);
});
test('kid desconocido: rechaza', async () => assert.equal((await verificar(await firmar(bueno(), { kid: 'otra' }))).ok, false));
test('basura en el encabezado: rechaza', async () => {
	assert.equal((await verificar('abc')).ok, false);
	assert.equal((await verificar('a.b.c')).ok, false);
});
test('si no se pueden obtener las llaves: rechaza', async () => {
	_reiniciarCache();
	assert.equal((await verificarAccess(pedir(await firmar(bueno())), env, { ahora, buscar: async () => ({ ok: false }) })).ok, false);
});
test('contenido modificado después de firmar: rechaza', async () => {
	const [h, , f] = (await firmar(bueno())).split('.');
	assert.equal((await verificar(h + '.' + b64u(JSON.stringify({ ...bueno(), email: 'otro@agencia.test' })) + '.' + f)).ok, false);
});
