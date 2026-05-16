import express, { Request, Response } from "express";
import { validateConfig } from "./config/env";
import config from "./config/env";
import logger from "./utils/logger";
import metaWhatsappService from "./services/meta-whatsapp.service";
import metaTemplateService from "./services/meta-template.service";
import {
  iniciarCronJob,
  ejecutarRecordatorios,
} from "./jobs/reminder-api-real.job";
import {
  initDatabase,
  obtenerEstadisticasHoy,
  closeDatabase,
  guardarWebhook,
  actualizarMensajeDesdeWebhook,
} from "./database/db";

// Validar configuración al iniciar
validateConfig();

// Inicializar base de datos
initDatabase();

const app = express();
const PORT = config.server.port;

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Ruta de health check
 */
app.get("/health", (_req: Request, res: Response) => {
  const stats = obtenerEstadisticasHoy();

  res.json({
    status: "ok",
    service: "chatbot-recordatorios-meta",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
    metaConfigured: metaWhatsappService.verificarConfiguracion(),
    database: "connected",
    stats_today: stats,
  });
});

/**
 * Ruta para verificar configuración de Meta
 */
app.get("/api/meta/estado", async (_req: Request, res: Response) => {
  const configurado = metaWhatsappService.verificarConfiguracion();

  let perfilNegocio = null;
  if (configurado) {
    try {
      perfilNegocio = await metaWhatsappService.obtenerPerfilNegocio();
    } catch (error) {
      logger.error("Error al obtener perfil de negocio:", error);
    }
  }

  res.json({
    configurado,
    mensaje: configurado
      ? "✅ Meta WhatsApp Business API configurado correctamente"
      : "❌ Falta configurar META_ACCESS_TOKEN y META_PHONE_NUMBER_ID en .env",
    perfil: perfilNegocio,
  });
});

/**
 * Ruta para ejecutar recordatorios manualmente
 */
app.post(
  "/api/ejecutar-recordatorios",
  async (_req: Request, res: Response) => {
    try {
      logger.info("📞 Solicitud manual de ejecución de recordatorios");

      // Ejecutar en segundo plano
      ejecutarRecordatorios().catch((error) => {
        logger.error("Error en ejecución manual:", error);
      });

      res.json({
        success: true,
        message:
          "Proceso de recordatorios iniciado con Meta WhatsApp Business API",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Error al ejecutar recordatorios:", error);
      res.status(500).json({
        success: false,
        message: "Error al ejecutar recordatorios",
      });
    }
  },
);

/**
 * Ruta para enviar mensaje de prueba con Meta WhatsApp
 */
app.post("/api/prueba-whatsapp", async (req: Request, res: Response) => {
  try {
    const { telefono, ...citaData } = req.body;

    if (!telefono) {
      return res.status(400).json({
        success: false,
        message: 'Falta el parámetro "telefono"',
      });
    }

    logger.info(
      `🧪 Enviando mensaje de prueba a ${telefono} por Meta WhatsApp`,
    );

    // Si hay datos de cita completos, usar plantilla
    if (citaData.nombre && citaData.medico && citaData.sede) {
      const templateName = metaTemplateService.obtenerNombrePlantilla();
      const parametros = metaTemplateService.crearParametros(citaData as any);

      const resultado = await metaWhatsappService.enviarMensajePlantilla(
        telefono,
        templateName,
        parametros,
      );

      if (resultado.success) {
        return res.json({
          success: true,
          message: "✅ Mensaje enviado por Meta WhatsApp",
          telefono,
          messageId: resultado.messageId,
        });
      } else {
        return res.status(500).json({
          success: false,
          message: "❌ Error al enviar mensaje por Meta WhatsApp",
          error: resultado.error,
        });
      }
    }

    // Si no hay datos de cita, enviar mensaje de prueba simple
    const resultado = await metaWhatsappService.enviarMensajePrueba(telefono);

    if (resultado) {
      return res.json({
        success: true,
        message: "✅ Mensaje de prueba enviado por Meta WhatsApp",
        telefono,
      });
    } else {
      return res.status(500).json({
        success: false,
        message: "❌ Error al enviar mensaje de prueba",
      });
    }
  } catch (error) {
    logger.error("Error al enviar mensaje de prueba:", error);
    return res.status(500).json({
      success: false,
      message: "Error al enviar mensaje de prueba",
    });
  }
});

/**
 * Webhook Meta: verificación del endpoint (GET)
 * Meta llama a esta ruta al registrar el webhook para confirmar que es válido
 */
app.get(config.server.webhookPath, (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.meta.webhookVerifyToken) {
    logger.info("✅ Webhook de Meta verificado correctamente");
    return res.status(200).send(challenge);
  }

  logger.warn("⚠️  Intento de verificación de webhook con token inválido");
  return res.sendStatus(403);
});

/**
 * Webhook Meta: recibir eventos de estado de mensajes (POST)
 * Meta envía aquí las actualizaciones: sent, delivered, read, failed
 */
app.post(config.server.webhookPath, (req: Request, res: Response) => {
  // Responder 200 inmediatamente para que Meta no reintente
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") return;

    const entries = body.entry || [];

    for (const entry of entries) {
      const changes = entry.changes || [];

      for (const change of changes) {
        const value = change.value;

        // Procesar actualizaciones de estado de mensajes enviados
        const statuses = value?.statuses || [];
        for (const status of statuses) {
          const messageId: string = status.id;
          const estado: string = status.status; // sent, delivered, read, failed
          const telefono: string = status.recipient_id;

          guardarWebhook({
            tipo: "status_update",
            metaMessageId: messageId,
            telefono,
            estado,
            timestampMeta: status.timestamp,
            payload: status,
          });

          actualizarMensajeDesdeWebhook(messageId, estado);

          logger.info(`📩 Webhook: mensaje ${messageId} → ${estado} (${telefono})`);
        }

        // Procesar mensajes entrantes y responder automáticamente
        const messages = value?.messages || [];
        for (const message of messages) {
          const telefono: string = message.from;
          const tipo: string = message.type;

          guardarWebhook({
            tipo: "incoming_message",
            metaMessageId: message.id,
            telefono,
            estado: "received",
            timestampMeta: message.timestamp,
            payload: message,
          });

          logger.info(`💬 Mensaje entrante de ${telefono} (tipo: ${tipo})`);

          // Marcar como leído y enviar auto-reply
          metaWhatsappService.marcarComoLeido(message.id).catch(() => {});

          const textoRespuesta =
            `Hola 👋 Este número es exclusivo para el envío de *recordatorios de citas* de UOLaser.\n\n` +
            `Para cancelar o reprogramar su cita, comuníquese con nosotros:\n` +
            `📱 WhatsApp: *${config.whatsapp.contacto}*\n` +
            `📞 Teléfono: *${config.whatsapp.telefonoFijo}*`;

          metaWhatsappService.enviarMensajeTexto(telefono, textoRespuesta)
            .then((resultado) => {
              if (resultado.success) {
                logger.info(`✅ Auto-reply enviado a ${telefono}`);
              } else {
                logger.warn(`⚠️ No se pudo enviar auto-reply a ${telefono}: ${resultado.error}`);
              }
            })
            .catch((err) => {
              logger.error(`❌ Error en auto-reply a ${telefono}:`, err.message);
            });
        }
      }
    }
  } catch (error) {
    logger.error("❌ Error procesando webhook de Meta:", error);
  }
});

