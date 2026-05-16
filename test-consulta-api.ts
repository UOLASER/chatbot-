import dayjs from "dayjs";
import "dayjs/locale/es";
import apiUOLaserService from "./src/services/api-uolaser.service";

dayjs.locale("es");

function formatearHora(hora: number, ampm: string): string {
  const horaStr = hora.toString().padStart(4, "0");
  return `${parseInt(horaStr.substring(0, 2))}:${horaStr.substring(2, 4)} ${ampm}`;
}

function extraerPrimerTelefono(telefono: string): string {
  if (!telefono) return "❌ SIN TELÉFONO";
  telefono = telefono.trim();
  if (telefono.startsWith("+57")) {
    const n = telefono.substring(3).split(/[\s\-\/]+/)[0].replace(/[^\d]/g, "");
    return n.length >= 10 ? `+57${n.substring(0, 10)}` : "❌ NÚMERO INVÁLIDO";
  }
  const n = telefono.split(/[\s\-\/]+/)[0].replace(/[^\d]/g, "");
  return n.length >= 10 ? `+57${n.substring(0, 10)}` : "❌ NÚMERO INVÁLIDO";
}

async function consultarAPI() {
  const manana = dayjs().add(1, "day").format("YYYY-MM-DD");
  const mananaFormateado = dayjs().add(1, "day").format("dddd, D [de] MMMM [de] YYYY");

  console.log("═".repeat(60));
  console.log("🔍 CONSULTA DE CITAS MÉDICAS");
  console.log("═".repeat(60));
  console.log(`📅 Consultando citas para: ${manana} (${mananaFormateado})\n`);

  const citas = await apiUOLaserService.obtenerAgendasTodasSedes(manana);

  if (citas.length === 0) {
    console.log("⚠️  No se encontraron citas para mañana");
    return;
  }

  const activas = citas.filter((c) => {
    const estado = (c.estado || "").toLowerCase();
    return c.telefono && !estado.includes("cancel");
  });

  const canceladas = citas.length - activas.length;

  console.log(`📊 Total citas encontradas: ${citas.length}`);
  console.log(`✅ Activas con teléfono:    ${activas.length}`);
  if (canceladas > 0) console.log(`🚫 Canceladas/sin teléfono: ${canceladas}`);
  console.log();

  activas.forEach((c, i) => {
    const telefono = extraerPrimerTelefono(c.telefono);
    const hora = formatearHora(c.hora, c.ampm);
    const primerNombre = (c.nombre || "").split(" ")[0];

    console.log(`─── Cita ${i + 1} ${"─".repeat(40)}`);
    console.log(`👤 Paciente:  ${c.nombre}`);
    console.log(`   (se enviará como: "${primerNombre}")`);
    console.log(`📱 Teléfono:  ${c.telefono}`);
    console.log(`   (formateado: ${telefono})`);
    console.log(`🕐 Hora:      ${hora}`);
    console.log(`👨‍⚕️ Médico:   ${c.medico}`);
    console.log(`🏥 Sede:      ${c.sede}`);
    console.log(`📋 Estado:    ${c.estado || "N/A"}`);
    console.log(`🔖 Tipo:      ${c.tipo || "CONSULTA"}`);
    console.log(`🏢 Entidad:   ${c.entidad || "PARTICULAR"}`);
  });

  console.log("\n" + "═".repeat(60));
  console.log(`✅ Consulta completada — ${activas.length} mensajes se enviarían`);
  console.log("═".repeat(60));
}

consultarAPI().catch((err) => console.error("❌ Error:", err.message));
