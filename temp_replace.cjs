const fs = require('fs');
const path = require('path');

function walkDir(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(function(file) {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            results = results.concat(walkDir(file));
        } else {
            if (file.endsWith('.js')) {
                results.push(file);
            }
        }
    });
    return results;
}

const dirPath = 'c:/Users/Lokes/Desktop/projects/LPG/LPG-Backend-001/src/controllers';
const files = walkDir(dirPath);

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    let original = content;

    content = content.replace(/CONCAT\('LPG-', LPAD\(u\.id, 5, '0'\)\) AS consumer_number/g, 'u.consumer_number AS consumer_number');
    content = content.replace(/CONCAT\('LPG-', LPAD\(cu\.id, 5, '0'\)\) AS consumer_number/g, 'cu.consumer_number AS consumer_number');
    content = content.replace(/CONCAT\('LPG-', LPAD\(r\.customer_id, 5, '0'\)\) AS consumer_number/g, 'u.consumer_number AS consumer_number');
    content = content.replace(/CONCAT\('LPG-', LPAD\(t\.existing_customer_id, 5, '0'\)\) AS consumer_number/g, 'old_u.consumer_number AS consumer_number');
    content = content.replace(/CONCAT\('LPG-', LPAD\(cnc\.user_id, 5, '0'\)\) AS consumer_number/g, 'u.consumer_number AS consumer_number');
    content = content.replace(/OR CONCAT\('LPG-', LPAD\(u\.id, 5, '0'\)\) LIKE \?/g, 'OR u.consumer_number LIKE ?');
    content = content.replace(/CONCAT\('LPG-', LPAD\(id, 5, '0'\)\) AS consumer_number/g, 'consumer_number AS consumer_number');

    if (content !== original) {
        fs.writeFileSync(file, content);
        console.log('Modified:', file);
    }
});
