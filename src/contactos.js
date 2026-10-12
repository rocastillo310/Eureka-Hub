// Contactos de clientes (F4): personas con las que el equipo trata en cada cuenta. Son datos personales de terceros:
// viven solo en D1, nunca en el repositorio. Cualquiera del equipo los crea y edita; borrarlos lo hace Dirección o
// quien los creó. El servidor valida la forma y estampa quién y cuándo los creó.

const CAMPOS = { id: 80, cuentaId: 80, nombre: 200, cargo: 120, correo: 200, telefono: 60, notas: 4000, creadoPor: 80, creadoEn: 40 };
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Devuelve el motivo del rechazo, o null si los datos son válidos.
export function validarContacto(d) {
	for (const k of Object.keys(d)) {
		if (!(k in CAMPOS)) return `Campo desconocido en el contacto: ${k}`;
		if (typeof d[k] !== 'string') return `El campo ${k} debe ser texto`;
		if (d[k].length > CAMPOS[k]) return `El campo ${k} es demasiado largo`;
	}
	if (!d.nombre || !d.nombre.trim()) return 'El contacto necesita nombre';
	if (!d.cuentaId) return 'El contacto necesita una cuenta';
	if (d.correo && !CORREO.test(d.correo.trim())) return `Correo inválido: ${d.correo}`;
	return null;
}

// Revisa un cambio de contacto que llega por sync y lo deja listo para guardar. Devuelve { motivo } o { datos }.
export async function prepararContacto(env, c, usuario) {
	const cur = await env.DB.prepare("SELECT datos, borrado FROM entidades WHERE tipo = 'contacto' AND id = ?1").bind(c.id).first();
	const actual = cur && !cur.borrado ? JSON.parse(cur.datos) : null;
	if (c.datos === null) {
		if (actual && usuario.role !== 'admin' && actual.creadoPor !== usuario.id) return { motivo: 'Solo Dirección o quien creó el contacto puede borrarlo' };
		return { datos: null };
	}
	const motivo = validarContacto(c.datos);
	if (motivo) return { motivo };
	if (!actual || c.datos.cuentaId !== actual.cuentaId) {
		const cuenta = await env.DB.prepare("SELECT 1 AS x FROM entidades WHERE tipo = 'account' AND id = ?1 AND borrado = 0").bind(c.datos.cuentaId).first();
		if (!cuenta) return { motivo: 'Esa cuenta no existe' };
	}
	const datos = { ...c.datos, id: c.id, nombre: c.datos.nombre.trim() };
	if (datos.correo) datos.correo = datos.correo.trim().toLowerCase();
	// Quién y cuándo lo creó lo decide el servidor, no la pantalla.
	datos.creadoPor = actual ? actual.creadoPor : usuario.id;
	datos.creadoEn = actual ? actual.creadoEn : new Date().toISOString();
	return { datos };
}
