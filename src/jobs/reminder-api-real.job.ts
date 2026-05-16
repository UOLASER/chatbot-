import cron from "node-cron";
import dayjs from "dayjs";
import "dayjs/locale/es";
import config from "../config/env";
import logger from "../utils/logger";
import apiUOLaserService from "../services/api-uolaser.service.js";
import metaWhatsappService from "../services/meta-whatsapp.service";
import googleSheetsService from "../services/google-sheets.service";
import { guardarMensaje, yaSeEnvioMensaje } from "../database/db";

dayjs.locale("es");

/**
 * Formatea la hora del formato 755 a "7:55 AM"
 */
function formatearHora(hora: number, ampm: string): string {
  const horaStr = hora.toString().padStart(4, "0");
  const horas = horaStr.substring(0, 2);
  const minutos = horaStr.substring(2, 4);
  return `${parseInt(horas)}:${minutos} ${ampm}`;
}

/**
 * Formatea la fecha de "2025-10-22" a "miércoles, 22 de octubre de 2025"
 */
function formatearFecha(fechaStr: string): string {
  const fecha = dayjs(fechaStr);
  return fecha.format("dddd, D [de] MMMM [de] YYYY");
}

/**
 * Extrae el primer número de teléfono y agrega +57 si es necesario
 * Limita a exactamente 10 dígitos (formato colombiano)
 */
function extraerPrimerTelefono(telefono: string): string {
  if (!telefono) return "";

  // Limpiar el string completo primero
  telefono = telefono.trim();

  // Si ya empieza con +57, extraer solo el número después del +57
  if (telefono.startsWith("+57")) {
    const numeroSolo = telefono
      .substring(3)
      .split(/[\s\-\/]+/)[0]
      .replace(/[^\d]/g, "");
    // Tomar exactamente los primeros 10 dígitos
    if (numeroSolo.length >= 10) {
      return `+57${numeroSolo.substring(0, 10)}`;
    }
  }

  // Dividir por cualquier separador: guiones (-), barras (/), espacios múltiples
  const numeros = telefono.split(/[\s\-\/]+/);

  // Tomar el primer número y limpiar cualquier carácter que no sea dígito
  const primerNumero = numeros[0].trim().replace(/[^\d]/g, "");

  // Validar que tenga al menos 10 dígitos (números colombianos)
  if (primerNumero.length < 10) {
    return "";
  }

  // Tomar exactamente los primeros 10 dígitos y agregar +57
  return `+57${primerNumero.substring(0, 10)}`;
}

/**
 * Limpia y formatea las observaciones
 */
