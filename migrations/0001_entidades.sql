-- Una fila por elemento (tarea, cuenta, nota, usuario…), con su JSON.
-- `seq` es global y creciente: sirve de cursor para que cada pantalla pida solo lo que cambió.
-- `version` detecta escrituras simultáneas sobre el mismo elemento (control optimista).
CREATE TABLE IF NOT EXISTS entidades (
	tipo        TEXT    NOT NULL,
	id          TEXT    NOT NULL,
	datos       TEXT    NOT NULL,
	version     INTEGER NOT NULL DEFAULT 1,
	seq         INTEGER NOT NULL,
	creado      INTEGER NOT NULL,
	actualizado TEXT    NOT NULL,
	borrado     INTEGER NOT NULL DEFAULT 0,
	por         TEXT,
	PRIMARY KEY (tipo, id)
);
CREATE INDEX IF NOT EXISTS idx_entidades_seq ON entidades (seq);

CREATE TABLE IF NOT EXISTS contador (
	id  INTEGER PRIMARY KEY CHECK (id = 1),
	seq INTEGER NOT NULL
);
INSERT OR IGNORE INTO contador (id, seq) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS meta (
	clave TEXT PRIMARY KEY,
	valor TEXT NOT NULL
);
