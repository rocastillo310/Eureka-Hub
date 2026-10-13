// Restaura la base desde un respaldo (el del repo privado de GitHub o uno de `npm run respaldo`).
// Uso:  npm run restore -- <archivo>                                   -> base local (wrangler dev)
//       npm run restore -- <archivo> --remote --si-produccion          -> base de PRODUCCIÓN
// Deja la base igual al respaldo: lo que cambió se regresa y lo que se creó después queda borrado. Al terminar
// compara la base contra el respaldo y avisa si algo no coincide. Antes de tocar producción guarda una copia
// de cómo estaba, por si hay que deshacer.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { validarRespaldo, sqlRestauracion, huella, armarRespaldo } from '../src/formato-respaldo.js';
import { d1 } from './d1.mjs';

const args = process.argv.slice(2);
const archivo = args.find((a) => !a.startsWith('--'));
const remoto = args.includes('--remote');
if (!archivo) {
	console.error('Falta el archivo. Uso: npm run restore -- <archivo> [--remote --si-produccion]');
	process.exit(1);
}
if (remoto && !args.includes('--si-produccion')) {
	console.error('Esto reemplaza la base de PRODUCCIÓN. Si es lo que quieres, agrega --si-produccion.');
	process.exit(1);
}
const respaldo = JSON.parse(readFileSync(archivo, 'utf8'));
const malo = validarRespaldo(respaldo);
if (malo) {
	console.error(malo);
	process.exit(1);
}

const db = d1(remoto);
const leerTodo = () => db.consultar('SELECT tipo, id, datos, version, seq, creado, actualizado, borrado, por FROM entidades ORDER BY seq');
const antes = leerTodo();
const contador = (db.consultar('SELECT seq FROM contador WHERE id = 1')[0] || {}).seq || 0;

mkdirSync('respaldos', { recursive: true });
if (remoto) {
	const copia = `respaldos/antes-de-restaurar-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
	writeFileSync(copia, JSON.stringify(armarRespaldo({ entidades: antes, contador, meta: db.consultar('SELECT clave, valor FROM meta'), origen: 'antes de restaurar' })));
	console.log(`Copia de cómo estaba producción: ${copia}`);
}

mkdirSync('.wrangler/tmp', { recursive: true });
const sql = '.wrangler/tmp/restaurar.sql';
writeFileSync(sql, sqlRestauracion(respaldo, antes, contador));
try {
	db.ejecutarArchivo(sql);
} finally {
	rmSync(sql, { force: true });
}

// Comprobación: lo del respaldo quedó idéntico y lo demás quedó borrado.
const despues = leerTodo();
const claves = new Set(respaldo.entidades.map((e) => e.tipo + '|' + e.id));
const iguales = huella(despues.filter((f) => claves.has(f.tipo + '|' + f.id))) === huella(respaldo.entidades);
const sobrantes = despues.filter((f) => !claves.has(f.tipo + '|' + f.id) && !Number(f.borrado));
if (!iguales || sobrantes.length) {
	console.error(`La comprobación falló: ${iguales ? '' : 'los datos no coinciden con el respaldo. '}${sobrantes.length ? sobrantes.length + ' elementos que no estaban siguen activos.' : ''}`);
	process.exit(1);
}
const borrados = despues.filter((f) => !claves.has(f.tipo + '|' + f.id)).length;
console.log(`Restaurado y comprobado: ${respaldo.entidades.length} elementos iguales al respaldo del ${respaldo.generado}${borrados ? `; ${borrados} creados después quedaron borrados` : ''}.`);
console.log('Las pantallas abiertas reciben los cambios solas; si alguien ve algo raro, que recargue la página.');
