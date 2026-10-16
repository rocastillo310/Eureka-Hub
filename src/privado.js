// Panel privado: solo la persona de PRIVADO_DUENO (variable del Worker, hoy Rodrigo) y con contraseña.
// Guarda enlaces privados (p. ej., un notebook de Google) que se abren en una pestaña nueva con la sesión propia de
// Google: el Hub no inicia sesión por nadie ni muestra esas páginas adentro.
//
// La contraseña nunca está en el código: el secreto PRIVADO_CLAVE guarda «pbkdf2$iteraciones$sal$hash» (base64url).
// Tras 5 intentos fallidos se bloquea 15 minutos. Al entrar se entrega una llave firmada que dura 30 minutos.

const MAX_INTENTOS = 5, BLOQUEO_MS = 15 * 60_000, SESION_MS = 30 * 60_000;
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const texto = new TextEncoder();

export const esDuenoPrivado = (env, u) => !!u && !u.baja && !!(env.PRIVADO_DUENO || '').trim() && u.id === env.PRIVADO_DUENO.trim();
export const privadoConfigurado = (env) => /^pbkdf2\$\d+\$[\w-]+\$[\w-]+$/.test((env.PRIVADO_CLAVE || '').trim());

async function derivar(clave, sal, iteraciones) {
	const k = await crypto.subtle.importKey('raw', texto.encode(clave), 'PBKDF2', false, ['deriveBits']);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iteraciones }, k, 256));
}

// Para generar el secreto (scripts/clave-privada.mjs usa lo mismo).
export async function hashClave(clave, iteraciones = 100_000, sal = crypto.getRandomValues(new Uint8Array(16))) {
	return `pbkdf2$${iteraciones}$${b64u(sal)}$${b64u(await derivar(clave, sal, iteraciones))}`;
}

async function claveCorrecta(env, clave) {
	const [, it, sal, hash] = env.PRIVADO_CLAVE.trim().split('$');
	const calc = await derivar(String(clave), deB64u(sal), Number(it));
	const esperado = deB64u(hash);
	if (calc.length !== esperado.length) return false;
	let dif = 0;
	for (let i = 0; i < calc.length; i++) dif |= calc[i] ^ esperado[i];
	return dif === 0;
}

async function hmac(env, datos) {
	const k = await crypto.subtle.importKey('raw', texto.encode('panel-privado:' + env.PRIVADO_CLAVE), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return b64u(await crypto.subtle.sign('HMAC', k, texto.encode(datos)));
}

async function leerMeta(env, clave) {
	const f = await env.DB.prepare('SELECT valor FROM meta WHERE clave = ?1').bind(clave).first();
	return f ? f.valor : null;
}
async function ponerMeta(env, clave, valor) {
	await env.DB.prepare('INSERT INTO meta (clave, valor) VALUES (?1, ?2) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor').bind(clave, valor).run();
}

export async function entrar(env, usuario, clave, ahora = Date.now()) {
	const intentos = JSON.parse((await leerMeta(env, 'privado_intentos')) || '{"n":0,"hasta":0}');
	if (intentos.hasta > ahora) return { ok: false, estado: 429, motivo: `Demasiados intentos. Espera ${Math.ceil((intentos.hasta - ahora) / 60_000)} min.` };
	if (typeof clave !== 'string' || !clave || clave.length > 200 || !(await claveCorrecta(env, clave))) {
		const n = (intentos.hasta && intentos.hasta <= ahora ? 0 : intentos.n) + 1;
		await ponerMeta(env, 'privado_intentos', JSON.stringify(n >= MAX_INTENTOS ? { n: 0, hasta: ahora + BLOQUEO_MS } : { n, hasta: 0 }));
		return { ok: false, estado: 401, motivo: n >= MAX_INTENTOS ? 'Contraseña incorrecta. Se bloqueó 15 minutos.' : `Contraseña incorrecta (${MAX_INTENTOS - n} intento${MAX_INTENTOS - n === 1 ? '' : 's'} más antes de bloquearse).` };
	}
	await ponerMeta(env, 'privado_intentos', JSON.stringify({ n: 0, hasta: 0 }));
	const vence = ahora + SESION_MS;
	return { ok: true, llave: `${vence}.${await hmac(env, `${usuario.id}.${vence}`)}`, vence };
}

export async function llaveValida(env, usuario, llave, ahora = Date.now()) {
	const [vence, firma] = String(llave || '').split('.');
	if (!vence || !firma || Number(vence) < ahora) return false;
	return firma === (await hmac(env, `${usuario.id}.${vence}`));
}

const URL_OK = /^https:\/\/[^\s"'<>/]+\.[^\s"'<>]+$/i;
export async function leerEnlaces(env) {
	return JSON.parse((await leerMeta(env, 'privado_enlaces')) || '[]');
}
export async function guardarEnlaces(env, lista) {
	if (!Array.isArray(lista) || lista.length > 50) return { motivo: 'Lista inválida' };
	const limpios = [];
	for (const e of lista) {
		const nombre = String((e && e.nombre) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100);
		const url = String((e && e.url) || '').trim();
		if (!nombre || !URL_OK.test(url) || url.length > 2000) return { motivo: `Revisa «${nombre || 'sin nombre'}»: necesita nombre y un enlace que empiece con https://` };
		limpios.push({ nombre, url });
	}
	await ponerMeta(env, 'privado_enlaces', JSON.stringify(limpios));
	return { enlaces: limpios };
}
