// Descarga un respaldo de la base a un archivo, en el mismo formato que el respaldo diario de GitHub.
// Uso:  npm run respaldo                      -> base local (wrangler dev)
//       npm run respaldo -- --remote          -> base de producción
//       npm run respaldo -- --salida archivo.json
// Los respaldos llevan datos personales: se guardan en respaldos/ (fuera de git) y nunca se commitean.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { armarRespaldo } from '../src/formato-respaldo.js';
import { d1 } from './d1.mjs';

const args = process.argv.slice(2);
const remoto = args.includes('--remote');
const i = args.indexOf('--salida');
const marca = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const salida = i > -1 ? args[i + 1] : `respaldos/${remoto ? 'produccion' : 'local'}-${marca}.json`;

const db = d1(remoto);
const respaldo = armarRespaldo({
	entidades: db.consultar('SELECT tipo, id, datos, version, seq, creado, actualizado, borrado, por FROM entidades ORDER BY seq'),
	contador: (db.consultar('SELECT seq FROM contador WHERE id = 1')[0] || {}).seq,
	meta: db.consultar('SELECT clave, valor FROM meta'),
	origen: remoto ? 'npm run respaldo (producción)' : 'npm run respaldo (local)',
});
mkdirSync(dirname(salida), { recursive: true });
writeFileSync(salida, JSON.stringify(respaldo));
console.log(`Listo: ${respaldo.entidades.length} elementos de la base ${remoto ? 'de PRODUCCIÓN' : 'local'} en ${salida}`);
