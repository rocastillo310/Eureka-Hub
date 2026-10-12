// Verifica el JWT que Cloudflare Access manda en el encabezado Cf-Access-Jwt-Assertion.
// Según la documentación de Cloudflare: RS256, llaves públicas en
// https://<equipo>.cloudflareaccess.com/cdn-cgi/access/certs (rotan, no se dejan fijas), y se comprueban
// firma, emisor (iss), audiencia (aud) y vencimiento (exp).
// Falla CERRADO: ante cualquier duda devuelve ok:false. Variables: ACCESS_EQUIPO (nombre del equipo) y ACCESS_AUD.
// NO se confía en cf-access-authenticated-user-email: el correo sale solo del JWT ya verificado.

const enc = new TextEncoder();
let cacheLlaves = { equipo: null, hasta: 0, llaves: [] };

function b64u(texto) {
	const b = atob(texto.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(texto.length / 4) * 4, '='));
	return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
const json = (texto) => JSON.parse(new TextDecoder().decode(b64u(texto)));

async function llavesDe(equipo, buscar) {
	const ahora = Date.now();
	if (cacheLlaves.equipo === equipo && ahora < cacheLlaves.hasta && cacheLlaves.llaves.length) return cacheLlaves.llaves;
	const r = await (buscar || fetch)(`https://${equipo}.cloudflareaccess.com/cdn-cgi/access/certs`);
	if (!r.ok) throw new Error('No se pudieron obtener las llaves de Access');
	const cuerpo = await r.json();
	const llaves = Array.isArray(cuerpo.keys) ? cuerpo.keys : [];
	cacheLlaves = { equipo, hasta: ahora + 10 * 60 * 1000, llaves }; // 10 minutos: la rotación es lenta
	return llaves;
}

export function _reiniciarCache() { cacheLlaves = { equipo: null, hasta: 0, llaves: [] }; }

export async function verificarAccess(request, env, opciones = {}) {
	const ahora = opciones.ahora || Date.now();
	try {
		const equipo = env.ACCESS_EQUIPO, aud = env.ACCESS_AUD;
		if (!equipo || !aud) return { ok: false, motivo: 'Falta configurar Cloudflare Access (ACCESS_EQUIPO y ACCESS_AUD)' };
		const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
		if (!jwt) return { ok: false, motivo: 'Falta la identidad de Cloudflare Access' };
		const partes = jwt.split('.');
		if (partes.length !== 3) return { ok: false, motivo: 'Identidad con formato inválido' };
		const cab = json(partes[0]);
		if (cab.alg !== 'RS256' || !cab.kid) return { ok: false, motivo: 'Algoritmo de firma no permitido' };
		const llaves = await llavesDe(equipo, opciones.buscar);
		const jwk = llaves.find((k) => k.kid === cab.kid);
		if (!jwk) return { ok: false, motivo: 'Llave de firma desconocida' };
		const llave = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
		const firmaOk = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', llave, b64u(partes[2]), enc.encode(partes[0] + '.' + partes[1]));
		if (!firmaOk) return { ok: false, motivo: 'Firma inválida' };
		const p = json(partes[1]);
		if (p.iss !== `https://${equipo}.cloudflareaccess.com`) return { ok: false, motivo: 'Emisor inválido' };
		const auds = Array.isArray(p.aud) ? p.aud : [p.aud];
		if (!auds.includes(aud)) return { ok: false, motivo: 'Audiencia inválida' };
		if (typeof p.exp !== 'number' || p.exp * 1000 <= ahora) return { ok: false, motivo: 'Identidad vencida' };
		if (typeof p.nbf === 'number' && p.nbf * 1000 > ahora + 60_000) return { ok: false, motivo: 'Identidad aún no válida' };
		if (typeof p.email !== 'string' || !p.email) return { ok: false, motivo: 'La identidad no trae correo' };
		return { ok: true, email: p.email };
	} catch {
		return { ok: false, motivo: 'No se pudo verificar la identidad' };
	}
}
