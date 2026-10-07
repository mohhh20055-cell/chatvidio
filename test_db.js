const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

async function test() {
  try {
    const config = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
    // wait this project might not use firebase-applet-config for supabase
  } catch (e) {
    console.log(e.message);
  }
}
test();
