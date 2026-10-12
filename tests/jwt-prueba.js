// Llaves y JWT de Access generados para las pruebas (nunca salen a la red).
export const EQUIPO = 'equipo-prueba';
export const AUD = 'aud-de-prueba';

const b64u = (x) => Buffer.from(x).toString('base64url');
const nueva = () => crypto.subtle.generateKey(
	{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);

export async function llavesDePrueba() {
	const par = await nueva();
	const otra = (await nueva()).privateKey;
	const jwk = { ...(await crypto.subtle.exportKey('jwk', par.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
	const buscar = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
	async function firmar(payload, { alg = 'RS256', kid = 'k1', llave = par.privateKey } = {}) {
		const cab = b64u(JSON.stringify({ alg, kid, typ: 'JWT' }));
		const cuerpo = b64u(JSON.stringify(payload));
		const firma = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', llave, new TextEncoder().encode(cab + '.' + cuerpo));
		return cab + '.' + cuerpo + '.' + b64u(firma);
	}
	// Identidad válida por 10 minutos a partir de ahora.
	const identidad = (email) => firmar({
		iss: `https://${EQUIPO}.cloudflareaccess.com`, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, nbf: Math.floor(Date.now() / 1000) - 10, email,
	});
	return { firmar, buscar, otra, identidad };
}