/**
 * Ruta para obtener estadísticas
 */
app.get("/api/estadisticas", (_req: Request, res: Response) => {
  try {
    const stats = obtenerEstadisticasHoy();

    res.json({
      success: true,
      fecha: new Date().toLocaleDateString("es-CO"),
      estadisticas: stats,
    });
  } catch (error) {
    logger.error("Error al obtener estadísticas:", error);
    res.status(500).json({
      success: false,
      message: "Error al obtener estadísticas",
    });
  }
});

/**
 * Iniciar servidor
 */
function iniciarServidor() {
  // Verificar configuración de Meta WhatsApp
  logger.info("📱 WhatsApp: Meta Business API");

  if (metaWhatsappService.verificarConfiguracion()) {
    logger.info("✅ Meta WhatsApp Business API configurado correctamente");
  } else {
    logger.warn(
      "⚠️  Meta WhatsApp NO configurado. Configura .env antes de usar.",
    );
    logger.warn("📖 Lee docs/SETUP-META-WHATSAPP.md para instrucciones");
  }

  // Iniciar cron job
  iniciarCronJob();

  // Iniciar servidor Express
  app.listen(PORT, () => {
    logger.info("═══════════════════════════════════════════════════");
    logger.info("🚀 Sistema de Recordatorios Iniciado (Meta WhatsApp)");
    logger.info("═══════════════════════════════════════════════════");
    logger.info(`   🌐 Servidor: http://localhost:${PORT}`);
    logger.info(`   📡 Health Check: http://localhost:${PORT}/health`);
    logger.info(
      `   📊 Estadísticas: http://localhost:${PORT}/api/estadísticas`,
    );
    logger.info("═══════════════════════════════════════════════════");
  });
}

// Manejo de errores no capturados
process.on("unhandledRejection", (reason, promise) => {
  logger.error("❌ Unhandled Rejection:", { reason, promise });
});

process.on("uncaughtException", (error) => {
  logger.error("❌ Uncaught Exception:", error);
  closeDatabase();
  process.exit(1);
});

// Manejo de señales de terminación
process.on("SIGTERM", () => {
  logger.info("👋 SIGTERM recibido, cerrando servidor...");
  closeDatabase();
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("👋 SIGINT recibido, cerrando servidor...");
  closeDatabase();
  process.exit(0);
});

// Iniciar aplicación
iniciarServidor();
