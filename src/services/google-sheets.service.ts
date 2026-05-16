import axios from "axios";
import logger from "../utils/logger";

class GoogleSheetsService {
  private appsScriptUrl: string;
  private enabled: boolean;

  constructor() {
    this.appsScriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL || "";
    this.enabled = !!this.appsScriptUrl;

    if (this.enabled) {
      logger.info("📊 Google Sheets (Apps Script) configurado correctamente");
    } else {
      logger.warn("⚠️  Google Sheets no configurado (falta GOOGLE_APPS_SCRIPT_URL en .env)");
    }
  }

  async registrarMensaje(datos: {
    paciente: string;
    telefono: string;
    medico: string;
    sede: string;
    fechaCita: string;
    horaCita: string;
    estado: "sent" | "failed";
    metaMessageId?: string;
    error?: string;
  }): Promise<void> {
    if (!this.enabled) return;

    try {
      const ahora = new Date().toLocaleString("es-CO", {
        timeZone: "America/Bogota",
        dateStyle: "short",
        timeStyle: "short",
      });

      await axios.post(this.appsScriptUrl, {
        fechaEnvio: ahora,
        paciente: datos.paciente,
        telefono: datos.telefono,
        medico: datos.medico,
        sede: datos.sede,
        fechaCita: datos.fechaCita,
        horaCita: datos.horaCita,
        estado: datos.estado === "sent" ? "✅ Enviado" : "❌ Fallido",
        metaMessageId: datos.metaMessageId || "",
        error: datos.error || "",
      });

      logger.info(`📊 Registrado en Google Sheets: ${datos.paciente} (${datos.estado})`);
    } catch (error: any) {
      logger.error("❌ Error al registrar en Google Sheets:", error.message);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export default new GoogleSheetsService();
