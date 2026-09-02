import Database, { type Database as DatabaseType } from "better-sqlite3";
import path from "path";
import fs from "fs";
import logger from "../utils/logger";

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "recordatorios.db");

// Crear directorio si no existe
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Conexión a la base de datos
const dbConnection: DatabaseType = new Database(DB_PATH);

// Habilitar WAL mode para mejor performance
dbConnection.pragma("journal_mode = WAL");

/**
 * Inicializar esquema de base de datos
 */
export function initDatabase(): void {
  logger.info("🗄️  Inicializando base de datos...");

  // Tabla de mensajes enviados
  dbConnection.exec(`
    CREATE TABLE IF NOT EXISTS mensajes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cita_id INTEGER NOT NULL,
      nombre_paciente TEXT NOT NULL,
      telefono TEXT NOT NULL,
      mensaje TEXT NOT NULL,
      plantilla_id TEXT,
      estado TEXT DEFAULT 'pending', -- pending, sent, delivered, read, failed
      meta_message_id TEXT,
      error_mensaje TEXT,
      intentos INTEGER DEFAULT 0,
      fecha_envio DATETIME DEFAULT CURRENT_TIMESTAMP,
      fecha_entrega DATETIME,
      fecha_lectura DATETIME,
      fecha_cita DATE NOT NULL,
      medico TEXT,
      sede TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Índices para búsquedas rápidas
  dbConnection.exec(`
    CREATE INDEX IF NOT EXISTS idx_cita_id ON mensajes(cita_id);
    CREATE INDEX IF NOT EXISTS idx_telefono ON mensajes(telefono);
    CREATE INDEX IF NOT EXISTS idx_fecha_cita ON mensajes(fecha_cita);
    CREATE INDEX IF NOT EXISTS idx_estado ON mensajes(estado);
    CREATE INDEX IF NOT EXISTS idx_meta_message_id ON mensajes(meta_message_id);
  `);

  // Tabla de logs de ejecución
  dbConnection.exec(`
    CREATE TABLE IF NOT EXISTS ejecuciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL, -- 'cron' o 'manual'
      citas_procesadas INTEGER DEFAULT 0,
      mensajes_enviados INTEGER DEFAULT 0,
      mensajes_exitosos INTEGER DEFAULT 0,
      mensajes_fallidos INTEGER DEFAULT 0,
      duracion_ms INTEGER,
      error TEXT,
      fecha_inicio DATETIME DEFAULT CURRENT_TIMESTAMP,
      fecha_fin DATETIME
    )
  `);

  // Tabla de configuración (para guardar estado)
  dbConnection.exec(`
    CREATE TABLE IF NOT EXISTS configuracion (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL,
      descripcion TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tabla de webhooks recibidos
  dbConnection.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      meta_message_id TEXT,
      telefono TEXT,
      estado TEXT,
      timestamp_meta TEXT,
      payload TEXT, -- JSON completo del webhook
      procesado BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  dbConnection.exec(`
    CREATE INDEX IF NOT EXISTS idx_webhook_message_id ON webhooks(meta_message_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_procesado ON webhooks(procesado);
  `);

  logger.info("✅ Base de datos inicializada correctamente");
}

/**
 * Guardar mensaje enviado
 */
export interface MensajeData {
  citaId: number;
  nombrePaciente: string;
  telefono: string;
  mensaje: string;
  plantillaId?: string;
  metaMessageId?: string;
  estado?: "pending" | "sent" | "delivered" | "read" | "failed";
  fechaCita: string;
  medico: string;
  sede: string;
}

export function guardarMensaje(data: MensajeData): number {
  const stmt = dbConnection.prepare(`
    INSERT INTO mensajes (
      cita_id, nombre_paciente, telefono, mensaje, plantilla_id,
      meta_message_id, estado, fecha_cita, medico, sede
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    data.citaId,
    data.nombrePaciente,
    data.telefono,
    data.mensaje,
    data.plantillaId || null,
    data.metaMessageId || null,
    data.estado || "pending",
    data.fechaCita,
    data.medico,
    data.sede
  );

  return result.lastInsertRowid as number;
}

/**
 * Actualizar estado del mensaje
 */
export function actualizarEstadoMensaje(
  id: number,
  estado: "sent" | "delivered" | "read" | "failed",
  metaMessageId?: string,
  error?: string
): void {
  let sql = "UPDATE mensajes SET estado = ?, updated_at = CURRENT_TIMESTAMP";
  const params: any[] = [estado];

  if (estado === "sent") {
    sql += ", meta_message_id = ?, fecha_envio = CURRENT_TIMESTAMP";
    params.push(metaMessageId);
  } else if (estado === "delivered") {
    sql += ", fecha_entrega = CURRENT_TIMESTAMP";
  } else if (estado === "read") {
    sql += ", fecha_lectura = CURRENT_TIMESTAMP";
  } else if (estado === "failed") {
    sql += ", error_mensaje = ?, intentos = intentos + 1";
    params.push(error);
  }

  sql += " WHERE id = ?";
  params.push(id);

  const stmt = dbConnection.prepare(sql);
  stmt.run(...params);
}

/**
 * Verificar si ya se envió mensaje para una cita
 */
export function yaSeEnvioMensaje(citaId: number, fechaCita: string): boolean {
  const stmt = dbConnection.prepare(`
    SELECT COUNT(*) as count 
    FROM mensajes 
    WHERE cita_id = ? 
    AND fecha_cita = ?
    AND estado IN ('sent', 'delivered', 'read')
  `);

  const result = stmt.get(citaId, fechaCita) as { count: number };
  return result.count > 0;
}

/**
 * Obtener mensajes por estado
 */
export function obtenerMensajesPorEstado(estado: string) {
  const stmt = dbConnection.prepare(`
    SELECT * FROM mensajes 
    WHERE estado = ? 
    ORDER BY created_at DESC
  `);
  return stmt.all(estado);
}

/**
 * Obtener estadísticas del día
 */
export interface Estadisticas {
  total_enviados: number;
  total_entregados: number;
  total_leidos: number;
  total_fallidos: number;
  tasa_entrega: number;
  tasa_lectura: number;
}

export function obtenerEstadisticasHoy(): Estadisticas {
  const stmt = dbConnection.prepare(`
    SELECT 
      COUNT(*) as total_enviados,
      SUM(CASE WHEN estado IN ('delivered', 'read') THEN 1 ELSE 0 END) as total_entregados,
      SUM(CASE WHEN estado = 'read' THEN 1 ELSE 0 END) as total_leidos,
      SUM(CASE WHEN estado = 'failed' THEN 1 ELSE 0 END) as total_fallidos
    FROM mensajes
    WHERE DATE(created_at) = DATE('now', 'localtime')
  `);

  const result = stmt.get() as any;

  return {
    total_enviados: result.total_enviados || 0,
    total_entregados: result.total_entregados || 0,
    total_leidos: result.total_leidos || 0,
    total_fallidos: result.total_fallidos || 0,
    tasa_entrega:
      result.total_enviados > 0
        ? (result.total_entregados / result.total_enviados) * 100
        : 0,
    tasa_lectura:
      result.total_enviados > 0
        ? (result.total_leidos / result.total_enviados) * 100
        : 0,
  };
}

/**
 * Registrar ejecución del job
 */
export function registrarEjecucion(tipo: "cron" | "manual") {
  const stmt = dbConnection.prepare(`
    INSERT INTO ejecuciones (tipo) VALUES (?)
  `);
  const result = stmt.run(tipo);
  return result.lastInsertRowid as number;
}

/**
 * Finalizar ejecución del job
 */
export function finalizarEjecucion(
  id: number,
  stats: {
    citasProcesadas: number;
    mensajesEnviados: number;
    mensajesExitosos: number;
    mensajesFallidos: number;
    duracionMs: number;
    error?: string;
  }
): void {
  const stmt = dbConnection.prepare(`
    UPDATE ejecuciones SET
      citas_procesadas = ?,
      mensajes_enviados = ?,
      mensajes_exitosos = ?,
      mensajes_fallidos = ?,
      duracion_ms = ?,
      error = ?,
      fecha_fin = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  stmt.run(
    stats.citasProcesadas,
    stats.mensajesEnviados,
    stats.mensajesExitosos,
    stats.mensajesFallidos,
    stats.duracionMs,
    stats.error || null,
    id
  );
}

/**
 * Guardar webhook recibido
 */
export function guardarWebhook(data: {
  tipo: string;
  metaMessageId?: string;
  telefono?: string;
  estado?: string;
  timestampMeta?: string;
  payload: any;
}) {
  const stmt = dbConnection.prepare(`
    INSERT INTO webhooks (tipo, meta_message_id, telefono, estado, timestamp_meta, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    data.tipo,
    data.metaMessageId || null,
    data.telefono || null,
    data.estado || null,
    data.timestampMeta || null,
    JSON.stringify(data.payload)
  );
}

/**
 * Actualizar mensaje desde webhook
 */
export function actualizarMensajeDesdeWebhook(
  metaMessageId: string,
  estado: string
): void {
  let estadoDb = "sent";
  let campoFecha = "";

  switch (estado) {
    case "sent":
      estadoDb = "sent";
      break;
    case "delivered":
      estadoDb = "delivered";
      campoFecha = ", fecha_entrega = CURRENT_TIMESTAMP";
      break;
    case "read":
      estadoDb = "read";
      campoFecha = ", fecha_lectura = CURRENT_TIMESTAMP";
      break;
    case "failed":
      estadoDb = "failed";
      break;
  }

  const stmt = dbConnection.prepare(`
    UPDATE mensajes 
    SET estado = ?${campoFecha}, updated_at = CURRENT_TIMESTAMP
    WHERE meta_message_id = ?
  `);

  stmt.run(estadoDb, metaMessageId);
}

/**
 * Cerrar conexión (para cleanup)
 */
export function closeDatabase(): void {
  dbConnection.close();
  logger.info("🔒 Base de datos cerrada");
}

export default dbConnection;
