// ═══════════════════════════════════════════════════════════════════════════════
// KamiTales — tareas periódicas de pagos
//
// Cada seis horas (y un minuto después de arrancar):
//   · reparte Premium de los meses terminados que falten (cada mes, una vez);
//   · comprueba que monedas, ventas y repartos cuadran, y avisa en el registro
//     si algo no lo hace.
// Sin la migración de ingresos no hace nada.
// ═══════════════════════════════════════════════════════════════════════════════
const earnings = require('./earnings');

let last = null;   // resultado de la última conciliación, para el panel de administración
async function run() {
  try {
    if (!(await earnings.ready())) return;
    const done = await earnings.distributePending();
    done.forEach((r) => console.log(`[pagos] Premium de ${r.period.slice(0, 7)} repartido: ${(r.distributed / 1e6).toFixed(2)} € entre ${r.works.length} obras (${r.subscribers} suscriptores)`));
    last = await earnings.reconcile();
    if (!last.ok) console.error('[pagos] ¡LA CONCILIACIÓN NO CUADRA!', JSON.stringify(last.problems).slice(0, 2000));
  } catch (e) {
    console.error('[pagos] tareas periódicas:', e.message);
  }
}

function start() {
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 3600_000).unref();
}

module.exports = { start, run, lastReconcile: () => last };
