import axios, { AxiosInstance } from "axios";
import logger from "../utils/logger";

/**
 * Servicio para conectarse a la API de UOLaser
 */
class ApiUOLaserService {
  private baseURL: string;
  private usuario: string;
  private contrasenia: string;
  private token: string | null = null;
  private axiosInstance: AxiosInstance;
  private readonly MAX_REINTENTOS_AUTH = 2;

  constructor() {
    this.baseURL = process.env.API_UOLASER_URL || "";
    this.usuario = process.env.API_UOLASER_USUARIO || "";
    this.contrasenia = process.env.API_UOLASER_CONTRASENIA || "";

    this.axiosInstance = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
      },
    });

    logger.info("🔌 Servicio API UOLaser inicializado");
  }

  /**
   * Autentica con la API y obtiene el token JWT
   */
  async autenticar(): Promise<boolean> {
    try {
      logger.info("🔐 Autenticando con API UOLaser...");

      const response = await this.axiosInstance.post(
        "/api/uolaser/authentication/login",
        {
          usuario: this.usuario,
          contrasenia: this.contrasenia,
        },
      );

      if (response.data.status === "Éxito" && response.data.data.token) {
        this.token = response.data.data.token;
        logger.info("✅ Autenticación exitosa");
        return true;
      }

      logger.error("❌ Error en autenticación:", response.data);
      return false;
    } catch (error: any) {
      logger.error("❌ Error al autenticar:", error.message);
      return false;
    }
  }

  /**
   * Obtiene la agenda de una fecha, médico y sede específicos
   */
  async obtenerAgenda(
    fecha: string,
    medico: string = "",
    sede: string = "",
    intentoAuth: number = 0,
  ): Promise<any> {
    try {
      // Autenticar si no hay token
      if (!this.token) {
        const autenticado = await this.autenticar();
        if (!autenticado) {
          throw new Error("No se pudo autenticar con la API");
        }
      }

      logger.debug(
        `📅 Obteniendo agenda para ${fecha} - Médico: ${medico || "TODOS"} - Sede: ${sede || "TODAS"}`,
      );

      const response = await this.axiosInstance.post(
        "/api/uolaser/services/agenda/obtener",
        {
          fecha,
          medico,
          sede,
        },
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
        },
      );

      if (response.data.status === "OK") {
        logger.info(`✅ Agenda obtenida: ${response.data.data.length} citas`);
        return response.data;
      }

      // Sin resultados para esa combinación — es normal, no es un error
      logger.debug(`Sin agenda: ${medico} - ${sede} - ${fecha}`);
      return null;
    } catch (error: any) {
      // Si el token expiró, re-autenticar una sola vez
      if (error.response?.status === 401 && intentoAuth < this.MAX_REINTENTOS_AUTH) {
        logger.warn(`⚠️ Token expirado, re-autenticando (intento ${intentoAuth + 1}/${this.MAX_REINTENTOS_AUTH})...`);
        this.token = null;
        return this.obtenerAgenda(fecha, medico, sede, intentoAuth + 1);
      }

      if (error.response?.status === 401) {
        logger.error("❌ No se pudo re-autenticar después de varios intentos");
      } else {
        logger.error("❌ Error al obtener agenda:", error.message);
      }
      return null;
    }
  }

  /**
   * Obtiene las agendas de todas las sedes y todos los médicos para una fecha
   */
  async obtenerAgendasTodasSedes(fecha: string): Promise<any[]> {
    const sedes = ["PEREIRA", "DOSQUEBRADAS"];

    // Obtener lista de médicos del .env
    const medicosEnv = process.env.API_UOLASER_MEDICOS || "";
    const medicos = medicosEnv
      .split(";")
      .map((m) => m.trim())
      .filter((m) => m);

    if (medicos.length === 0) {
      logger.warn("⚠️ No hay médicos configurados en API_UOLASER_MEDICOS");
      return [];
    }

    logger.info(`👨‍⚕️ Médicos configurados: ${medicos.length}`);

    // Autenticar una sola vez antes de las llamadas paralelas
    if (!this.token) {
      const autenticado = await this.autenticar();
      if (!autenticado) {
        logger.error("❌ No se pudo autenticar antes de consultar agendas");
        return [];
      }
    }

    // Construir todas las combinaciones sede + médico
    const combinaciones = sedes.flatMap((sede) =>
      medicos.map((medico) => ({ sede, medico })),
    );

    // Consultar todas las combinaciones en paralelo (el token ya está listo)
    const resultados = await Promise.all(
      combinaciones.map(({ sede, medico }) =>
        this.obtenerAgenda(fecha, medico, sede),
      ),
    );

    const agendas: any[] = [];

    resultados.forEach((agenda, i) => {
      const { sede, medico } = combinaciones[i];
      if (agenda && agenda.data && agenda.data.length > 0) {
        agendas.push(...agenda.data);
        logger.info(`  ✅ ${sede} - ${medico}: ${agenda.data.length} cita(s)`);
      }
    });

    logger.info(
      `📊 Total de citas en todas las sedes: ${agendas.length} para ${fecha}`,
    );
    return agendas;
  }
}

export default new ApiUOLaserService();
