const fs = require('fs');
let c = fs.readFileSync('c:\\Users\\Lokes\\Desktop\\projects\\LPG\\LPG-Backend-001\\apply_split_payments.js', 'utf8');
c = c.replace(/\\`/g, '`');
c = c.replace(/\\\$/g, '$');
c = c.replace(/\\\\/g, '\\');
fs.writeFileSync('c:\\Users\\Lokes\\Desktop\\projects\\LPG\\LPG-Backend-001\\apply_split_payments.js', c);
console.log('Unescape complete');