function limpiarObservacion(obs: string): string {
  if (!obs) return "Sin observaciones adicionales";

  return obs
    .replace(/\\n/g, " - ")
    .replace(/\n/g, " - ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 500);
}

/**
 * Obtiene la dirección según la sede
 */
function obtenerDireccion(sede: string): string {
  const sedeUpper = sede.toUpperCase();

  if (sedeUpper.includes("PEREIRA")) {
    return "Av Circunvalar Carrera 13 #9-42";
  } else if (sedeUpper.includes("DOSQUEBRADAS")) {
    return "Carrera 16 #16-40 barrio valher";
  }

  return sede;
}

/**
 * Procesa una cita para enviar mensaje
 * @param cita Cita del API
 * @param fechaConsultada Fecha que SE CONSULTÓ (no confiar en cita.requerida del API)
 */
function procesarCita(cita: any, fechaConsultada: string) {
  // Extraer solo el primer nombre
  const nombreCompleto = cita.nombre || "";
  const primerNombre = nombreCompleto.split(" ")[0];

  return {
    citaId: cita.id,
    telefono: extraerPrimerTelefono(cita.telefono),
    nombre: primerNombre,
    fecha: formatearFecha(fechaConsultada), // ⭐ Usar fecha consultada, NO cita.requerida (tiene bug en API)
    hora: formatearHora(cita.hora, cita.ampm),
    medico: cita.medico,
    sede: cita.sede,
    direccion: obtenerDireccion(cita.sede),
    tipo: cita.tipo || "CONSULTA",
    entidad: cita.entidad || "PARTICULAR",
    observacion: limpiarObservacion(cita.observacion),
    fechaCita: fechaConsultada, // ⭐ Usar fecha consultada para guardar en BD
  };
}

/**
 * Job principal: Enviar recordatorios automáticos desde API real
 */
export async function ejecutarRecordatorios(): Promise<void> {
  const inicioEjecucion = Date.now();

  try {
    logger.info("═".repeat(50));
    logger.info("🚀 Iniciando proceso de recordatorios automáticos");
    logger.info("═".repeat(50));

    // 1. Obtener fecha de mañana
    const manana = dayjs().add(1, "day").format("YYYY-MM-DD");
    logger.info(`📅 Obteniendo citas para: ${manana}`);

    // 2. Obtener agendas de ambas sedes
    const citasManana =
      await apiUOLaserService.obtenerAgendasTodasSedes(manana);

    if (citasManana.length === 0) {
      logger.info("⚠️  No hay citas programadas para mañana");
      return;
    }

    logger.info(`📊 Total de citas encontradas: ${citasManana.length}`);

    // 3. Filtrar solo citas con teléfono y que NO estén canceladas
    const citasActivas = citasManana.filter((c) => {
      const estadoLower = (c.estado || "").toLowerCase();
      const estaCancelada =
        estadoLower.includes("cancel") ||
        estadoLower.includes("cancelo") ||
        estadoLower === "cancelado" ||
        estadoLower === "cancelada";

      return c.telefono && !estaCancelada;
    });

    const citasCanceladas = citasManana.length - citasActivas.length;
    logger.info(`📱 Citas activas con teléfono: ${citasActivas.length}`);
    if (citasCanceladas > 0) {
      logger.info(`🚫 Citas canceladas (omitidas): ${citasCanceladas}`);
    }

    if (citasActivas.length === 0) {
      logger.warn("⚠️  No hay citas activas con teléfono para enviar");
      return;
    }

    // 4. Filtrar citas que ya fueron enviadas (evitar duplicados)
    const citasSinEnviar = citasActivas.filter((cita) => {
      return !yaSeEnvioMensaje(cita.id, manana); // ⭐ Usar fecha consultada, no cita.requerida
    });

    if (citasSinEnviar.length < citasActivas.length) {
      logger.info(
        `🔄 Se omitieron ${citasActivas.length - citasSinEnviar.length} citas (ya enviadas)`,
      );
    }

    if (citasSinEnviar.length === 0) {
      logger.info("✅ Todos los mensajes ya fueron enviados");
      return;
    }

    // 5. Enviar mensajes
    const templateName = config.meta.templateName;
    logger.info(`📝 Usando plantilla: ${templateName}`);
    logger.info(`📤 Enviando ${citasSinEnviar.length} mensajes...\n`);

    let exitosos = 0;
    let fallidos = 0;

    for (const cita of citasSinEnviar) {
      const procesada = procesarCita(cita, manana); // ⭐ Pasar fecha consultada

      // Verificar que tenga número válido
      if (!procesada.telefono) {
        logger.warn(
          `⚠️  Saltando cita ${procesada.citaId} - sin teléfono válido`,
        );
        googleSheetsService.registrarMensaje({
          paciente: procesada.nombre,
          telefono: cita.telefono || "sin teléfono",
          medico: procesada.medico,
          sede: procesada.sede,
          fechaCita: procesada.fechaCita,
          horaCita: procesada.hora,
          estado: "failed",
          error: `Número inválido en sistema: "${cita.telefono}"`,
        }).catch(() => {});
        continue;
      }

      try {
        // Crear parámetros para la plantilla (10 parámetros)
        const parametros = [
          procesada.nombre, // {{1}}
          procesada.fecha, // {{2}}
          procesada.hora, // {{3}}
          procesada.medico, // {{4}}
          procesada.sede, // {{5}}
          procesada.direccion, // {{6}}
          procesada.tipo, // {{7}}
          procesada.entidad, // {{8}}
          procesada.observacion, // {{9}}
          `WhatsApp ${config.whatsapp.contacto} o llamando al ${config.whatsapp.telefonoFijo}`, // {{10}}
        ];

        // Enviar mensaje
        const resultado = await metaWhatsappService.enviarMensajePlantilla(
          procesada.telefono,
          templateName,
          parametros,
        );

        if (resultado.success) {
          logger.info(
            `✅ Enviado a ${procesada.nombre} (${procesada.telefono}) - ID: ${resultado.messageId}`,
          );

          guardarMensaje({
            citaId: procesada.citaId,
            nombrePaciente: procesada.nombre,
            telefono: procesada.telefono,
            mensaje: `Recordatorio para ${procesada.fecha} a las ${procesada.hora}`,
            plantillaId: templateName,
            metaMessageId: resultado.messageId,
            estado: "sent",
            fechaCita: procesada.fechaCita,
            medico: procesada.medico,
            sede: procesada.sede,
          });

          googleSheetsService.registrarMensaje({
            paciente: procesada.nombre,
            telefono: procesada.telefono,
            medico: procesada.medico,
            sede: procesada.sede,
            fechaCita: procesada.fechaCita,
            horaCita: procesada.hora,
            estado: "sent",
            metaMessageId: resultado.messageId,
          }).catch(() => {});

          exitosos++;
        } else {
          logger.error(
            `❌ Error al enviar a ${procesada.nombre}: ${resultado.error}`,
          );

          guardarMensaje({
            citaId: procesada.citaId,
            nombrePaciente: procesada.nombre,
            telefono: procesada.telefono,
            mensaje: `Recordatorio para ${procesada.fecha} a las ${procesada.hora}`,
            plantillaId: templateName,
            estado: "failed",
            fechaCita: procesada.fechaCita,
            medico: procesada.medico,
            sede: procesada.sede,
          });

          googleSheetsService.registrarMensaje({
            paciente: procesada.nombre,
            telefono: procesada.telefono,
            medico: procesada.medico,
            sede: procesada.sede,
            fechaCita: procesada.fechaCita,
            horaCita: procesada.hora,
            estado: "failed",
            error: resultado.error,
          }).catch(() => {});

          fallidos++;
        }

        // Delay de 500ms entre mensajes (Meta permite 80/seg)
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error: any) {
        logger.error(
          `❌ Error inesperado con ${procesada.nombre}: ${error.message}`,
        );
        fallidos++;
      }
    }

    // Resumen final
    const duracion = ((Date.now() - inicioEjecucion) / 1000).toFixed(2);
    logger.info("\n" + "═".repeat(50));
    logger.info("📊 RESUMEN DE ENVÍO");
    logger.info("═".repeat(50));
    logger.info(`   📨 Total procesados:  ${citasSinEnviar.length}`);
    logger.info(`   ✅ Exitosos:          ${exitosos}`);
    logger.info(`   ❌ Fallidos:          ${fallidos}`);
    logger.info(
      `   📈 Tasa de éxito:     ${((exitosos / citasSinEnviar.length) * 100).toFixed(1)}%`,
    );
    logger.info(`   ⏱️  Duración:          ${duracion}s`);
    logger.info("═".repeat(50));
  } catch (error: any) {
    logger.error("❌ Error fatal en el job de recordatorios:", error.message);
    logger.error(error);
  }
}

/**
 * Inicializar el cron job
 */
export function iniciarCronJob(): void {
  const schedule = config.cron.schedule; // "0 8 * * *" = 8:00 AM diario

  logger.info("🤖 Iniciando cron job de recordatorios automáticos");
  logger.info(`   ⏰ Horario: ${schedule}`);
  logger.info(`   🌍 Zona horaria: ${config.cron.timezone}`);

  cron.schedule(schedule, ejecutarRecordatorios, {
    timezone: config.cron.timezone,
  });

  logger.info("✅ Cron job inicializado correctamente");
}
