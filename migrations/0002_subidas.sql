-- Subidas en curso a R2 (multipart). Una fila por archivo que se está subiendo; se borra al completar o abortar.
-- El uploadId de R2 y la llave del objeto viven solo aquí: la pantalla nunca los elige.
-- UNIQUE (entrega_id, version) reserva el número de versión, para que dos subidas a la vez no usen la misma llave.
CREATE TABLE IF NOT EXISTS subidas (
	id         TEXT    PRIMARY KEY,
	upload_id  TEXT    NOT NULL,
	r2_key     TEXT    NOT NULL,
	entrega_id TEXT    NOT NULL,
	version    INTEGER NOT NULL,
	por        TEXT    NOT NULL,
	datos      TEXT    NOT NULL,
	tamano     INTEGER NOT NULL,
	parte      INTEGER NOT NULL,
	partes     INTEGER NOT NULL,
	creado     TEXT    NOT NULL,
	UNIQUE (entrega_id, version)
);

-- Partes ya recibidas de cada subida (número y etag que devolvió R2).
CREATE TABLE IF NOT EXISTS subida_partes (
	subida TEXT    NOT NULL,
	n      INTEGER NOT NULL,
	etag   TEXT    NOT NULL,
	tamano INTEGER NOT NULL,
	PRIMARY KEY (subida, n)
);
