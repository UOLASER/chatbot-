import googleSheetsService from "./src/services/google-sheets.service";

async function probarSheets() {
  console.log("📊 Probando integración con Google Sheets...\n");

  await googleSheetsService.registrarMensaje({
    paciente: "Juan (PRUEBA)",
    telefono: "+573216779467",
    medico: "CRISANTO DE JESUS MORENO",
    sede: "PEREIRA",
    fechaCita: "2026-05-17",
    horaCita: "10:00 AM",
    estado: "sent",
    metaMessageId: "wamid.TEST123456789",
  });

  console.log("✅ Listo — revisa la hoja de Google Sheets");
}

probarSheets();
