// Corre una vez por dia via GitHub Actions. Guarda en la nube (tabla estado_backups)
// una copia fechada del estado de cada usuario, independiente de su dispositivo, y
// borra las copias de mas de 30 dias para que la tabla no crezca sin limite.
import { fetchAllEstados, insertBackupSnapshot, pruneBackupsOlderThan } from './lib/supabaseAdmin.js';

const RETENCION_DIAS = 30;

async function main(){
  const rows = await fetchAllEstados();

  let guardados = 0;
  for(const row of rows){
    if(!row.data) continue;
    try{
      await insertBackupSnapshot(row.user_id, row.data);
      guardados++;
    }catch(err){
      console.error(`No se pudo guardar snapshot de ${row.user_id}:`, err.message);
    }
  }

  await pruneBackupsOlderThan(RETENCION_DIAS);

  console.log(`Snapshots guardados: ${guardados} de ${rows.length} usuario(s). Poda de copias de mas de ${RETENCION_DIAS} dias aplicada.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
