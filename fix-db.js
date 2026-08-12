import dotenv from 'dotenv';
dotenv.config();
import db from './src/config/db.js';

async function fix() {
  console.log('Starting fix...');
  try {
    // 1. Create default stock area if not exists
    let [areas] = await db.execute('SELECT id FROM stock_areas LIMIT 1');
    let stockAreaId;
    if (areas.length === 0) {
      // is_default does not exist
      const [res] = await db.execute('INSERT INTO stock_areas (name, address) VALUES (?, ?)', ['Main Godown', 'Default Address']);
      stockAreaId = res.insertId;
      console.log('Created Main Godown with ID:', stockAreaId);
    } else {
      stockAreaId = areas[0].id;
      console.log('Using existing Godown with ID:', stockAreaId);
    }

    // 2. Update existing trips and loads
    await db.execute('UPDATE purchase_trips SET stock_area_id = ? WHERE stock_area_id IS NULL', [stockAreaId]);
    await db.execute('UPDATE purchase_loads SET stock_area_id = ? WHERE stock_area_id IS NULL', [stockAreaId]);
    
    // 3. Find purchase loads that have NO stock_transactions
    const [loads] = await db.execute('SELECT pl.id, pl.created_by, pl.created_at, pl.status, pt.status as trip_status FROM purchase_loads pl LEFT JOIN purchase_trips pt ON pt.id = pl.trip_id');
    
    for (const load of loads) {
      const [txs] = await db.execute('SELECT id FROM stock_transactions WHERE type = "PURCHASE" AND reference_id = ?', [load.id]);
      if (txs.length === 0) {
        console.log('Fixing load', load.id);
        const isApproved = load.trip_status === 'APPROVED' ? 1 : load.trip_status === 'WAITING_APPROVAL' ? 2 : 0;
        
        const [items] = await db.execute('SELECT product_id, quantity FROM purchase_load_items WHERE load_id = ?', [load.id]);
        for (const item of items) {
           await db.execute('INSERT INTO stock_transactions (product_id, stock_area_id, type, quantity, isApproved, reference_id, created_by, stock_from, created_at) VALUES (?, ?, "PURCHASE", ?, ?, ?, ?, "depot", CURRENT_TIMESTAMP)', [item.product_id, stockAreaId, item.quantity, isApproved, load.id, load.created_by]);
        }
      }
    }
    console.log('Fix complete!');
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}

fix();
