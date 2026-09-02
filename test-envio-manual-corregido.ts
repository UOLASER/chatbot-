import dayjs from "dayjs";
import "dayjs/locale/es";
import apiUOLaserService from "./src/services/api-uolaser.service";
import metaWhatsappService from "./src/services/meta-whatsapp.service";

dayjs.locale("es");

// ============================================
// 🎯 CONFIGURACIÓN DE PRUEBA
// ============================================
const MODO_PRUEBA = false;           // true = solo muestra, NO envía
const NUMERO_PRUEBA = "+573216779467"; // Tu número para pruebas
const SOLO_ESTE_NUMERO = true;       // true = envía solo a NUMERO_PRUEBA
const DATOS_QUEMADOS = true;         // true = usa datos ficticios (no consulta la API)

// Datos ficticios para prueba — edítalos a tu gusto
const CITA_PRUEBA = {
  nombre:      "Juan",
  fecha:       dayjs().add(1, "day").format("dddd, D [de] MMMM [de] YYYY"),
  hora:        "10:00 AM",
  medico:      "CRISANTO DE JESUS MORENO",
  sede:        "PEREIRA",
  direccion:   "Av Circunvalar Carrera 13 #9-42",
  tipo:        "CONSULTA",
  entidad:     "PARTICULAR",
  observacion: "Traer resultados de exámenes previos",
};

function formatearHora(hora: number, ampm: string): string {
  const horaStr = hora.toString().padStart(4, "0");
  const horas = horaStr.substring(0, 2);
  const minutos = horaStr.substring(2, 4);
  return `${parseInt(horas)}:${minutos} ${ampm}`;
}

function formatearFecha(fechaStr: string): string {
  const fecha = dayjs(fechaStr);
  return fecha.format("dddd, D [de] MMMM [de] YYYY");
}

function extraerPrimerTelefono(telefono: string): string {
  if (!telefono) return "";
  const numeros = telefono.split(" - ");
  const primerNumero = numeros[0].trim();
  if (primerNumero && !primerNumero.startsWith("+")) {
    return `+57${primerNumero}`;
  }
  return primerNumero;
}

