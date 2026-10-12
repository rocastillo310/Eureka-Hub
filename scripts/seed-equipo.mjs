// Carga el equipo real (seed/equipo.local.json, fuera de git) y la configuración base (seed/base.json) en D1.
// Uso:  npm run seed:equipo            -> base local (wrangler dev)
//       npm run seed:equipo -- --remote -> base de producción
// Es repetible: lo que ya existe NO se sobrescribe (los cambios hechos desde la app se respetan).
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const remoto = process.argv.includes('--remote');
const RUTA_EQUIPO = 'seed/equipo.local.json';
if (!existsSync(RUTA_EQUIPO)) {
	console.error(`Falta ${RUTA_EQUIPO}. Crea el archivo con la lista del equipo (ver README, sección "Dar de alta al equipo").`);
	process.exit(1);
}
const { equipo } = JSON.parse(readFileSync(RUTA_EQUIPO, 'utf8'));
const base = JSON.parse(readFileSync('seed/base.json', 'utf8'));

if (!Array.isArray(equipo) || !equipo.length) throw new Error('equipo.local.json debe traer { "equipo": [ ... ] }');
const ids = new Set(), correos = new Set();
for (const p of equipo) {
	if (!/^[a-z0-9._-]+$/.test(p.id || '')) throw new Error(`id inválido: ${p.id}`);
	if (!p.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email || '')) throw new Error(`Falta nombre o correo válido para ${p.id}`);
	if (ids.has(p.id) || correos.has(p.email.toLowerCase())) throw new Error(`Repetido: ${p.id}`);
	ids.add(p.id); correos.add(p.email.toLowerCase());
}
if (!equipo.some((p) => p.role === 'admin')) throw new Error('Al menos una persona debe tener role "admin"');

// Cuentas (clientes), opcional: seed/cuentas.local.json, también fuera de git. Cada cuenta nace como si se creara
// desde la app: equipo vacío (lo asigna Dirección) y dos listas, la de redes del mes actual y la de diseño.
const RUTA_CUENTAS = 'seed/cuentas.local.json';
const cuentas = existsSync(RUTA_CUENTAS) ? JSON.parse(readFileSync(RUTA_CUENTAS, 'utf8')).cuentas || [] : [];
for (const c of cuentas) {
	if (!/^[a-z0-9-]+$/.test(c.id || '') || !c.name) throw new Error(`Cuenta inválida: ${c.id}`);
	if (c.drive && !/^https:\/\/drive\.google\.com\//.test(c.drive)) throw new Error(`Enlace de Drive inválido en ${c.id}`);
}
const mes = new Date().toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
const listaMes = mes.charAt(0).toUpperCase() + mes.slice(1);

const entidades = [
	...equipo.map((p, i) => ['user', p.id, {
		id: p.id, name: p.name, role: p.role || '', email: p.email.toLowerCase(), aprueba: !!p.aprueba, hue: i, cap: p.cap || 6,
	}]),
	...Object.entries(base.stat).map(([k, v]) => ['stat', k, { v }]),
	['cols', 'main', { cols: base.cols }],
	...base.autos.map((a) => ['auto', a.id, a]),
	...cuentas.flatMap((c, i) => [
		['account', c.id, { id: c.id, name: c.name, team: { admin: '', community: '', diseno: '' }, hue: i, ...(c.drive ? { drive: c.drive } : {}) }],
		['list', `l-${c.id}-redes`, { id: `l-${c.id}-redes`, acc: c.id, type: 'redes', name: listaMes }],
		['list', `l-${c.id}-diseno`, { id: `l-${c.id}-diseno`, acc: c.id, type: 'diseno', name: 'Diseño' }],
	]),
];

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const ahora = new Date().toISOString();
const sql = entidades.map(([tipo, id, datos]) =>
	'UPDATE contador SET seq = seq + 1 WHERE id = 1;\n' +
	'INSERT INTO entidades (tipo, id, datos, version, seq, creado, actualizado, borrado, por) ' +
	`SELECT ${q(tipo)}, ${q(id)}, ${q(JSON.stringify(datos))}, 1, seq, seq, ${q(ahora)}, 0, 'semilla' FROM contador WHERE id = 1 ` +
	'ON CONFLICT (tipo, id) DO NOTHING;',
).join('\n') + "\nINSERT OR IGNORE INTO meta (clave, valor) VALUES ('semillado', '1');\n";

// El archivo temporal lleva correos: vive en .wrangler/ (fuera de git) y se borra al terminar.
mkdirSync('.wrangler/tmp', { recursive: true });
const archivo = '.wrangler/tmp/seed-equipo.sql';
writeFileSync(archivo, sql);
try {
	// wrangler del proyecto, llamado con el mismo Node (sin pasar por la consola del sistema).
	const wrangler = (...args) => execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], { stdio: 'inherit' });
	const donde = remoto ? '--remote' : '--local';
	wrangler('d1', 'migrations', 'apply', 'eureka-hub-db', donde);
	wrangler('d1', 'execute', 'eureka-hub-db', donde, `--file=${archivo}`, '--yes');
	console.log(`Listo: ${equipo.length} personas, ${cuentas.length} cuentas y la configuración base en la base ${remoto ? 'de PRODUCCIÓN' : 'local'} (lo que ya existía no se tocó).`);
} finally {
	rmSync(archivo, { force: true });
}
