const fs = require('fs');
const file = 'src/controllers/cashierController.js';
let content = fs.readFileSync(file, 'utf8');

const dateBlock = `    const DATE_ONLY = /^\\d{4}-\\d{2}-\\d{2}$/;
    let startDate = DATE_ONLY.test(String(req.query.startDate || '')) ? String(req.query.startDate) : null;
    let endDate = DATE_ONLY.test(String(req.query.endDate || '')) ? String(req.query.endDate) : null;
    if (startDate && !endDate) endDate = startDate;
    if (endDate && !startDate) startDate = endDate;
    if (startDate && endDate && startDate > endDate) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
    const hasRange = Boolean(startDate && endDate);`;

function fixFunction(fnName, tableAlias) {
  const startIdx = content.indexOf(`export const ${fnName} =`);
  if (startIdx === -1) {
    console.log('Could not find', fnName);
    return;
  }
  const tryIdx = content.indexOf('try {', startIdx);
  const queryIdx = content.indexOf('const [', tryIdx);
  
  const blockStart = tryIdx + 5;
  const originalBlock = content.substring(blockStart, queryIdx);
  const lines = originalBlock.split('\n');
  const newLines = [];
  let skipping = false;
  for(let i=0; i<lines.length; i++) {
     let line = lines[i];
     if (line.includes('const DATE_ONLY') || line.includes('let startDate') || line.includes('let endDate') || 
         line.includes('if (startDate') || line.includes('if (endDate') || line.includes('const tmp') || 
         line.includes('startDate =') || line.includes('endDate =') || line.includes('const hasRange') ||
         line.includes('const dateClause') || line.includes('const queryParams')) {
        skipping = true;
        continue;
     }
     if (skipping && line.trim() === '}') {
        skipping = false;
        continue;
     }
     skipping = false;
     newLines.push(line);
  }
  
  let dateClauseStr = '';
  if (fnName === 'getTodayOfficeSales') {
      dateClauseStr = `\n    const dateClause = hasRange ? 'AND DATE(${tableAlias}.created_at) BETWEEN ? AND ?' : 'AND DATE(${tableAlias}.created_at) = CURDATE()';\n    const queryParams = hasRange ? [startDate, endDate] : [];\n`;
  } else {
      dateClauseStr = `\n    const dateClause = hasRange ? 'AND DATE(${tableAlias}.created_at) BETWEEN ? AND ?' : '';\n    const queryParams = hasRange ? [startDate, endDate] : [];\n`;
  }
  
  const finalBlock = '\n' + dateBlock + dateClauseStr + newLines.join('\n');
  content = content.substring(0, blockStart) + finalBlock + content.substring(queryIdx);

  const newStartIdx = content.indexOf(`export const ${fnName} =`);
  const qStart = content.indexOf('const [', newStartIdx);
  const qEnd = content.indexOf(');', qStart);
  let queryCall = content.substring(qStart, qEnd + 2);
  
  if (!queryCall.includes('queryParams')) {
      queryCall = queryCall.replace(/\)\s*;/g, ', queryParams);');
  }
  
  if (!queryCall.includes('${dateClause}')) {
      if (queryCall.includes('${whereClause}')) {
          queryCall = queryCall.replace('${whereClause}', '${whereClause}\n      ${dateClause}');
      } else if (queryCall.includes('GROUP BY')) {
          queryCall = queryCall.replace('GROUP BY', '${dateClause}\n      GROUP BY');
      } else if (queryCall.includes('ORDER BY')) {
          queryCall = queryCall.replace('ORDER BY', '${dateClause}\n      ORDER BY');
      }
  }

  content = content.substring(0, qStart) + queryCall + content.substring(qEnd + 2);
  console.log('Fixed', fnName);
}

fixFunction('getTodayOfficeSales', 's');
fixFunction('getCashierPenaltyRequests', 'p');
fixFunction('getCashierNameChangeRequests', 'r');
fixFunction('getCashierTransferVoucherRequests', 't');
fixFunction('getCashOutExpenseRequests', 'e');
fixFunction('getCashierNewConnectionRequests', 'cnc');

const driverFn = 'getCashierDriverCollections';
const driverStart = content.indexOf(`export const ${driverFn}`);
if (driverStart !== -1) {
  const tryIdx = content.indexOf('try {', driverStart);
  const queryIdx = content.indexOf('const [', tryIdx);
  const originalBlock = content.substring(tryIdx + 5, queryIdx);
  
  const lines = originalBlock.split('\n');
  const newLines = [];
  let skipping = false;
  for(let i=0; i<lines.length; i++) {
     let line = lines[i];
     if (line.includes('const DATE_ONLY') || line.includes('let startDate') || line.includes('let endDate') || 
         line.includes('if (startDate') || line.includes('if (endDate') || line.includes('const tmp') || 
         line.includes('startDate =') || line.includes('endDate =') || line.includes('const hasRange') ||
         line.includes('const dateClause') || line.includes('const queryParams') || line.includes('joinCondition') || line.includes('queryParams.push')) {
        skipping = true;
        continue;
     }
     if (skipping && line.trim() === '}') {
        skipping = false;
        continue;
     }
     skipping = false;
     newLines.push(line);
  }

  const customBlock = `\n${dateBlock}

    let joinCondition = "sh.driver_id = d.id AND sh.status IN ('ASSIGNED', 'PENDING', 'SETTLED')";
    const queryParams = [];
    if (hasRange) {
      joinCondition += " AND DATE(sh.created_at) BETWEEN ? AND ?";
      queryParams.push(startDate, endDate);
    }
    queryParams.push(limit, offset);\n`;

  const finalBlock = newLines.join('\n') + customBlock;
  content = content.substring(0, tryIdx + 5) + finalBlock + content.substring(queryIdx);

  const newStartIdx = content.indexOf(`export const ${driverFn} =`);
  const qStart = content.indexOf('const [', newStartIdx);
  const qEnd = content.indexOf(');', qStart);
  let queryCall = content.substring(qStart, qEnd + 2);

  if (!queryCall.includes('queryParams')) {
      queryCall = queryCall.replace(/\)\s*;/g, ', queryParams);');
  }
  
  if (queryCall.includes("LEFT JOIN settlement_history sh ON sh.driver_id = d.id AND sh.status IN ('ASSIGNED', 'PENDING', 'SETTLED')")) {
    queryCall = queryCall.replace("LEFT JOIN settlement_history sh ON sh.driver_id = d.id AND sh.status IN ('ASSIGNED', 'PENDING', 'SETTLED')", "LEFT JOIN settlement_history sh ON ${joinCondition}");
  }

  content = content.substring(0, qStart) + queryCall + content.substring(qEnd + 2);
  console.log('Fixed', driverFn);
}

fs.writeFileSync(file, content);
console.log('Done fixing dates');
