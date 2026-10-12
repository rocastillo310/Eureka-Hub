// Mantiene la política de Cloudflare Access al día con el equipo: los correos permitidos son EXACTAMENTE los de los
// usuarios activos en la base. Se llama cuando Dirección agrega, cambia o quita a alguien.
// Usa la API de Cloudflare (PUT /accounts/{cuenta}/access/policies/{política}) con un token limitado a Access.
// Variables: CF_API_TOKEN (secreto), CF_ACCOUNT_ID y ACCESS_POLITICA_ID.
// Solo reemplaza las reglas «Include»; conserva Require, Exclude y el resto de la configuración de la política.

const API = 'https://api.cloudflare.com/client/v4';
// Campos de la política que se devuelven tal cual al actualizarla (un PUT reemplaza la política completa).
const CONSERVAR = ['name', 'decision', 'require', 'exclude', 'session_duration', 'approval_required', 'approval_groups',
	'isolation_required', 'purpose_justification_required', 'purpose_justification_prompt', 'mfa_config'];

export async function correosDelEquipo(env) {
	const r = await env.DB.prepare("SELECT datos FROM entidades WHERE tipo = 'user' AND borrado = 0").all();
	const correos = (r.results || []).map((f) => JSON.parse(f.datos).email).filter((e) => typeof e === 'string' && e.includes('@'));
	return [...new Set(correos.map((e) => e.trim().toLowerCase()))].sort();
}

export async function sincronizarPoliticaAccess(env, correos, buscar = fetch) {
	const token = (env.CF_API_TOKEN || '').trim(), cuenta = (env.CF_ACCOUNT_ID || '').trim(), politica = (env.ACCESS_POLITICA_ID || '').trim();
	if (!token || !cuenta || !politica) return { ok: false, motivo: 'La conexión automática con Cloudflare Access no está configurada' };
	if (!correos.length) return { ok: false, motivo: 'No se actualiza Access con una lista vacía' };
	const url = `${API}/accounts/${cuenta}/access/policies/${politica}`;
	const cab = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
	try {
		const g = await buscar(url, { headers: cab });
		const actual = await g.json();
		if (!g.ok || !actual.success) return { ok: false, motivo: 'No se pudo leer la política de Access' };
		const p = actual.result;
		const hoy = (p.include || []).filter((r) => r.email).map((r) => r.email.email.toLowerCase()).sort();
		const soloCorreos = (p.include || []).every((r) => r.email);
		if (soloCorreos && hoy.join() === correos.join()) return { ok: true, cambio: false };
		const cuerpo = {};
		for (const k of CONSERVAR) if (p[k] !== undefined && p[k] !== null) cuerpo[k] = p[k];
		cuerpo.include = correos.map((email) => ({ email: { email } }));
		const u = await buscar(url, { method: 'PUT', headers: cab, body: JSON.stringify(cuerpo) });
		const res = await u.json();
		if (!u.ok || !res.success) return { ok: false, motivo: 'Cloudflare rechazó la actualización de Access' };
		return { ok: true, cambio: true };
	} catch {
		return { ok: false, motivo: 'No se pudo conectar con Cloudflare Access' };
	}
}
