// Centro Eureka Hub: Worker principal.
// F0: solo responde que está vivo. La autenticación (JWT de Access), /api/yo, bootstrap y sync llegan en F1.

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === '/api/salud') {
			return Response.json({ ok: true, fase: 'F0' });
		}
		if (url.pathname.startsWith('/api/')) {
			return Response.json({ error: 'No existe' }, { status: 404 });
		}
		return env.ASSETS.fetch(request);
	},
};
