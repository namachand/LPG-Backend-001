import xlsx from 'xlsx';
import fs from 'fs';
import FormData from 'form-data';

async function test() {
  try {
    // Create dummy excel
    const ws = xlsx.utils.json_to_sheet([
      { "Consumer ID": "1234567890123456", "Consumer Number": "CX123", "Consumer Name": "Test User", "Address": "123 Street", "Area Name": "Area" }
    ]);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
    xlsx.writeFile(wb, "test_dummy.xlsx");

    const form = new FormData();
    form.append('file', fs.createReadStream('test_dummy.xlsx'));

    const { default: fetch } = await import('node-fetch').catch(() => ({ default: null }));
    
    // We will just use native http if node-fetch is not available
    const http = await import('http');
    
    const request = http.request('http://localhost:5001/api/upload/bulk-customers', {
      method: 'POST',
      headers: form.getHeaders()
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => console.log('Response:', res.statusCode, data));
    });
    
    form.pipe(request);
  } catch(e) {
    console.error(e);
  }
}
test();
