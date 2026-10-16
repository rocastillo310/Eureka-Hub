-- Historial de cambios sensibles (panel de administración): permisos y equipo, reglas, cuentas eliminadas,
-- integraciones y respaldos. Solo se añade; lo leen Rodrigo y Dani desde /admin.
CREATE TABLE IF NOT EXISTS bitacora (
	id      INTEGER PRIMARY KEY AUTOINCREMENT,
	t       TEXT    NOT NULL,
	por     TEXT    NOT NULL,
	accion  TEXT    NOT NULL,
	detalle TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS bitacora_t ON bitacora (t);
