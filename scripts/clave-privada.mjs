// Genera el valor del secreto PRIVADO_CLAVE (contraseña del panel privado, cifrada con PBKDF2).
// La contraseña se lee de la entrada estándar (no de los argumentos), y la salida va directo a wrangler:
//   PowerShell:  "tu-contraseña" | node scripts/clave-privada.mjs | npx.cmd wrangler secret put PRIVADO_CLAVE
// Nunca la escribas en un archivo del repositorio.
import { hashClave } from '../src/privado.js';

let entrada = '';
for await (const trozo of process.stdin) entrada += trozo;
const clave = entrada.replace(/\r?\n$/, '');
if (clave.length < 4) {
	console.error('La contraseña debe tener al menos 4 caracteres.');
	process.exit(1);
}
process.stdout.write(await hashClave(clave));