function limpiarObservacion(obs: string): string {
  if (!obs) return "Sin observaciones adicionales";
  return obs
    .replace(/\\n/g, " - ")
    .replace(/\n/g, " - ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 500);
}

function obtenerDireccion(sede: string): string {
  const sedeUpper = sede.toUpperCase();
  if (sedeUpper.includes("PEREIRA")) {
    return "Av Circunvalar Carrera 13 #9-42";
  } else if (sedeUpper.includes("DOSQUEBRADAS")) {
    return "Carrera 16 #16-40 barrio valher";
  }
  return sede;
}

function procesarCita(cita: any, fechaConsultada: string) {
  const nombreCompleto = cita.nombre || "";
  const primerNombre = nombreCompleto.split(" ")[0];

  return {
    citaId: cita.id,
    telefono: extraerPrimerTelefono(cita.telefono),
    nombre: primerNombre,
    fecha: formatearFecha(fechaConsultada), // ⭐ USA FECHA CORRECTA
    hora: formatearHora(cita.hora, cita.ampm),
    medico: cita.medico,
    sede: cita.sede,
    direccion: obtenerDireccion(cita.sede),
    tipo: cita.tipo || "CONSULTA",
    entidad: cita.entidad || "PARTICULAR",
    observacion: limpiarObservacion(cita.observacion),
    fechaCita: fechaConsultada,
  };
}

async function pruebaEnvio() {
  try {
    console.log("═".repeat(60));
    console.log("🧪 PRUEBA DE ENVÍO MANUAL CON FECHA CORREGIDA");
    console.log("═".repeat(60));

    const templateName = "recordatorio_cita_contacto_v1";
    let parametros: string[];
    let telefonoDestino: string;

    if (DATOS_QUEMADOS) {
      // ── Modo datos quemados: no consulta la API ──────────────────
      console.log("🔧 Usando datos ficticios (DATOS_QUEMADOS = true)\n");

      parametros = [
        CITA_PRUEBA.nombre,
        CITA_PRUEBA.fecha,
        CITA_PRUEBA.hora,
        CITA_PRUEBA.medico,
        CITA_PRUEBA.sede,
        CITA_PRUEBA.direccion,
        CITA_PRUEBA.tipo,
        CITA_PRUEBA.entidad,
        CITA_PRUEBA.observacion,
        "WhatsApp 320 680 3362 o llamando al 606 3253000",
      ];

      telefonoDestino = NUMERO_PRUEBA;

      console.log("─".repeat(60));
      console.log(`👤 Paciente:  ${CITA_PRUEBA.nombre}`);
      console.log(`📱 Teléfono:  ${telefonoDestino}`);
      console.log(`📅 Fecha:     ${CITA_PRUEBA.fecha}`);
      console.log(`🕐 Hora:      ${CITA_PRUEBA.hora}`);
      console.log(`👨‍⚕️ Médico:   ${CITA_PRUEBA.medico}`);
      console.log(`🏥 Sede:      ${CITA_PRUEBA.sede}`);
      console.log(`📍 Dirección: ${CITA_PRUEBA.direccion}`);

    } else {
      // ── Modo real: consulta la API ────────────────────────────────
      const manana = dayjs().add(1, "day").format("YYYY-MM-DD");
      console.log(`📅 Fecha consultada: ${manana}`);
      console.log(`✅ Fecha formateada: ${formatearFecha(manana)}\n`);

      const citas = await apiUOLaserService.obtenerAgendasTodasSedes(manana);

      const citasActivas = citas.filter((c) => {
        const estadoLower = (c.estado || "").toLowerCase();
        const estaCancelada =
          estadoLower.includes("cancel") ||
          estadoLower.includes("cancelo") ||
          estadoLower === "cancelado" ||
          estadoLower === "cancelada";
        return c.telefono && !estaCancelada;
      });

      console.log(`📊 Citas activas: ${citasActivas.length}\n`);

      if (citasActivas.length === 0) {
        console.log("⚠️  No hay citas activas");
        return;
      }

      for (const cita of citasActivas) {
        const procesada = procesarCita(cita, manana);

        if (SOLO_ESTE_NUMERO && procesada.telefono !== NUMERO_PRUEBA) {
          continue;
        }

        console.log("─".repeat(60));
        console.log(`👤 Paciente: ${procesada.nombre}`);
        console.log(`📱 Teléfono: ${procesada.telefono}`);
        console.log(`📅 Fecha en mensaje: ${procesada.fecha}`);
        console.log(`🕐 Hora: ${procesada.hora}`);
        console.log(`👨‍⚕️ Médico: ${procesada.medico}`);
        console.log(`🏥 Sede: ${procesada.sede}`);
        console.log(`📍 Dirección: ${procesada.direccion}`);

        parametros = [
          procesada.nombre,
          procesada.fecha,
          procesada.hora,
          procesada.medico,
          procesada.sede,
          procesada.direccion,
          procesada.tipo,
          procesada.entidad,
          procesada.observacion,
        ];

        telefonoDestino = procesada.telefono;

        if (MODO_PRUEBA) {
          console.log("🔍 MODO PRUEBA - No se envía, solo se muestra");
          console.log("📋 Parámetros:", JSON.stringify(parametros, null, 2));
        } else {
          console.log("📤 Enviando mensaje...");
          const resultado = await metaWhatsappService.enviarMensajePlantilla(
            telefonoDestino,
            templateName,
            parametros,
          );
          if (resultado.success) {
            console.log(`✅ Enviado - ID: ${resultado.messageId}`);
          } else {
            console.log(`❌ Error: ${resultado.error}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      return;
    }

    // Envío con datos quemados
    if (MODO_PRUEBA) {
      console.log("\n🔍 MODO PRUEBA - No se envía, solo se muestra");
      console.log("📋 Parámetros:", JSON.stringify(parametros, null, 2));
    } else {
      console.log("\n📤 Enviando mensaje...");
      const resultado = await metaWhatsappService.enviarMensajePlantilla(
        telefonoDestino,
        templateName,
        parametros,
      );
      if (resultado.success) {
        console.log(`✅ Enviado - ID: ${resultado.messageId}`);
      } else {
        console.log(`❌ Error: ${resultado.error}`);
      }
    }

    console.log("\n" + "═".repeat(60));
    if (MODO_PRUEBA) {
      console.log("✅ Prueba completada. Para enviar de verdad:");
      console.log("   1. Cambia MODO_PRUEBA = false");
      console.log(
        "   2. Opcional: SOLO_ESTE_NUMERO = true para enviar solo a tu número",
      );
      console.log("   3. Vuelve a ejecutar el script");
    } else {
      console.log("✅ Envío completado");
    }
    console.log("═".repeat(60));
  } catch (error: any) {
    console.error("❌ Error:", error.message);
  }
}

pruebaEnvio();
