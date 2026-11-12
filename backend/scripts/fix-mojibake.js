// ═══════════════════════════════════════════════════════════════════════════════
// KamiTales — reparar textos con doble codificación ("Cap├¡tulo" → "Capítulo")
//
// Algunos textos se guardaron como UTF-8 leído en la consola de Windows (CP437)
// y vuelto a guardar. Este script recorre todas las columnas de texto, array de
// texto y JSON del esquema público, deshace esa conversión y solo acepta el
// resultado si es UTF-8 válido y distinto del original.
//
//   node scripts/fix-mojibake.js           → prueba en seco: enseña qué cambiaría
//   node scripts/fix-mojibake.js --apply   → guarda una copia en backups/ y aplica
//                                            los cambios en una sola transacción
// ═══════════════════════════════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();
const { pool } = require('../db');

const APPLY = process.argv.includes('--apply');

// CP437, bytes 0x80–0xFF
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const BYTE = new Map([...CP437].map((ch, i) => [ch, 0x80 + i]));
const SUSPECT = /[├┬┼└┴╝╗║═╚╔]/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

// Repara cada tramo de caracteres no ASCII por separado: así un texto que mezcla
// partes bien escritas ("Capítulo 2") y dañadas ("Cap├¡tulo 1") solo cambia en las dañadas.
function repairRun(run) {
  const bytes = [];
  for (const ch of run) { if (!BYTE.has(ch)) return null; bytes.push(BYTE.get(ch)); }
  try { const out = utf8.decode(Uint8Array.from(bytes)); return SUSPECT.test(out) ? null : out; } catch { return null; }
}
function repair(s) {
  if (typeof s !== 'string' || !SUSPECT.test(s)) return null;
  let bad = false;
  const out = s.replace(/[^\x00-\x7f]+/g, run => {
    if (!SUSPECT.test(run)) return run;
    const fixed = repairRun(run);
    if (fixed == null) { bad = true; return run; }
    return fixed;
  });
  return !bad && out !== s ? out : null;
}

(async () => {
  const cols = (await pool.query(`
    SELECT c.table_name, c.column_name, c.data_type, c.udt_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
      AND (c.data_type IN ('text', 'character varying', 'jsonb', 'json') OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar')))
    ORDER BY c.table_name, c.column_name`)).rows;

  const changes = [];
  for (const c of cols) {
    const cast = c.data_type === 'ARRAY' ? c.udt_name.slice(1) + '[]' : c.data_type === 'character varying' ? 'varchar' : c.data_type;
    let rows;
    try {
      rows = (await pool.query(`SELECT ctid::text AS ctid, "${c.column_name}"::text AS v FROM "${c.table_name}" WHERE "${c.column_name}"::text ~ '[├┬┼└┴╝╗║═╚╔]'`)).rows;
    } catch (e) { console.warn('Omitida', c.table_name + '.' + c.column_name + ':', e.message.slice(0, 80)); continue; }
    for (const r of rows) {
      const fixed = repair(r.v);
      if (fixed == null) { console.log('· Sin reparar (no es doble codificación):', c.table_name + '.' + c.column_name, JSON.stringify(r.v.slice(0, 80))); continue; }
      changes.push({ table: c.table_name, column: c.column_name, cast, ctid: r.ctid, before: r.v, after: fixed });
    }
  }

  if (!changes.length) { console.log('No hay textos que reparar.'); return pool.end(); }
  for (const ch of changes) {
    console.log(`\n${ch.table}.${ch.column}`);
    console.log('  antes: ' + ch.before.slice(0, 160));
    console.log('  después: ' + ch.after.slice(0, 160));
  }
  console.log(`\n${changes.length} ${changes.length === 1 ? 'valor' : 'valores'} para reparar.`);
  if (!APPLY) { console.log('Prueba en seco: no se ha cambiado nada. Para aplicar: node scripts/fix-mojibake.js --apply'); return pool.end(); }

  const dir = path.join(process.cwd(), 'backups'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mojibake-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify(changes, null, 2));
  console.log('Copia de los valores originales:', file);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const ch of changes) {
      const r = await client.query(`UPDATE "${ch.table}" SET "${ch.column}" = $1::${ch.cast} WHERE ctid = $2::tid AND "${ch.column}"::text = $3`, [ch.after, ch.ctid, ch.before]);
      if (r.rowCount !== 1) throw new Error(`${ch.table}.${ch.column}: la fila cambió mientras tanto (${r.rowCount} filas)`);
    }
    await client.query('COMMIT');
    console.log('Aplicado:', changes.length, 'valores reparados.');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('No se ha cambiado nada:', e.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
})().catch(e => { console.error(e); process.exit(1); });
